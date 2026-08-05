import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

let timer: NodeJS.Timeout | null = null;

/**
 * Job embutido no processo da API (opcional).
 * Em produção preferir o worker PM2 dedicado (PAYMENT_RECONCILIATION_ENABLED).
 */
export function startReconcilePaymentsJob(): void {
  const env = getEnv();
  if (!env.isSicredi) return;
  if (!env.PAYMENT_RECONCILIATION_ENABLED) return;
  if (timer) return;

  const intervalMs = env.PAYMENT_RECONCILIATION_INTERVAL_MS;

  const tick = (): void => {
    void (async () => {
      try {
        const { sicrediReconciliationService } = await import(
          '../services/sicredi/sicredi-reconciliation.service.js'
        );
        const results = await sicrediReconciliationService.runCycle();
        if (results && results.length > 0) {
          logger.info('Job de conciliação executado', { count: results.length });
        }
      } catch (err) {
        logger.error('Falha no job reconcile-payments', {
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    })();
  };

  // Não executa imediatamente no boot da API — o worker dedicado faz isso.
  timer = setInterval(tick, intervalMs);
  timer.unref?.();

  logger.info('Job de conciliação agendado na API', { intervalMs });
}

export function stopReconcilePaymentsJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
