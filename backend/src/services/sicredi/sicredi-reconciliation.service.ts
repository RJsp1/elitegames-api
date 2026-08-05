import { paymentRepository } from '../../repositories/payment.repository.js';
import { auditLogRepository } from '../../repositories/audit-log.repository.js';
import { logger } from '../../utils/logger.js';
import { sicrediChargeService } from './sicredi-charge.service.js';
import type { PaymentRecord } from '../../types/payment.types.js';
import { redactSensitiveData } from '../../utils/redact-sensitive-data.js';

export interface ReconciliationResult {
  paymentId: string;
  txid: string;
  previousStatus: string;
  currentStatus: string;
  matched: boolean;
}

export class SicrediReconciliationService {
  async reconcilePayment(paymentId: string): Promise<ReconciliationResult> {
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) {
      throw new Error('Pagamento não encontrado');
    }
    if (!payment.txid) {
      throw new Error('Pagamento sem txid');
    }

    const remote = await sicrediChargeService.getCharge(payment.txid);
    const previousStatus = payment.status;

    const updated = await paymentRepository.updatePaymentStatus(payment.id, remote.status, {
      endToEndId: remote.endToEndId ?? payment.endToEndId,
      paidAt: remote.paidAt ?? payment.paidAt,
    });

    const charge = await paymentRepository.findCurrentChargeByPaymentId(payment.id);
    if (charge) {
      await paymentRepository.updateChargeStatus(charge.id, remote.status, {
        rawResponse: (redactSensitiveData(remote.raw ?? {}) as Record<string, unknown>) ?? null,
      });
    }

    if (updated.status === 'paid' && payment.registrationId && charge) {
      await paymentRepository.confirmRegistration(payment.registrationId);
      await paymentRepository.confirmReservation(payment.id, payment.registrationId);
    }

    const matched = previousStatus === updated.status || remote.status === 'paid';

    try {
      await auditLogRepository.write({
        action: 'PAYMENT_RECONCILED',
        entityType: 'payment',
        entityId: payment.id,
        metadata: { previousStatus, currentStatus: updated.status, matched },
      });
    } catch (auditError) {
      logger.warn('Falha ao gravar audit log', {
        message:
          auditError instanceof Error
            ? auditError.message.slice(0, 300)
            : 'unknown_audit_error',
        paymentId: payment.id,
      });
    }

    logger.info('Conciliação concluída', {
      paymentId: payment.id,
      txid: payment.txid ?? undefined,
      previousStatus,
      currentStatus: updated.status,
    });

    return {
      paymentId: payment.id,
      txid: payment.txid ?? '',
      previousStatus,
      currentStatus: updated.status,
      matched,
    };
  }

  async reconcilePending(limit = 50): Promise<ReconciliationResult[]> {
    const pending = await paymentRepository.listPayments(limit);
    const toReconcile = pending.filter(
      (p: PaymentRecord) => p.status === 'pending' || p.status === 'active',
    );

    const results: ReconciliationResult[] = [];
    for (const payment of toReconcile) {
      try {
        results.push(await this.reconcilePayment(payment.id));
      } catch (err) {
        logger.warn('Falha ao conciliar pagamento', {
          paymentId: payment.id,
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    return results;
  }
}

export const sicrediReconciliationService = new SicrediReconciliationService();
