import { getEnv } from '../../config/env.js';
import { paymentRepository } from '../../repositories/payment.repository.js';
import { financialAuditService } from '../audit/financial-audit.service.js';
import {
  classifySicrediCobStatus,
  mapWithConcurrency,
  sicrediReconciliationService,
} from '../sicredi/sicredi-reconciliation.service.js';
import { sicrediChargeService } from '../sicredi/sicredi-charge.service.js';
import { getPaymentProvider } from './payment-provider.factory.js';
import type { PaymentChargeRecord, PaymentRecord, ProviderChargeStatus } from '../../types/payment.types.js';
import { redactSensitiveData } from '../../utils/redact-sensitive-data.js';
import { nowIso } from '../../utils/date.js';
import {
  classifyPixError,
  measureDurationMs,
  paymentCorrelationId,
  pixLog,
} from '../../utils/observability.js';
import { logger } from '../../utils/logger.js';

export type ExpirationAction =
  | 'expired'
  | 'confirmed_before_expire'
  | 'cancelled'
  | 'skipped'
  | 'error';

export interface ExpirationItemResult {
  paymentId: string;
  chargeId: string;
  txid: string | null;
  action: ExpirationAction;
  message?: string;
  queryDurationMs?: number;
}

export interface ExpirationCycleSummary {
  operation: 'payment_expiration_cycle';
  provider: 'sicredi' | 'mock';
  durationMs: number;
  total: number;
  expired: number;
  confirmedBeforeExpire: number;
  cancelled: number;
  skipped: number;
  errors: number;
  queried: number;
  averageQueryMs: number;
  minQueryMs: number;
  maxQueryMs: number;
  batchSize: number;
  intervalMs: number;
}

function classifyRemote(remote: ProviderChargeStatus): ReturnType<typeof classifySicrediCobStatus> {
  if (remote.sicrediStatus) {
    return classifySicrediCobStatus(remote.sicrediStatus);
  }
  switch (remote.status) {
    case 'paid':
      return 'paid';
    case 'cancelled':
      return 'cancelled';
    case 'active':
    case 'pending':
      return 'active';
    case 'expired':
      return 'active';
    default:
      return 'unknown';
  }
}

function summarizeExpirationResults(
  results: ExpirationItemResult[],
  durationMs: number,
  opts: {
    queried: number;
    queryDurationsMs: number[];
    batchSize: number;
    intervalMs: number;
    provider: 'sicredi' | 'mock';
  },
): ExpirationCycleSummary {
  const hasQueries = opts.queried > 0 && opts.queryDurationsMs.length > 0;
  return {
    operation: 'payment_expiration_cycle',
    provider: opts.provider,
    durationMs,
    total: results.length,
    expired: results.filter((r) => r.action === 'expired').length,
    confirmedBeforeExpire: results.filter((r) => r.action === 'confirmed_before_expire').length,
    cancelled: results.filter((r) => r.action === 'cancelled').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
    errors: results.filter((r) => r.action === 'error').length,
    queried: opts.queried,
    averageQueryMs: hasQueries
      ? Math.round(
          opts.queryDurationsMs.reduce((sum, v) => sum + v, 0) / opts.queryDurationsMs.length,
        )
      : 0,
    minQueryMs: hasQueries ? Math.min(...opts.queryDurationsMs) : 0,
    maxQueryMs: hasQueries ? Math.max(...opts.queryDurationsMs) : 0,
    batchSize: opts.batchSize,
    intervalMs: opts.intervalMs,
  };
}

export class PaymentExpirationService {
  private cycleRunning = false;

  isCycleRunning(): boolean {
    return this.cycleRunning;
  }

  resetCycleLock(): void {
    this.cycleRunning = false;
  }

  async queryRemoteCharge(
    payment: PaymentRecord,
    txid: string,
  ): Promise<{ remote: ProviderChargeStatus; durationMs: number }> {
    const env = getEnv();
    const startedAt = Date.now();
    if (env.isSicredi) {
      const remote = await sicrediChargeService.getCharge(txid, {
        correlationId: paymentCorrelationId(payment.id),
        paymentId: payment.id,
      });
      return { remote, durationMs: measureDurationMs(startedAt) };
    }
    const provider = await getPaymentProvider();
    const remote = await provider.getCharge(txid);
    return { remote, durationMs: measureDurationMs(startedAt) };
  }

