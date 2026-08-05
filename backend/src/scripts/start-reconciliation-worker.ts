import { loadEnv, resetEnvCache } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  sicrediReconciliationService,
  summarizeReconciliationResults,
} from '../services/sicredi/sicredi-reconciliation.service.js';

let shuttingDown = false;
let timer: NodeJS.Timeout | null = null;

export async function runOnce(): Promise<void> {
  const startedAt = Date.now();
  const results = await sicrediReconciliationService.runCycle();
  if (results === null) {
    return;
  }

  const summary = summarizeReconciliationResults(results, Date.now() - startedAt);
  logger.info('Ciclo de conciliação concluído', { ...summary });
}

/** Agenda o próximo ciclo. O timer mantém ref no event loop (não usar unref). */
export function scheduleNext(intervalMs: number): void {
  if (shuttingDown) return;
  timer = setTimeout(() => {
    void (async () => {
      try {
        await runOnce();
      } catch (err) {
        logger.error('Falha no worker de conciliação', {
          message: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
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
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Worker de conciliação encerrando (${signal})`);
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

  logger.info('Worker de conciliação iniciado', {
    intervalMs,
    batchSize: env.PAYMENT_RECONCILIATION_BATCH_SIZE,
    concurrency: env.PAYMENT_RECONCILIATION_CONCURRENCY,
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await runOnce();
  } catch (err) {
    logger.error('Falha no ciclo inicial de conciliação', {
      message: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
    });
  }

  if (!shuttingDown) {
    scheduleNext(intervalMs);
  }
}
