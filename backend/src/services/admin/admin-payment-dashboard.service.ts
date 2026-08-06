import { getEnv } from '../../config/env.js';
import { paymentRepository } from '../../repositories/payment.repository.js';
import { auditLogRepository } from '../../repositories/audit-log.repository.js';
import {
  evaluateReconciliationHealth,
  readReconciliationHeartbeat,
} from '../../utils/reconciliation-heartbeat.js';
import {
  maskCpf,
  maskEndToEndId,
  maskTxid,
  redactSensitiveData,
} from '../../utils/redact-sensitive-data.js';
import { AppError } from '../../utils/app-error.js';
import type {
  AdminChargeSnippet,
  AdminDashboardSummary,
  AdminMetricsBucket,
  AdminMetricsResponse,
  AdminPaymentListItem,
  AdminReconciliationHealthSnippet,
} from '../../types/admin-payment.types.js';
import type { PaymentChargeRecord, PaymentRecord } from '../../types/payment.types.js';
import type {
  AdminAuditQuery,
  AdminMetricsQuery,
  AdminPaymentListQuery,
} from '../../schemas/admin-payment.schema.js';

function money(value: number): string {
  return Number(value || 0).toFixed(2);
}

function startOfUtcDay(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function paymentTimeSeconds(payment: PaymentRecord): number | null {
  if (!payment.paidAt) return null;
  const created = Date.parse(payment.createdAt);
  const paid = Date.parse(payment.paidAt);
  if (!Number.isFinite(created) || !Number.isFinite(paid) || paid < created) return null;
  return Math.round((paid - created) / 1000);
}

function toChargeSnippet(charge: PaymentChargeRecord | null | undefined): AdminChargeSnippet | null {
  if (!charge) return null;
  return {
    chargeId: charge.id,
    txidMasked: charge.txid ? maskTxid(charge.txid) : null,
    status: charge.status,
    amount: money(charge.amount),
    expiresAt: charge.expiresAt,
    isCurrent: charge.isCurrent,
    createdAt: charge.createdAt,
    hasPixCopyPaste: Boolean(charge.pixCopyPaste),
    hasQrCode: Boolean(charge.qrCodeData || charge.qrCodeImageUrl),
  };
}

function periodKey(iso: string, groupBy: 'day' | 'week' | 'month'): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (groupBy === 'month') return `${y}-${m}`;
  if (groupBy === 'week') {
    const tmp = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return `${y}-${m}-${day}`;
}

export class AdminPaymentDashboardService {
  async getDashboard(): Promise<{
    summary: AdminDashboardSummary;
    reconciliationHealth: AdminReconciliationHealthSnippet;
  }> {
    const env = getEnv();
    const payments = await paymentRepository.listAllPaymentsForAdmin();
    const todayStart = startOfUtcDay();

    let amountReceivedToday = 0;
    let amountPending = 0;
    let paymentsCreatedToday = 0;
    let paymentsPaidToday = 0;
    const paymentTimes: number[] = [];

    const counts = {
      totalPayments: payments.length,
      activePayments: 0,
      paidPayments: 0,
      expiredPayments: 0,
      cancelledPayments: 0,
      failedPayments: 0,
    };

    for (const p of payments) {
      if (p.status === 'active' || p.status === 'pending') {
        counts.activePayments += 1;
        amountPending += Number(p.totalAmount) || 0;
      } else if (p.status === 'paid') {
        counts.paidPayments += 1;
      } else if (p.status === 'expired') {
        counts.expiredPayments += 1;
      } else if (p.status === 'cancelled') {
        counts.cancelledPayments += 1;
      } else if (p.status === 'failed') {
        counts.failedPayments += 1;
      }

      if (p.createdAt >= todayStart) paymentsCreatedToday += 1;
      if (p.status === 'paid' && p.paidAt && p.paidAt >= todayStart) {
        paymentsPaidToday += 1;
        amountReceivedToday += Number(p.totalAmount) || 0;
      }
      const secs = paymentTimeSeconds(p);
      if (secs != null) paymentTimes.push(secs);
    }

    const heartbeat = readReconciliationHeartbeat();
    const health = evaluateReconciliationHealth(heartbeat);

    return {
      summary: {
        ...counts,
        amountReceivedToday: money(amountReceivedToday),
        amountPending: money(amountPending),
        paymentsCreatedToday,
        paymentsPaidToday,
        averagePaymentTimeSeconds:
          paymentTimes.length > 0
            ? Math.round(paymentTimes.reduce((a, b) => a + b, 0) / paymentTimes.length)
            : 0,
      },
      reconciliationHealth: {
        status: health.status,
        enabled: health.enabled || env.PAYMENT_RECONCILIATION_ENABLED,
        lastSuccessfulCycleAt: health.lastSuccessfulCycleAt,
        lastCycleDurationMs: health.lastCycleDurationMs,
        lastCycleTotal: health.lastCycleTotal,
        lastCycleErrors: health.lastCycleErrors,
        consecutiveFailures: health.consecutiveFailures,
      },
    };
  }

  async listPayments(query: AdminPaymentListQuery): Promise<{
    items: AdminPaymentListItem[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const all = await paymentRepository.listAllPaymentsForAdmin();
    const mismatchIds = new Set<string>();
    if (query.hasMismatch === true || query.hasMismatch === false) {
      const mismatches = await auditLogRepository.listFiltered({
        action: 'PAYMENT_AMOUNT_MISMATCH',
        page: 1,
        pageSize: 5000,
      });
      for (const row of mismatches.items) {
        if (row.entityId) mismatchIds.add(row.entityId);
      }
    }

    const registrationCache = new Map<string, Awaited<ReturnType<typeof paymentRepository.findRegistrationById>>>();
    const providerCache = new Map<string, string>();

    const enriched: Array<{
      payment: PaymentRecord;
      registrationNumber: string | null;
      eventId: string | null;
      athleteName: string | null;
      providerCode: string;
    }> = [];

    for (const payment of all) {
      if (query.status && query.status.length > 0 && !query.status.includes(payment.status)) {
        continue;
      }
      if (query.registrationId && payment.registrationId !== query.registrationId) continue;
      if (query.txid && payment.txid !== query.txid) continue;
      if (query.dateFrom && payment.createdAt < query.dateFrom) continue;
      if (query.dateTo && payment.createdAt > query.dateTo) continue;
      if (query.minAmount != null && Number(payment.totalAmount) < query.minAmount) continue;
      if (query.maxAmount != null && Number(payment.totalAmount) > query.maxAmount) continue;
      if (query.expired === true && payment.status !== 'expired') continue;
      if (query.expired === false && payment.status === 'expired') continue;
      if (query.hasMismatch === true && !mismatchIds.has(payment.id)) continue;
      if (query.hasMismatch === false && mismatchIds.has(payment.id)) continue;

      let registrationNumber: string | null = null;
      let eventId: string | null = null;
      let athleteName: string | null = null;

      if (payment.registrationId) {
        let registration = registrationCache.get(payment.registrationId);
        if (registration === undefined) {
          registration = await paymentRepository.findRegistrationById(payment.registrationId);
          registrationCache.set(payment.registrationId, registration);
        }
        if (registration) {
          registrationNumber = registration.registrationNumber;
          eventId = registration.eventId;
          if (query.eventId && registration.eventId !== query.eventId) continue;
          try {
            const athlete = await paymentRepository.findPrimaryAthleteForRegistration(
              registration.id,
              registration.format,
            );
            athleteName = athlete.fullName || null;
          } catch {
            athleteName = null;
          }
        } else if (query.eventId) {
          continue;
        }
      } else if (query.eventId) {
        continue;
      }

      let providerCode = providerCache.get(payment.providerId);
      if (!providerCode) {
        const provider = await paymentRepository.findProviderById(payment.providerId);
        providerCode = provider?.code ?? 'unknown';
        providerCache.set(payment.providerId, providerCode);
      }

      enriched.push({
        payment,
        registrationNumber,
        eventId,
        athleteName,
        providerCode,
      });
    }

    const sortKey = query.sort;
    const dir = query.order === 'asc' ? 1 : -1;
    enriched.sort((a, b) => {
      const pa = a.payment;
      const pb = b.payment;
      let cmp = 0;
      if (sortKey === 'amount') cmp = Number(pa.totalAmount) - Number(pb.totalAmount);
      else if (sortKey === 'status') cmp = pa.status.localeCompare(pb.status);
      else if (sortKey === 'paidAt') cmp = (pa.paidAt ?? '').localeCompare(pb.paidAt ?? '');
      else if (sortKey === 'updatedAt') cmp = pa.updatedAt.localeCompare(pb.updatedAt);
      else cmp = pa.createdAt.localeCompare(pb.createdAt);
      return cmp * dir;
    });

    const total = enriched.length;
    const offset = (query.page - 1) * query.pageSize;
    const pageItems = enriched.slice(offset, offset + query.pageSize);
    const ids = pageItems.map((i) => i.payment.id);
    const [chargesMap, countsMap] = await Promise.all([
      paymentRepository.listCurrentChargesByPaymentIds(ids),
      paymentRepository.countChargesByPaymentIds(ids),
    ]);

    const items: AdminPaymentListItem[] = pageItems.map((row) => {
      const charge = chargesMap.get(row.payment.id) ?? null;
      return {
        paymentId: row.payment.id,
        registrationId: row.payment.registrationId,
        registrationNumber: row.registrationNumber,
        eventId: row.eventId,
        athleteName: row.athleteName,
        amount: money(row.payment.totalAmount),
        status: row.payment.status,
        provider: row.providerCode,
        createdAt: row.payment.createdAt,
        paidAt: row.payment.paidAt,
        paymentTimeSeconds: paymentTimeSeconds(row.payment),
        currentCharge: toChargeSnippet(charge),
        chargeHistoryCount: countsMap.get(row.payment.id) ?? 0,
        endToEndIdMasked: row.payment.endToEndId
          ? maskEndToEndId(row.payment.endToEndId)
          : null,
        txidMasked: row.payment.txid ? maskTxid(row.payment.txid) : null,
      };
    });

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getPaymentDetail(paymentId: string): Promise<Record<string, unknown>> {
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) throw AppError.notFound('Pagamento não encontrado');

    const [charges, provider, registration] = await Promise.all([
      paymentRepository.listChargesByPaymentId(paymentId),
      paymentRepository.findProviderById(payment.providerId),
      payment.registrationId
        ? paymentRepository.findRegistrationById(payment.registrationId)
        : Promise.resolve(null),
    ]);

    let athlete: { id: string; fullName: string; cpfMasked: string } | null = null;
    if (registration) {
      try {
        const a = await paymentRepository.findPrimaryAthleteForRegistration(
          registration.id,
          registration.format,
        );
        athlete = {
          id: a.id,
          fullName: a.fullName,
          cpfMasked: a.cpf ? maskCpf(a.cpf) : '***',
        };
      } catch {
        athlete = null;
      }
    }

    const current = charges.find((c) => c.isCurrent) ?? null;
    const entityIds = [
      payment.id,
      ...charges.map((c) => c.id),
      ...(registration ? [registration.id] : []),
    ];
    const audit = await auditLogRepository.listFiltered({
      entityIds,
      page: 1,
      pageSize: 100,
    });

    const confirmationOrigin = this.resolveConfirmationOrigin(audit.items);
    const env = getEnv();
    const health = evaluateReconciliationHealth(readReconciliationHeartbeat());

    return {
      payment: {
        paymentId: payment.id,
        status: payment.status,
        amount: money(payment.totalAmount),
        currency: payment.currency,
        paymentMethod: payment.paymentMethod,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
        paidAt: payment.paidAt,
        expiresAt: payment.expiresAt,
        paymentTimeSeconds: paymentTimeSeconds(payment),
        txidMasked: payment.txid ? maskTxid(payment.txid) : null,
        endToEndIdMasked: payment.endToEndId ? maskEndToEndId(payment.endToEndId) : null,
        provider: provider?.code ?? 'unknown',
        providerChargeIdMasked: payment.providerChargeId
          ? maskTxid(payment.providerChargeId)
          : null,
        externalReference: payment.externalReference,
      },
      registration: registration
        ? {
            registrationId: registration.id,
            registrationNumber: registration.registrationNumber,
            status: registration.status,
            eventId: registration.eventId,
            categoryId: registration.categoryId,
            format: registration.format,
            totalPrice: money(registration.totalPrice),
          }
        : null,
      athlete,
      currentCharge: toChargeSnippet(current),
      chargeHistory: charges.map((c) => toChargeSnippet(c)),
      auditLogs: audit.items.map((row) => this.sanitizeAuditRow(row)),
      confirmationOrigin,
      worker: {
        status: health.status,
        enabled: health.enabled || env.PAYMENT_RECONCILIATION_ENABLED,
        lastSuccessfulCycleAt: health.lastSuccessfulCycleAt,
        consecutiveFailures: health.consecutiveFailures,
      },
    };
  }

  async listAudit(
    paymentId: string,
    query: AdminAuditQuery,
  ): Promise<{ items: unknown[]; page: number; pageSize: number; total: number }> {
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) throw AppError.notFound('Pagamento não encontrado');

    const charges = await paymentRepository.listChargesByPaymentId(paymentId);
    const entityIds = [
      payment.id,
      ...charges.map((c) => c.id),
      ...(payment.registrationId ? [payment.registrationId] : []),
    ];

    const result = await auditLogRepository.listFiltered({
      action: query.action,
      entityIds,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      items: result.items.map((row) => this.sanitizeAuditRow(row)),
      page: query.page,
      pageSize: query.pageSize,
      total: result.total,
    };
  }

  async getMetrics(query: AdminMetricsQuery): Promise<AdminMetricsResponse> {
    const payments = await paymentRepository.listAllPaymentsForAdmin();
    const filtered = payments.filter((p) => {
      if (query.dateFrom && p.createdAt < query.dateFrom) return false;
      if (query.dateTo && p.createdAt > query.dateTo) return false;
      return true;
    });

    // eventId filter via registration
    const afterEvent: PaymentRecord[] = [];
    for (const p of filtered) {
      if (!query.eventId) {
        afterEvent.push(p);
        continue;
      }
      if (!p.registrationId) continue;
      const reg = await paymentRepository.findRegistrationById(p.registrationId);
      if (reg?.eventId === query.eventId) afterEvent.push(p);
    }

    const reissueAudit = await auditLogRepository.listFiltered({
      action: 'PIX_CHARGE_CREATED',
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      page: 1,
      pageSize: 5000,
    });
    const reissueByPeriod = new Map<string, number>();
    let reissueTotal = 0;
    for (const row of reissueAudit.items) {
      if (!row.reason?.includes('payment_reissue')) continue;
      reissueTotal += 1;
      const key = periodKey(row.createdAt, query.groupBy);
      reissueByPeriod.set(key, (reissueByPeriod.get(key) ?? 0) + 1);
    }

    const buckets = new Map<string, AdminMetricsBucket>();
    const ensure = (key: string): AdminMetricsBucket => {
      let b = buckets.get(key);
      if (!b) {
        b = {
          period: key,
          createdCount: 0,
          paidCount: 0,
          expiredCount: 0,
          cancelledCount: 0,
          failedCount: 0,
          amountCreated: '0.00',
          amountPaid: '0.00',
          conversionRate: 0,
          averagePaymentTimeSeconds: 0,
          expirationRate: 0,
          reissueCount: 0,
        };
        buckets.set(key, b);
      }
      return b;
    };

    const amountCreatedMap = new Map<string, number>();
    const amountPaidMap = new Map<string, number>();
    const timesMap = new Map<string, number[]>();

    for (const p of afterEvent) {
      const key = periodKey(p.createdAt, query.groupBy);
      const b = ensure(key);
      b.createdCount += 1;
      amountCreatedMap.set(key, (amountCreatedMap.get(key) ?? 0) + Number(p.totalAmount));

      if (p.status === 'paid') {
        b.paidCount += 1;
        amountPaidMap.set(key, (amountPaidMap.get(key) ?? 0) + Number(p.totalAmount));
        const secs = paymentTimeSeconds(p);
        if (secs != null) {
          const arr = timesMap.get(key) ?? [];
          arr.push(secs);
          timesMap.set(key, arr);
        }
      } else if (p.status === 'expired') b.expiredCount += 1;
      else if (p.status === 'cancelled') b.cancelledCount += 1;
      else if (p.status === 'failed') b.failedCount += 1;
    }

    for (const [key, b] of buckets) {
      b.amountCreated = money(amountCreatedMap.get(key) ?? 0);
      b.amountPaid = money(amountPaidMap.get(key) ?? 0);
      b.conversionRate = b.createdCount > 0 ? Number((b.paidCount / b.createdCount).toFixed(4)) : 0;
      b.expirationRate =
        b.createdCount > 0 ? Number((b.expiredCount / b.createdCount).toFixed(4)) : 0;
      const times = timesMap.get(key) ?? [];
      b.averagePaymentTimeSeconds =
        times.length > 0 ? Math.round(times.reduce((a, c) => a + c, 0) / times.length) : 0;
      b.reissueCount = reissueByPeriod.get(key) ?? 0;
    }

    const series = [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
    const totals = {
      createdCount: afterEvent.length,
      paidCount: afterEvent.filter((p) => p.status === 'paid').length,
      expiredCount: afterEvent.filter((p) => p.status === 'expired').length,
      cancelledCount: afterEvent.filter((p) => p.status === 'cancelled').length,
      failedCount: afterEvent.filter((p) => p.status === 'failed').length,
      amountCreated: money(afterEvent.reduce((s, p) => s + Number(p.totalAmount), 0)),
      amountPaid: money(
        afterEvent
          .filter((p) => p.status === 'paid')
          .reduce((s, p) => s + Number(p.totalAmount), 0),
      ),
      conversionRate: 0,
      averagePaymentTimeSeconds: 0,
      expirationRate: 0,
      reissueCount: reissueTotal,
    };
    totals.conversionRate =
      totals.createdCount > 0
        ? Number((totals.paidCount / totals.createdCount).toFixed(4))
        : 0;
    totals.expirationRate =
      totals.createdCount > 0
        ? Number((totals.expiredCount / totals.createdCount).toFixed(4))
        : 0;
    const allTimes = afterEvent
      .map((p) => paymentTimeSeconds(p))
      .filter((v): v is number => v != null);
    totals.averagePaymentTimeSeconds =
      allTimes.length > 0
        ? Math.round(allTimes.reduce((a, b) => a + b, 0) / allTimes.length)
        : 0;

    return {
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      groupBy: query.groupBy,
      totals,
      series,
    };
  }

  private resolveConfirmationOrigin(
    logs: Array<{ action: string; reason?: string | null }>,
  ): string | null {
    const reconciled = logs.find((l) => l.action === 'PAYMENT_RECONCILED');
    if (!reconciled) return null;
    const reason = reconciled.reason ?? '';
    if (reason.includes('webhook')) return 'webhook_sicredi';
    if (reason.includes('polling') || reason.includes('expiration')) return 'polling_sicredi';
    if (reason.includes('admin')) return 'admin_manual';
    return reason.split('|')[0] || 'unknown';
  }

  private sanitizeAuditRow(row: {
    action: string;
    entityTable: string;
    entityId: string | null;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    createdAt: string;
  }): Record<string, unknown> {
    return {
      action: row.action,
      entityTable: row.entityTable,
      entityId: row.entityId,
      before: redactSensitiveData(row.before ?? null),
      after: redactSensitiveData(row.after ?? null),
      reason: row.reason ?? null,
      createdAt: row.createdAt,
    };
  }
}

export const adminPaymentDashboardService = new AdminPaymentDashboardService();
