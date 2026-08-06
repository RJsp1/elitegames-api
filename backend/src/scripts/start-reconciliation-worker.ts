import { loadEnv, resetEnvCache } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  sicrediReconciliationService,
  summarizeReconciliationResults,
} from '../services/sicredi/sicredi-reconciliation.service.js';
import { paymentExpirationService } from '../services/payment/payment-expiration.service.js';
import {
  writeReconciliationHeartbeat,
} from '../utils/reconciliation-heartbeat.js';
import { pixLog } from '../utils/observability.js';

let shuttingDown = false;
let timer: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;
let workerStartedAt = new Date().toISOString();

export async function runOnce(intervalMs: number, batchSize?: number): Promise<void> {
  const startedAt = Date.now();
  const cycleStartedAt = new Date().toISOString();
  const env = loadEnv();
  const resolvedBatchSize = batchSize ?? env.PAYMENT_RECONCILIATION_BATCH_SIZE;

  writeReconciliationHeartbeat({
    startedAt: workerStartedAt,
    lastCycleStartedAt: cycleStartedAt,
    isRunning: true,
    enabled: true,
    intervalMs,
    consecutiveFailures,
  });

  try {
    const results = await sicrediReconciliationService.runCycle();
    if (results === null) {
      writeReconciliationHeartbeat({
        isRunning: false,
        lastCycleFinishedAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
      });
      return;
    }

    const durationMs = Date.now() - startedAt;
    const metrics = sicrediReconciliationService.getLastCycleMetrics();
    const summary = summarizeReconciliationResults(results, durationMs, {
      ...metrics,
      pollingIntervalMs: intervalMs,
      batchSize: resolvedBatchSize,
    });

    if (summary.total > 0 && summary.errors === summary.total) {
      consecutiveFailures += 1;
    } else {
      consecutiveFailures = 0;
    }

    const finishedAt = new Date().toISOString();
    const success = summary.total === 0 || summary.errors < summary.total;
    writeReconciliationHeartbeat({
      lastCycleFinishedAt: finishedAt,
      ...(success ? { lastSuccessfulCycleAt: finishedAt } : {}),
      lastCycleDurationMs: durationMs,
      lastCycleTotal: summary.total,
      lastCycleErrors: summary.errors,
      consecutiveFailures,
      isRunning: false,
      nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
      intervalMs,
      enabled: true,
    });

    pixLog('info', 'Ciclo de conciliação concluído', {
      operation: 'reconciliation_cycle',
      provider: 'sicredi',
      durationMs: summary.durationMs,
      total: summary.total,
      confirmed: summary.confirmed,
      pending: summary.pending,
      cancelled: summary.cancelled,
      errors: summary.errors,
      mismatches: summary.mismatches,
      queried: summary.queried,
      skipped: summary.skipped,
      tokenRefreshes: summary.tokenRefreshes,
      averageQueryMs: summary.averageQueryMs,
      maxQueryMs: summary.maxQueryMs,
      minQueryMs: summary.minQueryMs,
      pollingIntervalMs: summary.pollingIntervalMs,
      batchSize: summary.batchSize,
    });

    // Expiração integrada após reconciliação (sem worker PM2 extra).
    if (env.PAYMENT_EXPIRATION_ENABLED) {
      try {
        await paymentExpirationService.runCycle({
          intervalMs: env.PAYMENT_EXPIRATION_INTERVAL_MS,
        });
      } catch (expireErr) {
        pixLog('error', 'Falha no ciclo de expiração pós-reconciliação', {
          operation: 'payment_expiration_cycle',
          provider: 'sicredi',
          errorMessage:
            expireErr instanceof Error ? expireErr.message.slice(0, 300) : 'unknown',
          errorCode: 'unknown_error',
        });
      }
    }
  } catch (err) {
    consecutiveFailures += 1;
    writeReconciliationHeartbeat({
      lastCycleFinishedAt: new Date().toISOString(),
      lastCycleDurationMs: Date.now() - startedAt,
      lastCycleErrors: 1,
      consecutiveFailures,
      isRunning: false,
      nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
      intervalMs,
      enabled: true,
    });
    throw err;
  }
}

/** Agenda o próximo ciclo. O timer mantém ref no event loop (não usar unref). */
export function scheduleNext(intervalMs: number): void {
  if (shuttingDown) return;
  timer = setTimeout(() => {
    void (async () => {
      try {
        await runOnce(intervalMs);
      } catch (err) {
        pixLog('error', 'Falha no worker de conciliação', {
          operation: 'reconciliation_cycle',
          provider: 'sicredi',
          errorMessage: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
          errorCode: 'unknown_error',
        });
      } finally {
        scheduleNext(intervalMs);
      }
    })();
  }, intervalMs);
}

export function getReconciliationWorkerTimer(): NodeJS.Timeout | null {
  return timer;
}

export function resetReconciliationWorkerState(): void {
  shuttingDown = false;
  consecutiveFailures = 0;
  workerStartedAt = new Date().toISOString();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Worker de conciliação encerrando (${signal})`);
  writeReconciliationHeartbeat({
    isRunning: false,
    nextRunAt: null,
  });
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  process.exitCode = 0;
}

export async function runReconciliationWorker(): Promise<void> {
  resetEnvCache();
  const env = loadEnv();

  if (!env.PAYMENT_RECONCILIATION_ENABLED) {
    logger.error('Worker exige PAYMENT_RECONCILIATION_ENABLED=true');
    process.exitCode = 1;
    return;
  }

  if (!env.isSicredi) {
    logger.error('Worker de conciliação exige PAYMENT_PROVIDER=sicredi');
    process.exitCode = 1;
    return;
  }

  const intervalMs = env.PAYMENT_RECONCILIATION_INTERVAL_MS;
  workerStartedAt = new Date().toISOString();
  consecutiveFailures = 0;

  writeReconciliationHeartbeat({
    startedAt: workerStartedAt,
    enabled: true,
    isRunning: false,
    intervalMs,
    consecutiveFailures: 0,
    lastCycleTotal: 0,
    lastCycleErrors: 0,
    nextRunAt: new Date().toISOString(),
  });

  logger.info('Worker de conciliação iniciado', {
    intervalMs,
    batchSize: env.PAYMENT_RECONCILIATION_BATCH_SIZE,
    concurrency: env.PAYMENT_RECONCILIATION_CONCURRENCY,
    expirationEnabled: env.PAYMENT_EXPIRATION_ENABLED,
    operation: 'reconciliation_cycle',
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await runOnce(intervalMs);
  } catch (err) {
    logger.error('Falha no ciclo inicial de conciliação', {
      message: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
      operation: 'reconciliation_cycle',
    });
  }

  if (!shuttingDown) {
    scheduleNext(intervalMs);
  }
}
