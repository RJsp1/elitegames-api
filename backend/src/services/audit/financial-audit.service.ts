import {
  auditLogRepository,
  buildMismatchIdempotencyKey,
  type FinancialAuditOrigin,
  type WriteFinancialEventResult,
} from '../../repositories/audit-log.repository.js';
import { maskEndToEndId, maskTxid } from '../../utils/redact-sensitive-data.js';

/**
 * Fachada de auditoria do ciclo Pix.
 * Sempre após persistência financeira; nunca lança.
 */
export class FinancialAuditService {
  paymentCreated(input: {
    paymentId: string;
    status: string;
    amount: number;
    provider: string;
    registrationId: string | null;
  }): Promise<WriteFinancialEventResult> {
    return auditLogRepository.writeFinancialEvent({
      action: 'PAYMENT_CREATED',
      entityTable: 'payments',
      entityId: input.paymentId,
      after: {
        status: input.status,
        amount: input.amount,
        provider: input.provider,
        registration_id: input.registrationId,
      },
      reason: 'payment_create',
      idempotencyKey: `created:${input.paymentId}`,
    });
  }

  pixChargeCreated(input: {
    chargeId: string;
    paymentId: string;
    txid: string;
    status: string;
    amount: number;
    expiresAt: string | null;
    isCurrent: boolean;
    reason?: FinancialAuditOrigin;
  }): Promise<WriteFinancialEventResult> {
    return auditLogRepository.writeFinancialEvent({
      action: 'PIX_CHARGE_CREATED',
      entityTable: 'payment_charges',
      entityId: input.chargeId,
      after: {
        payment_id: input.paymentId,
        txid: maskTxid(input.txid),
        status: input.status,
        amount: input.amount,
        expires_at: input.expiresAt,
        is_current: input.isCurrent,
      },
      reason: input.reason ?? 'payment_create',
      idempotencyKey: `charge:${input.chargeId}`,
    });
  }

  paymentStatusChanged(input: {
    paymentId: string;
    previousStatus: string;
    newStatus: string;
    paidAt?: string | null;
    endToEndId?: string | null;
    reason: FinancialAuditOrigin;
  }): Promise<WriteFinancialEventResult> {
    if (input.previousStatus === input.newStatus) {
      return Promise.resolve({ ok: true, duplicated: true, record: null });
    }
    return auditLogRepository.writeFinancialEvent({
      action: 'PAYMENT_STATUS_CHANGED',
      entityTable: 'payments',
      entityId: input.paymentId,
      before: { status: input.previousStatus },
      after: {
        status: input.newStatus,
        paid_at: input.paidAt ?? null,
        end_to_end_id: input.endToEndId ? maskEndToEndId(input.endToEndId) : null,
      },
      reason: input.reason,
      // Mudanças de status podem se repetir em direções diferentes; chave por transição.
      idempotencyKey: `status:${input.previousStatus}->${input.newStatus}:${input.reason}`,
    });
  }

  paymentReconciled(input: {
    paymentId: string;
    previousPaymentStatus: string;
    previousChargeStatus: string | null;
    paidAt: string | null;
    endToEndId: string | null;
    amountReceived: string | number;
    reason: 'polling_sicredi' | 'webhook_sicredi' | 'admin_manual';
  }): Promise<WriteFinancialEventResult> {
    return auditLogRepository.writeFinancialEvent({
      action: 'PAYMENT_RECONCILED',
      entityTable: 'payments',
      entityId: input.paymentId,
      before: {
        payment_status: input.previousPaymentStatus,
        charge_status: input.previousChargeStatus,
      },
      after: {
        status: 'paid',
        paid_at: input.paidAt,
        end_to_end_id: input.endToEndId ? maskEndToEndId(input.endToEndId) : null,
        sicredi_status: 'CONCLUIDA',
        amount_received: input.amountReceived,
      },
      reason: input.reason,
      idempotencyKey: 'reconciled',
    });
  }

  paymentAmountMismatch(input: {
    paymentId: string;
    expectedCents: number;
    receivedCents: number;
    txid?: string | null;
    reason: FinancialAuditOrigin;
  }): Promise<WriteFinancialEventResult> {
    const idempotencyKey = buildMismatchIdempotencyKey({
      expectedCents: input.expectedCents,
      receivedCents: input.receivedCents,
      txid: input.txid,
    });
    return auditLogRepository.writeFinancialEvent({
      action: 'PAYMENT_AMOUNT_MISMATCH',
      entityTable: 'payments',
      entityId: input.paymentId,
      before: { expected_cents: input.expectedCents },
      after: {
        received_cents: input.receivedCents,
        txid: input.txid ? maskTxid(input.txid) : null,
      },
      reason: input.reason,
      idempotencyKey,
    });
  }

  pixChargeCancelled(input: {
    chargeId: string;
    previousStatus: string;
    newStatus?: string;
    reason: FinancialAuditOrigin;
  }): Promise<WriteFinancialEventResult> {
    return auditLogRepository.writeFinancialEvent({
      action: 'PIX_CHARGE_CANCELLED',
      entityTable: 'payment_charges',
      entityId: input.chargeId,
      before: { status: input.previousStatus },
      after: { status: input.newStatus ?? 'cancelled' },
      reason: input.reason,
      idempotencyKey: 'cancelled',
    });
  }

  pixChargeExpired(input: {
    chargeId: string;
    previousStatus: string;
    previousIsCurrent?: boolean;
    expiresAt?: string | null;
    reason?: FinancialAuditOrigin;
  }): Promise<WriteFinancialEventResult> {
    const reason = input.reason ?? 'expiration_worker';
    return auditLogRepository.writeFinancialEvent({
      action: 'PIX_CHARGE_EXPIRED',
      entityTable: 'payment_charges',
      entityId: input.chargeId,
      before: {
        status: input.previousStatus,
        is_current: input.previousIsCurrent ?? true,
        expires_at: input.expiresAt ?? null,
      },
      after: { status: 'expired', is_current: false },
      reason,
      idempotencyKey: 'expired',
    });
  }

  registrationStatusChanged(input: {
    registrationId: string;
    previousStatus: string;
    newStatus: string;
    paymentId?: string | null;
    reason: FinancialAuditOrigin;
  }): Promise<WriteFinancialEventResult> {
    if (input.previousStatus === input.newStatus) {
      return Promise.resolve({ ok: true, duplicated: true, record: null });
    }
    return auditLogRepository.writeFinancialEvent({
      action: 'REGISTRATION_STATUS_CHANGED',
      entityTable: 'registrations',
      entityId: input.registrationId,
      before: { status: input.previousStatus },
      after: {
        status: input.newStatus,
        payment_id: input.paymentId ?? null,
      },
      reason: input.reason,
      idempotencyKey: `reg:${input.previousStatus}->${input.newStatus}:${input.reason}`,
    });
  }
}

export const financialAuditService = new FinancialAuditService();
