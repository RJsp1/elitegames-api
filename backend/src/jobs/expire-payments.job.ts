import { paymentRepository } from '../repositories/payment.repository.js';
import { financialAuditService } from '../services/audit/financial-audit.service.js';
import { logger } from '../utils/logger.js';

const INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;

export async function expirePaymentsOnce(): Promise<number> {
  const expired = await paymentRepository.findExpiredActivePayments();
  for (const payment of expired) {
    const previousStatus = payment.status;
    const charge = await paymentRepository.findCurrentChargeByPaymentId(payment.id);
    const previousChargeStatus = charge?.status ?? null;
    const registration = payment.registrationId
      ? await paymentRepository.findRegistrationById(payment.registrationId)
      : null;
    const previousRegistrationStatus = registration?.status ?? null;

    await paymentRepository.expirePaymentBundle(payment);

    await financialAuditService.paymentStatusChanged({
      paymentId: payment.id,
      previousStatus,
      newStatus: 'expired',
      reason: 'expiration_worker',
    });

    if (charge) {
      await financialAuditService.pixChargeExpired({
        chargeId: charge.id,
        previousStatus: previousChargeStatus ?? charge.status,
      });
    }

    if (payment.registrationId && previousRegistrationStatus) {
      const updatedRegistration = await paymentRepository.findRegistrationById(
        payment.registrationId,
      );
      if (
        updatedRegistration &&
        updatedRegistration.status !== previousRegistrationStatus
      ) {
        await financialAuditService.registrationStatusChanged({
          registrationId: payment.registrationId,
          previousStatus: previousRegistrationStatus,
          newStatus: updatedRegistration.status,
          paymentId: payment.id,
          reason: 'expiration_worker',
        });
      }
    }

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
