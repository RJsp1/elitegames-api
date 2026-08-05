import { logger } from '../utils/logger.js';
import { runReconciliationWorker } from './start-reconciliation-worker.js';

void runReconciliationWorker().catch((err) => {
  logger.error('Worker de conciliação abortado', {
    message: err instanceof Error ? err.message : 'unknown',
  });
  process.exitCode = 1;
});