  async applyLocalExpiration(input: {
    payment: PaymentRecord;
    charge: PaymentChargeRecord;
  }): Promise<ExpirationItemResult> {
    const { payment, charge } = input;
    const refreshedPayment = await paymentRepository.findPaymentById(payment.id);
    const refreshedCharge = (await paymentRepository.listChargesByPaymentId(payment.id)).find(
      (c) => c.id === charge.id,
    );

    if (!refreshedPayment || refreshedPayment.status === 'paid') {
      return {
        paymentId: payment.id,
        chargeId: charge.id,
        txid: charge.txid,
        action: 'skipped',
        message: 'payment_already_paid',
      };
    }

    if (!refreshedCharge || refreshedCharge.status === 'expired' || refreshedCharge.status === 'paid') {
      return {
        paymentId: payment.id,
        chargeId: charge.id,
        txid: charge.txid,
        action: 'skipped',
        message: 'charge_already_final',
      };
    }

    const previousPaymentStatus = refreshedPayment.status;
    const previousChargeStatus = refreshedCharge.status;
    const previousIsCurrent = refreshedCharge.isCurrent;
    const previousExpiresAt = refreshedCharge.expiresAt;
    const registration = refreshedPayment.registrationId
      ? await paymentRepository.findRegistrationById(refreshedPayment.registrationId)
      : null;
    const previousRegistrationStatus = registration?.status ?? null;

    if (refreshedPayment.status !== 'expired') {
      await paymentRepository.updatePaymentStatus(refreshedPayment.id, 'expired');
    }
    await paymentRepository.updateChargeStatus(refreshedCharge.id, 'expired', {
      isCurrent: false,
    });

    if (refreshedPayment.registrationId && previousRegistrationStatus === 'pending_payment') {
      await paymentRepository.expireReservation(
        refreshedPayment.id,
        refreshedPayment.registrationId,
      );
      await paymentRepository.updateRegistrationStatus(
        refreshedPayment.registrationId,
        paymentRepository.getExpireRegistrationMode(),
      );
    }

    if (previousPaymentStatus !== 'expired') {
      await financialAuditService.paymentStatusChanged({
        paymentId: refreshedPayment.id,
        previousStatus: previousPaymentStatus,
        newStatus: 'expired',
        reason: 'expiration_worker',
      });
    }

    await financialAuditService.pixChargeExpired({
      chargeId: refreshedCharge.id,
      previousStatus: previousChargeStatus,
      previousIsCurrent,
      expiresAt: previousExpiresAt,
      reason: 'expiration_worker',
    });

    if (
      refreshedPayment.registrationId &&
      previousRegistrationStatus === 'pending_payment'
    ) {
      const updatedRegistration = await paymentRepository.findRegistrationById(
        refreshedPayment.registrationId,
      );
      if (
        updatedRegistration &&
        updatedRegistration.status !== previousRegistrationStatus
      ) {
        await financialAuditService.registrationStatusChanged({
          registrationId: refreshedPayment.registrationId,
          previousStatus: previousRegistrationStatus,
          newStatus: updatedRegistration.status,
          paymentId: refreshedPayment.id,
          reason: 'expiration_worker',
        });
      }
    }

    pixLog('info', 'Cobrança Pix expirada localmente', {
      correlationId: paymentCorrelationId(refreshedPayment.id),
      paymentId: refreshedPayment.id,
      registrationId: refreshedPayment.registrationId,
      chargeId: refreshedCharge.id,
      txid: refreshedCharge.txid,
      provider: getEnv().isSicredi ? 'sicredi' : 'mock',
      operation: 'expiration',
      statusLocal: 'expired',
    });

    return {
      paymentId: refreshedPayment.id,
      chargeId: refreshedCharge.id,
      txid: refreshedCharge.txid,
      action: 'expired',
    };
  }

