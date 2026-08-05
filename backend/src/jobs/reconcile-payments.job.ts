import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

const INTERVAL_MS = 5 * 60_000;
let timer: NodeJS.Timeout | null = null;

export function startReconcilePaymentsJob(): void {
  const env = getEnv();
  if (!env.isSicredi) return;
  if (timer) return;

  timer = setInterval(() => {
    void (async () => {
      try {
        const { sicrediReconciliationService } = await import(
          '../services/sicredi/sicredi-reconciliation.service.js'
        );
        const results = await sicrediReconciliationService.reconcilePending(20);
        if (results.length > 0) {
          logger.info('Job de conciliação executado', { count: results.length });
        }
      } catch (err) {
        logger.error('Falha no job reconcile-payments', {
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    })();
  }, INTERVAL_MS);

  timer.unref?.();
}

export function stopReconcilePaymentsJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
