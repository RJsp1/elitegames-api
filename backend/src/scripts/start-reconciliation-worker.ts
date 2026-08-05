import { loadEnv, resetEnvCache } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sicrediReconciliationService } from '../services/sicredi/sicredi-reconciliation.service.js';

let shuttingDown = false;
let timer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  const results = await sicrediReconciliationService.runCycle();
  if (results === null) {
    return;
  }

  const confirmed = results.filter((r) => r.action === 'confirmed').length;
  const errors = results.filter((r) => r.action === 'error').length;
  const mismatches = results.filter((r) => r.action === 'amount_mismatch').length;

  logger.info('Ciclo de conciliação concluído', {
    total: results.length,
    confirmed,
    errors,
    mismatches,
  });
}

function scheduleNext(intervalMs: number): void {
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
  timer.unref?.();
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

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('start-reconciliation-worker.ts') ||
    process.argv[1].endsWith('start-reconciliation-worker.js'));

if (isDirectRun) {
  void runReconciliationWorker().catch((err) => {
    logger.error('Worker de conciliação abortado', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    process.exitCode = 1;
  });
}