  async applyLocalCancellation(input: {
    payment: PaymentRecord;
    charge: PaymentChargeRecord;
    remote?: ProviderChargeStatus;
  }): Promise<ExpirationItemResult> {
    const { payment, charge, remote } = input;
    const refreshed = await paymentRepository.findPaymentById(payment.id);
    if (!refreshed || refreshed.status === 'paid') {
      return {
        paymentId: payment.id,
        chargeId: charge.id,
        txid: charge.txid,
        action: 'skipped',
        message: 'payment_already_paid',
      };
    }
    if (refreshed.status === 'cancelled' && charge.status === 'cancelled') {
      return {
        paymentId: payment.id,
        chargeId: charge.id,
        txid: charge.txid,
        action: 'skipped',
        message: 'already_cancelled',
      };
    }

    const previousPaymentStatus = refreshed.status;
    const previousChargeStatus = charge.status;

    await paymentRepository.updatePaymentStatus(refreshed.id, 'cancelled');
    await paymentRepository.updateChargeStatus(charge.id, 'cancelled', {
      isCurrent: false,
      rawResponse: remote
        ? ((redactSensitiveData(remote.raw ?? {}) as Record<string, unknown>) ?? null)
        : undefined,
    });

    if (refreshed.registrationId) {
      const registration = await paymentRepository.findRegistrationById(refreshed.registrationId);
      if (registration?.status === 'pending_payment') {
        await paymentRepository.expireReservation(refreshed.id, refreshed.registrationId);
        await paymentRepository.updateRegistrationStatus(
          refreshed.registrationId,
          paymentRepository.getExpireRegistrationMode(),
        );
        await financialAuditService.registrationStatusChanged({
          registrationId: refreshed.registrationId,
          previousStatus: 'pending_payment',
          newStatus: paymentRepository.getExpireRegistrationMode(),
          paymentId: refreshed.id,
          reason: 'expiration_worker',
        });
      }
    }

    await financialAuditService.paymentStatusChanged({
      paymentId: refreshed.id,
      previousStatus: previousPaymentStatus,
      newStatus: 'cancelled',
      reason: 'expiration_worker',
    });
    await financialAuditService.pixChargeCancelled({
      chargeId: charge.id,
      previousStatus: previousChargeStatus,
      newStatus: 'cancelled',
      reason: 'expiration_worker',
    });

    return {
      paymentId: refreshed.id,
      chargeId: charge.id,
      txid: charge.txid,
      action: 'cancelled',
    };
  }

