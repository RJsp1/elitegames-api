import { paymentRepository } from '../repositories/payment.repository.js';
import { logger } from '../utils/logger.js';

const INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;

export async function expirePaymentsOnce(): Promise<number> {
  const expired = await paymentRepository.findExpiredActivePayments();
  for (const payment of expired) {
    await paymentRepository.expirePaymentBundle(payment);
    logger.info('Pagamento expirado', {
      paymentId: payment.id,
      txid: payment.txid ?? undefined,
    });
  }
  return expired.length;
}

export function startExpirePaymentsJob(): void {
  if (timer) return;
  timer = setInterval(() => {
    expirePaymentsOnce().catch((err) => {
      logger.error('Falha no job expire-payments', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    });
  }, INTERVAL_MS);
  timer.unref?.();
}

export function stopExpirePaymentsJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
