import { getEnv } from '../../config/env.js';
import { paymentRepository } from '../../repositories/payment.repository.js';
import { financialAuditService } from '../audit/financial-audit.service.js';
import { paymentService } from '../payment/payment.service.js';
import { paymentExpirationService } from '../payment/payment-expiration.service.js';
import { sicrediReconciliationService } from '../sicredi/sicredi-reconciliation.service.js';
import { AppError } from '../../utils/app-error.js';
import { maskTxid } from '../../utils/redact-sensitive-data.js';

const actionLocks = new Set<string>();

function withActionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (actionLocks.has(key)) {
    throw AppError.conflict('Ação administrativa já em andamento', 'ADMIN_ACTION_IN_PROGRESS');
  }
  actionLocks.add(key);
  return fn().finally(() => {
    actionLocks.delete(key);
  });
}

export class AdminPaymentActionsService {
  async reissue(paymentId: string, reason?: string): Promise<Record<string, unknown>> {
    return withActionLock(`reissue:${paymentId}`, async () => {
      const payment = await paymentRepository.findPaymentById(paymentId);
      if (!payment) throw AppError.notFound('Pagamento não encontrado');
      if (payment.status === 'paid') {
        throw AppError.badRequest('Pagamento pago não pode ser reemitido', 'PAYMENT_ALREADY_PAID');
      }
      if (!payment.registrationId) {
        throw AppError.badRequest('Pagamento sem registration_id', 'MISSING_REGISTRATION');
      }

      const result = await paymentService.reissuePixPayment({
        registrationId: payment.registrationId,
        paymentId: payment.id,
        reason: reason ?? 'admin_manual',
      });

      return {
        action: 'reissue',
        paymentId: result.paymentId,
        chargeId: result.chargeId,
        txidMasked: result.txid ? maskTxid(result.txid) : null,
        status: result.status,
        amount: result.amount,
        expiresAt: result.expiresAt,
        // Pix Copia e Cola permitido ao admin autenticado, nunca logado integralmente.
        pixCopiaECola: result.pixCopiaECola,
      };
    });
  }

  async reconcile(paymentId: string): Promise<Record<string, unknown>> {
    return withActionLock(`reconcile:${paymentId}`, async () => {
      const payment = await paymentRepository.findPaymentById(paymentId);
      if (!payment) throw AppError.notFound('Pagamento não encontrado');
      if (payment.status === 'paid') {
        return {
          action: 'reconcile',
          paymentId,
          status: 'paid',
          message: 'already_paid',
          idempotent: true,
        };
      }

      const env = getEnv();
      if (env.isSicredi) {
        const result = await sicrediReconciliationService.reconcilePayment(paymentId);
        const updated = await paymentRepository.findPaymentById(paymentId);
        return {
          action: 'reconcile',
          paymentId,
          status: updated?.status ?? result.currentStatus,
          reconciliationAction: result.action,
          message: result.message ?? null,
        };
      }

      const refreshed = await paymentService.reconcilePayment(paymentId);
      return {
        action: 'reconcile',
        paymentId: refreshed.paymentId,
        status: refreshed.status,
        amount: refreshed.amount,
        expiresAt: refreshed.expiresAt,
      };
    });
  }

  async expire(paymentId: string, reason?: string): Promise<Record<string, unknown>> {
    return withActionLock(`expire:${paymentId}`, async () => {
      const payment = await paymentRepository.findPaymentById(paymentId);
      if (!payment) throw AppError.notFound('Pagamento não encontrado');
      if (payment.status === 'paid') {
        throw AppError.badRequest('Pagamento pago não pode ser expirado', 'PAYMENT_ALREADY_PAID');
      }
      if (payment.status === 'expired') {
        return {
          action: 'expire',
          paymentId,
          status: 'expired',
          idempotent: true,
        };
      }
      if (payment.status !== 'active' && payment.status !== 'pending') {
        throw AppError.badRequest(
          `Expiração manual só para active/pending (atual: ${payment.status})`,
          'INVALID_STATUS',
        );
      }

      const charge =
        (await paymentRepository.findCurrentChargeByPaymentId(paymentId)) ??
        (await paymentRepository.listChargesByPaymentId(paymentId))[0];
      if (!charge) throw AppError.notFound('Cobrança não encontrada');

      const result = await paymentExpirationService.applyLocalExpiration({
        payment,
        charge,
      });

      // Auditoria adicional explícita com origem admin (idempotente por charge).
      if (result.action === 'expired') {
        await financialAuditService.paymentStatusChanged({
          paymentId,
          previousStatus: payment.status,
          newStatus: 'expired',
          reason: 'admin_manual',
        });
        await financialAuditService.pixChargeExpired({
          chargeId: charge.id,
          previousStatus: charge.status,
          previousIsCurrent: charge.isCurrent,
          expiresAt: charge.expiresAt,
          reason: 'admin_manual',
        });
      }

      const updated = await paymentRepository.findPaymentById(paymentId);
      return {
        action: 'expire',
        paymentId,
        status: updated?.status ?? 'expired',
        result: result.action,
        reason: reason ?? 'admin_manual',
      };
    });
  }

  async cancel(paymentId: string, reason?: string): Promise<Record<string, unknown>> {
    return withActionLock(`cancel:${paymentId}`, async () => {
      const payment = await paymentRepository.findPaymentById(paymentId);
      if (!payment) throw AppError.notFound('Pagamento não encontrado');
      if (payment.status === 'paid') {
        throw AppError.badRequest('Pagamento pago não pode ser cancelado', 'PAYMENT_ALREADY_PAID');
      }
      if (payment.status === 'cancelled') {
        return {
          action: 'cancel',
          paymentId,
          status: 'cancelled',
          idempotent: true,
        };
      }

      const charge =
        (await paymentRepository.findCurrentChargeByPaymentId(paymentId)) ??
        (await paymentRepository.listChargesByPaymentId(paymentId))[0];
      if (!charge) throw AppError.notFound('Cobrança não encontrada');

      const result = await paymentExpirationService.applyLocalCancellation({
        payment,
        charge,
      });

      if (result.action === 'cancelled') {
        await financialAuditService.paymentStatusChanged({
          paymentId,
          previousStatus: payment.status,
          newStatus: 'cancelled',
          reason: 'admin_manual',
        });
        await financialAuditService.pixChargeCancelled({
          chargeId: charge.id,
          previousStatus: charge.status,
          newStatus: 'cancelled',
          reason: 'admin_manual',
        });
      }

      const updated = await paymentRepository.findPaymentById(paymentId);
      return {
        action: 'cancel',
        paymentId,
        status: updated?.status ?? 'cancelled',
        result: result.action,
        reason: reason ?? 'admin_manual',
        historyPreserved: true,
      };
    });
  }
}

export const adminPaymentActionsService = new AdminPaymentActionsService();