  async processExpiredCandidate(input: {
    payment: PaymentRecord;
    charge: PaymentChargeRecord;
  }): Promise<ExpirationItemResult> {
    const { payment, charge } = input;
    const txid = charge.txid || payment.txid;

    if (payment.status === 'paid' || charge.status === 'paid') {
      return {
        paymentId: payment.id,
        chargeId: charge.id,
        txid: txid ?? null,
        action: 'skipped',
        message: 'already_paid',
      };
    }

    if (charge.status === 'expired') {
      return {
        paymentId: payment.id,
        chargeId: charge.id,
        txid: txid ?? null,
        action: 'skipped',
        message: 'already_expired',
      };
    }

    if (!txid) {
      return this.applyLocalExpiration({ payment, charge });
    }

    let remote: ProviderChargeStatus;
    let queryDurationMs: number;
    try {
      const queried = await this.queryRemoteCharge(payment, txid);
      remote = queried.remote;
      queryDurationMs = queried.durationMs;
    } catch (err) {
      const classified = classifyPixError(err);
      pixLog('warn', 'Consulta remota falhou na expiração — mantém charge ativa', {
        correlationId: paymentCorrelationId(payment.id),
        paymentId: payment.id,
        chargeId: charge.id,
        txid,
        provider: getEnv().isSicredi ? 'sicredi' : 'mock',
        operation: 'expiration',
        errorCode: classified,
        errorMessage: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
      return {
        paymentId: payment.id,
        chargeId: charge.id,
        txid,
        action: 'skipped',
        message: 'transient_remote_error',
      };
    }

    const classification = classifyRemote(remote);

    if (classification === 'paid') {
      try {
        if (getEnv().isSicredi) {
          const recon = await sicrediReconciliationService.reconcilePayment(payment.id);
          return {
            paymentId: payment.id,
            chargeId: charge.id,
            txid,
            action:
              recon.action === 'confirmed' || recon.action === 'idempotent'
                ? 'confirmed_before_expire'
                : recon.action === 'error'
                  ? 'error'
                  : 'skipped',
            message: recon.message ?? recon.action,
            queryDurationMs,
          };
        }

        const provider = await getPaymentProvider();
        const fresh = await provider.getCharge(txid);
        if (fresh.status === 'paid' && payment.registrationId) {
          const event = await paymentRepository.createPaymentEvent({
            paymentId: payment.id,
            providerId: payment.providerId,
            eventType: 'payment_confirmed_before_expire',
            externalEventId: fresh.endToEndId
              ? `expire-confirm:${fresh.endToEndId}`
              : `expire-confirm:${payment.id}:${Date.now()}`,
            payload: redactSensitiveData(fresh.raw ?? fresh),
            processed: false,
          });
          await paymentRepository.confirmPaidAtomically({
            paymentId: payment.id,
            chargeId: charge.id,
            registrationId: payment.registrationId,
            endToEndId: fresh.endToEndId ?? `EXPIRE${Date.now()}`,
            paidAt: fresh.paidAt ?? nowIso(),
            eventId: event.id,
            chargeRawResponse:
              (redactSensitiveData(fresh.raw ?? {}) as Record<string, unknown>) ?? undefined,
          });
        }
        return {
          paymentId: payment.id,
          chargeId: charge.id,
          txid,
          action: 'confirmed_before_expire',
          queryDurationMs,
        };
      } catch (err) {
        return {
          paymentId: payment.id,
          chargeId: charge.id,
          txid,
          action: 'error',
          message: err instanceof Error ? err.message.slice(0, 200) : 'confirm_failed',
          queryDurationMs,
        };
      }
    }

    if (classification === 'cancelled') {
      const result = await this.applyLocalCancellation({ payment, charge, remote });
      return { ...result, queryDurationMs };
    }

    if (classification === 'active' || classification === 'unknown') {
      // ATIVA (ou equivalente) com expires_at local já passado → expirar localmente.
      // unknown: ainda expiramos localmente apenas se a validade local já passou
      // (candidato já filtrado por expires_at <= agora); unknown remoto não bloqueia.
      if (classification === 'unknown') {
        pixLog('warn', 'Status remoto desconhecido na expiração — aplica expiração local', {
          correlationId: paymentCorrelationId(payment.id),
          paymentId: payment.id,
          chargeId: charge.id,
          txid,
          operation: 'expiration',
          statusRemote: remote.sicrediStatus ?? remote.status,
        });
      }
      const result = await this.applyLocalExpiration({ payment, charge });
      return { ...result, queryDurationMs };
    }

    const result = await this.applyLocalExpiration({ payment, charge });
    return { ...result, queryDurationMs };
  }

  async runCycle(options?: {
    limit?: number;
    concurrency?: number;
    intervalMs?: number;
  }): Promise<ExpirationCycleSummary | null> {
    if (this.cycleRunning) {
      logger.warn('Ciclo de expiração sobreposto bloqueado');
      return null;
    }

    this.cycleRunning = true;
    const startedAt = Date.now();
    const env = getEnv();
    const batchSize = options?.limit ?? env.PAYMENT_EXPIRATION_BATCH_SIZE;
    const concurrency = options?.concurrency ?? env.PAYMENT_EXPIRATION_CONCURRENCY;
    const intervalMs = options?.intervalMs ?? env.PAYMENT_EXPIRATION_INTERVAL_MS;
    const queryDurationsMs: number[] = [];

    try {
      const candidates = await paymentRepository.findExpiredEligibleCharges(batchSize);
      const results = await mapWithConcurrency(candidates, concurrency, async (item) => {
        const result = await this.processExpiredCandidate(item);
        if (typeof result.queryDurationMs === 'number') {
          queryDurationsMs.push(result.queryDurationMs);
        }
        return result;
      });

      const summary = summarizeExpirationResults(results, measureDurationMs(startedAt), {
        queried: queryDurationsMs.length,
        queryDurationsMs,
        batchSize,
        intervalMs,
        provider: env.isSicredi ? 'sicredi' : 'mock',
      });

      pixLog('info', 'Ciclo de expiração concluído', {
        operation: summary.operation,
        provider: summary.provider,
        durationMs: summary.durationMs,
        total: summary.total,
        expired: summary.expired,
        confirmedBeforeExpire: summary.confirmedBeforeExpire,
        cancelled: summary.cancelled,
        skipped: summary.skipped,
        errors: summary.errors,
        queried: summary.queried,
        averageQueryMs: summary.averageQueryMs,
        minQueryMs: summary.minQueryMs,
        maxQueryMs: summary.maxQueryMs,
        batchSize: summary.batchSize,
        intervalMs: summary.intervalMs,
      });

      return summary;
    } finally {
      this.cycleRunning = false;
    }
  }
}

export const paymentExpirationService = new PaymentExpirationService();

export { summarizeExpirationResults };
