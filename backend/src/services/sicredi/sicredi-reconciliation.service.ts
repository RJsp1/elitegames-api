import { getEnv } from '../../config/env.js';
import { paymentRepository } from '../../repositories/payment.repository.js';
import { auditLogRepository } from '../../repositories/audit-log.repository.js';
import type { PaymentRecord, ProviderChargeStatus } from '../../types/payment.types.js';
import { nowIso } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import { pixAmountToCents, toCents } from '../../utils/money.js';
import { redactSensitiveData } from '../../utils/redact-sensitive-data.js';
import { sicrediChargeService } from './sicredi-charge.service.js';

export type SicrediCobClassification = 'paid' | 'active' | 'cancelled' | 'unknown';

export type ReconciliationAction =
  | 'confirmed'
  | 'unchanged'
  | 'cancelled'
  | 'amount_mismatch'
  | 'skipped_unknown'
  | 'idempotent'
  | 'error';

export interface ReconciliationResult {
  paymentId: string;
  txid: string;
  previousStatus: string;
  currentStatus: string;
  matched: boolean;
  action: ReconciliationAction;
  message?: string;
}

export interface ReconciliationCycleSummary {
  total: number;
  confirmed: number;
  pending: number;
  cancelled: number;
  errors: number;
  mismatches: number;
  durationMs: number;
}

/**
 * Classifica o status bruto da cobrança Sicredi/Bacen para o polling.
 */
