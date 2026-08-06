import { getEnv } from '../../config/env.js';
import { paymentRepository } from '../../repositories/payment.repository.js';
import { financialAuditService } from '../audit/financial-audit.service.js';
import type { PaymentRecord, ProviderChargeStatus } from '../../types/payment.types.js';
import { nowIso } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import { pixAmountToCents, toCents } from '../../utils/money.js';
import { redactSensitiveData } from '../../utils/redact-sensitive-data.js';
import {
  classifyPixError,
  paymentCorrelationId,
  pixLog,
} from '../../utils/observability.js';
import { sicrediChargeService } from './sicredi-charge.service.js';
import { sicrediTokenCache } from './sicredi-token-cache.js';

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
  queryDurationMs?: number;
}

export interface ReconciliationCycleMetrics {
  queried: number;
  skipped: number;
  tokenRefreshes: number;
  queryDurationsMs: number[];
}

export interface ReconciliationCycleSummary {
  total: number;
  confirmed: number;
  pending: number;
  cancelled: number;
  errors: number;
  mismatches: number;
  durationMs: number;
  queried: number;
  skipped: number;
  tokenRefreshes: number;
  averageQueryMs: number | null;
  maxQueryMs: number | null;
  minQueryMs: number | null;
}

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
  metrics?: Partial<ReconciliationCycleMetrics>,
): ReconciliationCycleSummary {
  const queryDurationsMs = metrics?.queryDurationsMs ?? [];
  const queried = metrics?.queried ?? queryDurationsMs.length;
  const skipped =
    metrics?.skipped ??
    results.filter(
      (r) =>
        r.action === 'unchanged' ||
        r.action === 'idempotent' ||
        r.action === 'skipped_unknown',
    ).length;

  return {
    total: results.length,
    confirmed: results.filter((r) => r.action === 'confirmed').length,
    pending: results.filter((r) => r.action === 'unchanged').length,
    cancelled: results.filter((r) => r.action === 'cancelled').length,
    errors: results.filter((r) => r.action === 'error').length,
    mismatches: results.filter((r) => r.action === 'amount_mismatch').length,
    durationMs,
    queried,
    skipped,
    tokenRefreshes: metrics?.tokenRefreshes ?? 0,
    averageQueryMs:
      queryDurationsMs.length > 0
        ? Math.round(
            queryDurationsMs.reduce((sum, value) => sum + value, 0) / queryDurationsMs.length,
          )
        : null,
    maxQueryMs: queryDurationsMs.length > 0 ? Math.max(...queryDurationsMs) : null,
    minQueryMs: queryDurationsMs.length > 0 ? Math.min(...queryDurationsMs) : null,
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

async function auditPaidConfirmation(input: {
  payment: PaymentRecord;
  previousStatus: string;
  previousChargeStatus: string | null;
  paidAt: string;
  endToEndId: string;
  amountReceived: string;
  registrationPreviousStatus?: string | null;
}): Promise<void> {
  await financialAuditService.paymentStatusChanged({
    paymentId: input.payment.id,
    previousStatus: input.previousStatus,
    newStatus: 'paid',
    paidAt: input.paidAt,
    endToEndId: input.endToEndId,
    reason: 'polling_sicredi',
  });

  await financialAuditService.paymentReconciled({
    paymentId: input.payment.id,
    previousPaymentStatus: input.previousStatus,
    previousChargeStatus: input.previousChargeStatus,
    paidAt: input.paidAt,
    endToEndId: input.endToEndId,
    amountReceived: input.amountReceived,
    reason: 'polling_sicredi',
  });

  if (input.payment.registrationId && input.registrationPreviousStatus) {
    await financialAuditService.registrationStatusChanged({
      registrationId: input.payment.registrationId,
      previousStatus: input.registrationPreviousStatus,
      newStatus: 'paid',
      paymentId: input.payment.id,
      reason: 'polling_sicredi',
    });
  }
}

export class SicrediReconciliationService {
  private cycleRunning = false;
  private lastCycleMetrics: ReconciliationCycleMetrics = {
    queried: 0,
    skipped: 0,
    tokenRefreshes: 0,
    queryDurationsMs: [],
  };

  isCycleRunning(): boolean {
    return this.cycleRunning;
  }

  resetCycleLock(): void {
    this.cycleRunning = false;
  }

  getLastCycleMetrics(): ReconciliationCycleMetrics {
    return { ...this.lastCycleMetrics, queryDurationsMs: [...this.lastCycleMetrics.queryDurationsMs] };
  }

  async runCycle(options?: {
    limit?: number;
    concurrency?: number;
  }): Promise<ReconciliationResult[] | null> {
    if (this.cycleRunning) {
      logger.warn('Ciclo de conciliação sobreposto bloqueado');
      return null;
    }

    this.cycleRunning = true;
    const tokenBefore = sicrediTokenCache.getRefreshCount();
    const queryDurationsMs: number[] = [];
    try {
      const env = getEnv();
      const limit = options?.limit ?? env.PAYMENT_RECONCILIATION_BATCH_SIZE;
      const concurrency = options?.concurrency ?? env.PAYMENT_RECONCILIATION_CONCURRENCY;
      const results = await this.reconcilePending(limit, concurrency, queryDurationsMs);
      this.lastCycleMetrics = {
        queried: queryDurationsMs.length,
        skipped: results.filter(
          (r) =>
            r.action === 'unchanged' ||
            r.action === 'idempotent' ||
            r.action === 'skipped_unknown',
        ).length,
        tokenRefreshes: Math.max(0, sicrediTokenCache.getRefreshCount() - tokenBefore),
        queryDurationsMs,
      };
      return results;
    } finally {
      this.cycleRunning = false;
    }
  }

  async reconcilePayment(
    paymentId: string,
    queryDurationsMs?: number[],
  ): Promise<ReconciliationResult> {
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) {
      throw new Error('Pagamento não encontrado');
    }
    if (!payment.txid) {
      throw new Error('Pagamento sem txid');
    }

    const correlationId = paymentCorrelationId(payment.id);

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

    const remote = await sicrediChargeService.getCharge(payment.txid, {
      correlationId,
      paymentId: payment.id,
      attempt: 1,
    });
    if (typeof remote.queryDurationMs === 'number') {
      queryDurationsMs?.push(remote.queryDurationMs);
    }

    return this.applyRemoteStatus(payment, remote, remote.queryDurationMs);
  }

  async applyRemoteStatus(
    payment: PaymentRecord,
    remote: ProviderChargeStatus,
    queryDurationMs?: number,
  ): Promise<ReconciliationResult> {
    const previousStatus = payment.status;
    const correlationId = paymentCorrelationId(payment.id);
    const chargeBefore = await paymentRepository.findCurrentChargeByPaymentId(payment.id);
    const previousChargeStatus = chargeBefore?.status ?? null;
    const classification = classifySicrediCobStatus(remote.sicrediStatus ?? remote.status);

    if (classification === 'unknown') {
      pixLog('warn', 'Status Sicredi não mapeado na conciliação', {
        correlationId,
        paymentId: payment.id,
        registrationId: payment.registrationId,
        txid: payment.txid,
        provider: 'sicredi',
        operation: 'reconciliation_payment',
        statusLocal: previousStatus,
        statusRemote: remote.sicrediStatus ?? remote.status,
        attempt: 1,
        durationMs: queryDurationMs,
      });
      return {
        paymentId: payment.id,
        txid: payment.txid ?? '',
        previousStatus,
        currentStatus: previousStatus,
        matched: false,
        action: 'skipped_unknown',
        message: `Status remoto não tratado: ${remote.sicrediStatus ?? remote.status}`,
        queryDurationMs,
      };
    }

    if (classification === 'active') {
      pixLog('debug', 'Cobrança Sicredi ainda ATIVA', {
        correlationId,
        paymentId: payment.id,
        registrationId: payment.registrationId,
        txid: payment.txid,
        provider: 'sicredi',
        operation: 'reconciliation_payment',
        statusLocal: previousStatus,
        statusRemote: remote.sicrediStatus ?? 'ATIVA',
        attempt: 1,
        durationMs: queryDurationMs,
      });
      return {
        paymentId: payment.id,
        txid: payment.txid ?? '',
        previousStatus,
        currentStatus: previousStatus,
        matched: true,
        action: 'unchanged',
        queryDurationMs,
      };
    }

    if (classification === 'cancelled') {
      const updated = await paymentRepository.updatePaymentStatus(payment.id, 'cancelled');
      const charge = await paymentRepository.findCurrentChargeByPaymentId(payment.id);
      if (charge) {
        await paymentRepository.updateChargeStatus(charge.id, 'cancelled', {
          rawResponse: (redactSensitiveData(remote.raw ?? {}) as Record<string, unknown>) ?? null,
        });
        await financialAuditService.pixChargeCancelled({
          chargeId: charge.id,
          previousStatus: previousChargeStatus ?? charge.status,
          newStatus: 'cancelled',
          reason: 'polling_sicredi',
        });
      }
      await financialAuditService.paymentStatusChanged({
        paymentId: payment.id,
        previousStatus,
        newStatus: updated.status,
        reason: 'polling_sicredi',
      });
      pixLog('warn', 'Pagamento cancelado via conciliação', {
        correlationId,
        paymentId: payment.id,
        registrationId: payment.registrationId,
        chargeId: charge?.id,
        txid: payment.txid,
        provider: 'sicredi',
        operation: 'reconciliation_payment',
        statusLocal: updated.status,
        statusRemote: remote.sicrediStatus,
        attempt: 1,
        durationMs: queryDurationMs,
      });
      return {
        paymentId: payment.id,
        txid: payment.txid ?? '',
        previousStatus,
        currentStatus: updated.status,
        matched: true,
        action: 'cancelled',
        queryDurationMs,
      };
    }

    const received = resolveReceivedAmount(remote);
    let expectedCents: number;
    let receivedCents: number;
    try {
      expectedCents = toCents(Number(payment.totalAmount));
      receivedCents = pixAmountToCents(received);
    } catch (err) {
      pixLog('warn', 'Falha ao comparar valores na conciliação', {
        correlationId,
        paymentId: payment.id,
        txid: payment.txid,
        provider: 'sicredi',
        operation: 'reconciliation_payment',
        statusLocal: previousStatus,
        errorCode: 'amount_mismatch',
        errorMessage: err instanceof Error ? err.message : 'unknown',
        attempt: 1,
      });
      return {
        paymentId: payment.id,
        txid: payment.txid ?? '',
        previousStatus,
        currentStatus: previousStatus,
        matched: false,
        action: 'amount_mismatch',
        message: 'Valor remoto inválido',
        queryDurationMs,
      };
    }

    if (expectedCents !== receivedCents) {
      pixLog('error', 'Divergência de valor na conciliação — pagamento não confirmado', {
        correlationId,
        paymentId: payment.id,
        registrationId: payment.registrationId,
        txid: payment.txid,
        provider: 'sicredi',
        operation: 'reconciliation_payment',
        statusLocal: previousStatus,
        statusRemote: remote.sicrediStatus,
        errorCode: 'amount_mismatch',
        attempt: 1,
        durationMs: queryDurationMs,
        expectedCents,
        receivedCents,
      });
      await financialAuditService.paymentAmountMismatch({
        paymentId: payment.id,
        expectedCents,
        receivedCents,
        txid: payment.txid,
        reason: 'polling_sicredi',
      });
      return {
        paymentId: payment.id,
        txid: payment.txid ?? '',
        previousStatus,
        currentStatus: previousStatus,
        matched: false,
        action: 'amount_mismatch',
        message: `Valor divergente: esperado ${expectedCents} centavos, recebido ${receivedCents}`,
        queryDurationMs,
      };
    }

    const charge = chargeBefore;
    const paidAt = remote.paidAt ?? nowIso();
    const endToEndId =
      remote.endToEndId ?? payment.endToEndId ?? `RECON${payment.id.replace(/-/g, '').slice(0, 28)}`;
    const registration = payment.registrationId
      ? await paymentRepository.findRegistrationById(payment.registrationId)
      : null;
    const registrationPreviousStatus = registration?.status ?? null;
    const financialStartedAt = Date.now();

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
        const refreshed = await paymentRepository.findPaymentById(payment.id);
        if (refreshed?.status === 'paid' && previousStatus !== 'paid') {
          await auditPaidConfirmation({
            payment,
            previousStatus,
            previousChargeStatus,
            paidAt,
            endToEndId,
            amountReceived: received,
            registrationPreviousStatus,
          });
          pixLog('info', 'Pagamento confirmado via conciliação', {
            correlationId,
            paymentId: payment.id,
            registrationId: payment.registrationId,
            chargeId: charge.id,
            txid: payment.txid,
            provider: 'sicredi',
            operation: 'reconciliation_payment',
            statusLocal: 'paid',
            statusRemote: remote.sicrediStatus ?? 'CONCLUIDA',
            durationMs: queryDurationMs,
            attempt: 1,
          });
          return {
            paymentId: payment.id,
            txid: payment.txid ?? '',
            previousStatus,
            currentStatus: 'paid',
            matched: true,
            action: 'confirmed',
            message: err instanceof Error ? err.message.slice(0, 200) : 'confirmed_with_followup_error',
            queryDurationMs,
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
            queryDurationMs,
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

    const financialDurationMs = Date.now() - financialStartedAt;
    pixLog('debug', 'Atualização financeira concluída', {
      correlationId,
      paymentId: payment.id,
      operation: 'financial_update',
      durationMs: financialDurationMs,
      provider: 'sicredi',
    });

    await auditPaidConfirmation({
      payment,
      previousStatus,
      previousChargeStatus,
      paidAt,
      endToEndId,
      amountReceived: received,
      registrationPreviousStatus,
    });

    pixLog('info', 'Pagamento confirmado via conciliação', {
      correlationId,
      paymentId: payment.id,
      registrationId: payment.registrationId,
      chargeId: charge?.id,
      txid: payment.txid,
      provider: 'sicredi',
      operation: 'reconciliation_payment',
      statusLocal: 'paid',
      statusRemote: remote.sicrediStatus ?? 'CONCLUIDA',
      durationMs: queryDurationMs,
      attempt: 1,
    });

    return {
      paymentId: payment.id,
      txid: payment.txid ?? '',
      previousStatus,
      currentStatus: 'paid',
      matched: true,
      action: 'confirmed',
      queryDurationMs,
    };
  }

  async reconcilePending(
    limit = 50,
    concurrency = 5,
    queryDurationsMs: number[] = [],
  ): Promise<ReconciliationResult[]> {
    const pending = await paymentRepository.listReconcilableSicrediPayments(limit);

    return mapWithConcurrency(pending, concurrency, async (payment) => {
      try {
        return await this.reconcilePayment(payment.id, queryDurationsMs);
      } catch (err) {
        const errorCode = classifyPixError(err, { operation: 'reconciliation_payment' });
        pixLog('warn', 'Falha ao conciliar pagamento', {
          correlationId: paymentCorrelationId(payment.id),
          paymentId: payment.id,
          registrationId: payment.registrationId,
          txid: payment.txid,
          provider: 'sicredi',
          operation: 'reconciliation_payment',
          statusLocal: payment.status,
          errorCode,
          errorMessage: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
          attempt: 1,
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
  }
}

export const sicrediReconciliationService = new SicrediReconciliationService();
