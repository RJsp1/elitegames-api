/**
 * Entrypoint tsx: worker de conciliação Pix Sicredi por polling.
 * Produção: node dist/scripts/start-reconciliation-worker.js
 */
import { runReconciliationWorker } from '../src/scripts/start-reconciliation-worker.js';

void runReconciliationWorker().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
