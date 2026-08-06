import { getEnv } from '../config/env.js';
import { paymentExpirationService } from '../services/payment/payment-expiration.service.js';
import { logger } from '../utils/logger.js';

let timer: NodeJS.Timeout | null = null;

/**
 * Executa um ciclo de expiração (com consulta remota antes de expirar).
 * Retorna a quantidade de cobranças expiradas localmente.
 */
export async function expirePaymentsOnce(): Promise<number> {
  const summary = await paymentExpirationService.runCycle();
  if (!summary) return 0;
  return summary.expired;
}

/**
 * Job periódico no processo da API.
 * Preferência de produção: integrar no worker de reconciliação
 * (start-reconciliation-worker) após cada ciclo — evita processo extra
 * e reutiliza cliente Sicredi / heartbeat. Este job permanece para
 * ambientes sem worker dedicado quando PAYMENT_EXPIRATION_ENABLED=true.
 */
export function startExpirePaymentsJob(): void {
  if (timer) return;
  const env = getEnv();
  if (!env.PAYMENT_EXPIRATION_ENABLED) {
    logger.info('Job de expiração desabilitado (PAYMENT_EXPIRATION_ENABLED=false)');
    return;
  }

  const intervalMs = env.PAYMENT_EXPIRATION_INTERVAL_MS;
  timer = setInterval(() => {
    expirePaymentsOnce().catch((err) => {
      logger.error('Falha no job expire-payments', {
        message: err instanceof Error ? err.message : 'unknown',
        operation: 'payment_expiration_cycle',
      });
    });
  }, intervalMs);
  // Mantém ref no event loop do processo API (sem unref).
}

export function stopExpirePaymentsJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