export function classifySicrediCobStatus(rawStatus: string | undefined | null): SicrediCobClassification {
  const normalized = (rawStatus ?? '').trim().toUpperCase();

  switch (normalized) {
    case 'CONCLUIDA':
    case 'CONCLUIDA_PIX':
      return 'paid';
    case 'ATIVA':
    case 'ACTIVE':
      return 'active';
    case 'REMOVIDA_PELO_USUARIO_RECEBEDOR':
    case 'REMOVIDA_PELO_PSP':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

export function summarizeReconciliationResults(
  results: ReconciliationResult[],
  durationMs: number,
): ReconciliationCycleSummary {
  return {
    total: results.length,
    confirmed: results.filter((r) => r.action === 'confirmed').length,
    pending: results.filter((r) => r.action === 'unchanged').length,
    cancelled: results.filter((r) => r.action === 'cancelled').length,
    errors: results.filter((r) => r.action === 'error').length,
    mismatches: results.filter((r) => r.action === 'amount_mismatch').length,
    durationMs,
  };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function resolveReceivedAmount(remote: ProviderChargeStatus): string {
  return remote.receivedAmount ?? remote.amountOriginal;
}

export class SicrediReconciliationService {
  private cycleRunning = false;

  isCycleRunning(): boolean {
    return this.cycleRunning;
  }

  /** Uso em testes — libera trava de ciclo. */
  resetCycleLock(): void {
    this.cycleRunning = false;
  }

  /**
   * Executa um ciclo com trava anti-sobreposição.
   * Retorna null quando um ciclo já está em andamento.
   */
  async runCycle(options?: {
    limit?: number;
    concurrency?: number;
  }): Promise<ReconciliationResult[] | null> {
    if (this.cycleRunning) {
      logger.warn('Ciclo de conciliação sobreposto bloqueado');
      return null;
    }

    this.cycleRunning = true;
    try {
      const env = getEnv();
      const limit = options?.limit ?? env.PAYMENT_RECONCILIATION_BATCH_SIZE;
      const concurrency = options?.concurrency ?? env.PAYMENT_RECONCILIATION_CONCURRENCY;
      return await this.reconcilePending(limit, concurrency);
    } finally {
      this.cycleRunning = false;
    }
  }

  async reconcilePayment(paymentId: string): Promise<ReconciliationResult> {
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) {
      throw new Error('Pagamento não encontrado');
    }
    if (!payment.txid) {
      throw new Error('Pagamento sem txid');
    }

    if (payment.status === 'paid') {
      return {
        paymentId: payment.id,
        txid: payment.txid,
        previousStatus: 'paid',
        currentStatus: 'paid',
        matched: true,
        action: 'idempotent',
        message: 'Pagamento já liquidado',
      };
    }

    const remote = await sicrediChargeService.getCharge(payment.txid);
    return this.applyRemoteStatus(payment, remote);
  }

  async applyRemoteStatus(
    payment: PaymentRecord,
    remote: ProviderChargeStatus,
  ): Promise<ReconciliationResult> {
    const previousStatus = payment.status;
    const classification = classifySicrediCobStatus(remote.sicrediStatus ?? remote.status);

    if (classification === 'unknown') {
      logger.warn('Status Sicredi não mapeado na conciliação', {
        paymentId: payment.id,
        txid: payment.txid ?? undefined,
        sicrediStatus: remote.sicrediStatus ?? remote.status,
      });
      return {
        paymentId: payment.id,
        txid: payment.txid ?? '',
        previousStatus,
        currentStatus: previousStatus,
        matched: false,
        action: 'skipped_unknown',
        message: `Status remoto não tratado: ${remote.sicrediStatus ?? remote.status}`,
      };
    }

    if (classification === 'active') {
      // ATIVA sem mudança local: sem auditoria repetitiva.
      return {
        paymentId: payment.id,
        txid: payment.txid ?? '',
        previousStatus,
        currentStatus: previousStatus,
        matched: true,
        action: 'unchanged',
      };
    }

    if (classification === 'cancelled') {
      const updated = await paymentRepository.updatePaymentStatus(payment.id, 'cancelled');
      const charge = await paymentRepository.findCurrentChargeByPaymentId(payment.id);
      if (charge) {
        await paymentRepository.updateChargeStatus(charge.id, 'cancelled', {
          rawResponse: (redactSensitiveData(remote.raw ?? {}) as Record<string, unknown>) ?? null,
        });
      }
      await this.writeTransitionAudit(payment.id, previousStatus, updated.status, 'cancelled');
      logger.info('Pagamento cancelado via conciliação', {
        paymentId: payment.id,
        txid: payment.txid ?? undefined,
      });
      return {
        paymentId: payment.id,
        txid: payment.txid ?? '',
        previousStatus,
        currentStatus: updated.status,
        matched: true,
        action: 'cancelled',
      };
    }

    // CONCLUIDA → paid (com checagem de valor em centavos)
    const received = resolveReceivedAmount(remote);
    let expectedCents: number;
    let receivedCents: number;
    try {
      expectedCents = toCents(Number(payment.totalAmount));
      receivedCents = pixAmountToCents(received);
    } catch (err) {
      logger.warn('Falha ao comparar valores na conciliação', {
        paymentId: payment.id,
        message: err instanceof Error ? err.message : 'unknown',
      });
      return {
        paymentId: payment.id,
        txid: payment.txid ?? '',
        previousStatus,
        currentStatus: previousStatus,
        matched: false,
        action: 'amount_mismatch',
        message: 'Valor remoto inválido',
      };
    }

    if (expectedCents !== receivedCents) {
      logger.warn('Divergência de valor na conciliação — pagamento não confirmado', {
        paymentId: payment.id,
        txid: payment.txid ?? undefined,
        expectedCents,
        receivedCents,
      });
      return {
        paymentId: payment.id,
        txid: payment.txid ?? '',
        previousStatus,
        currentStatus: previousStatus,
        matched: false,
        action: 'amount_mismatch',
        message: `Valor divergente: esperado ${expectedCents} centavos, recebido ${receivedCents}`,
      };
    }

    const charge = await paymentRepository.findCurrentChargeByPaymentId(payment.id);
    const paidAt = remote.paidAt ?? nowIso();
    const endToEndId =
      remote.endToEndId ?? payment.endToEndId ?? `RECON${payment.id.replace(/-/g, '').slice(0, 28)}`;

    if (charge && payment.registrationId) {
      const event = await paymentRepository.createPaymentEvent({
        paymentId: payment.id,
        providerId: payment.providerId,
        eventType: 'payment_reconciled_paid',
        externalEventId: `recon:${endToEndId}`,
        payload: redactSensitiveData(remote.raw ?? remote),
        processed: false,
      });

      try {
        await paymentRepository.confirmPaidAtomically({
          paymentId: payment.id,
          chargeId: charge.id,
          registrationId: payment.registrationId,
          endToEndId,
          paidAt,
          eventId: event.id,
          chargeRawResponse:
            (redactSensitiveData(remote.raw ?? {}) as Record<string, unknown>) ?? undefined,
        });
      } catch (err) {
        // Financeiro pode ter liquidado mesmo se um passo posterior falhou.
        const refreshed = await paymentRepository.findPaymentById(payment.id);
        if (refreshed?.status === 'paid' && previousStatus !== 'paid') {
          await this.writeTransitionAudit(payment.id, previousStatus, 'paid', 'confirmed');
          return {
            paymentId: payment.id,
            txid: payment.txid ?? '',
            previousStatus,
            currentStatus: 'paid',
            matched: true,
            action: 'confirmed',
            message: err instanceof Error ? err.message.slice(0, 200) : 'confirmed_with_followup_error',
          };
        }
        if (refreshed?.status === 'paid') {
          return {
            paymentId: payment.id,
            txid: payment.txid ?? '',
            previousStatus,
            currentStatus: 'paid',
            matched: true,
            action: 'idempotent',
            message: err instanceof Error ? err.message : 'already_paid',
          };
        }
        throw err;
      }
    } else {
      await paymentRepository.updatePaymentStatus(payment.id, 'paid', {
        endToEndId,
        paidAt,
      });
      if (charge) {
        await paymentRepository.updateChargeStatus(charge.id, 'paid', {
          rawResponse: (redactSensitiveData(remote.raw ?? {}) as Record<string, unknown>) ?? null,
        });
      }
      if (payment.registrationId) {
        await paymentRepository.confirmRegistration(payment.registrationId);
        await paymentRepository.confirmReservation(payment.id, payment.registrationId);
      }
    }

    await this.writeTransitionAudit(payment.id, previousStatus, 'paid', 'confirmed');

    logger.info('Pagamento confirmado via conciliação', {
      paymentId: payment.id,
      txid: payment.txid ?? undefined,
      previousStatus,
      currentStatus: 'paid',
    });

    return {
      paymentId: payment.id,
      txid: payment.txid ?? '',
      previousStatus,
      currentStatus: 'paid',
      matched: true,
      action: 'confirmed',
    };
  }

  async reconcilePending(
    limit = 50,
    concurrency = 5,
  ): Promise<ReconciliationResult[]> {
    const pending = await paymentRepository.listReconcilableSicrediPayments(limit);

    const results = await mapWithConcurrency(pending, concurrency, async (payment) => {
      try {
        return await this.reconcilePayment(payment.id);
      } catch (err) {
        logger.warn('Falha ao conciliar pagamento', {
          paymentId: payment.id,
          message: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
        });
        return {
          paymentId: payment.id,
          txid: payment.txid ?? '',
          previousStatus: payment.status,
          currentStatus: payment.status,
          matched: false,
          action: 'error' as const,
          message: err instanceof Error ? err.message : 'unknown',
        };
      }
    });

    return results;
  }

  /**
   * Auditoria somente em transições relevantes (paid/cancelled).
   * Falha de auditoria nunca propaga para o fluxo financeiro.
   */
  private async writeTransitionAudit(
    paymentId: string,
    previousStatus: string,
    currentStatus: string,
    outcome: 'confirmed' | 'cancelled',
  ): Promise<void> {
    try {
      await auditLogRepository.write({
        action: 'PAYMENT_RECONCILED',
        entityType: 'payment',
        entityId: paymentId,
        before: { status: previousStatus },
        after: { status: currentStatus },
        reason: outcome,
        metadata: { previousStatus, currentStatus, outcome },
      });
    } catch (auditError) {
      const message =
        auditError instanceof Error
          ? auditError.message.slice(0, 300)
          : 'unknown_audit_error';
      logger.warn('Falha ao gravar audit log', {
        message,
        action: 'PAYMENT_RECONCILED',
        entityId: paymentId,
      });
    }
  }
}

export const sicrediReconciliationService = new SicrediReconciliationService();
