import { AppError } from './app-error.js';
import { maskTxid } from './redact-sensitive-data.js';
import { logger } from './logger.js';

export type PixErrorClass =
  | 'sicredi_auth_error'
  | 'sicredi_timeout'
  | 'sicredi_http_error'
  | 'sicredi_invalid_response'
  | 'database_error'
  | 'audit_error'
  | 'amount_mismatch'
  | 'unknown_error';

export type PixOperation =
  | 'payment_create'
  | 'sicredi_token'
  | 'sicredi_charge_create'
  | 'sicredi_charge_get'
  | 'reconciliation_cycle'
  | 'reconciliation_payment'
  | 'financial_update'
  | 'audit_write'
  | 'webhook_pix'
  | 'expiration'
  | 'health';

/** correlationId estável = payment.id (sem secrets). */
export function paymentCorrelationId(paymentId: string): string {
  return paymentId;
}

/** Remove undefined/null para logs enxutos. */
export function compactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

export function measureDurationMs(startedAt: number): number {
  return Math.max(0, Math.round(Date.now() - startedAt));
}

export async function withDurationMs<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const startedAt = Date.now();
  const result = await fn();
  return { result, durationMs: measureDurationMs(startedAt) };
}

export interface PixLogFields {
  correlationId?: string;
  paymentId?: string;
  registrationId?: string | null;
  chargeId?: string | null;
  txid?: string | null;
  txidMasked?: string;
  provider?: string;
  operation?: PixOperation | string;
  statusLocal?: string;
  statusRemote?: string;
  durationMs?: number;
  attempt?: number;
  httpStatus?: number;
  errorCode?: string | PixErrorClass;
  errorMessage?: string;
  endpoint?: string;
  sicrediCorrelationId?: string;
  [key: string]: unknown;
}

export function buildPixLogMeta(fields: PixLogFields): Record<string, unknown> {
  const txidMasked =
    fields.txidMasked ?? (fields.txid ? maskTxid(String(fields.txid)) : undefined);
  const { txid: _txid, ...rest } = fields;
  return compactMeta({
    ...rest,
    txidMasked,
  });
}

export function pixLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  fields: PixLogFields = {},
): void {
  logger[level](message, buildPixLogMeta(fields));
}

export function classifyPixError(
  error: unknown,
  context?: { httpStatus?: number; operation?: string },
): PixErrorClass {
  if (error instanceof AppError) {
    if (error.code === 'SICREDI_AUTH_FAILED' || error.code === 'SICREDI_AUTH_INVALID') {
      return 'sicredi_auth_error';
    }
    if (error.code === 'SICREDI_TIMEOUT') return 'sicredi_timeout';
    if (error.code === 'SICREDI_TLS_ERROR' || error.code === 'SICREDI_HTTP_ERROR') {
      return 'sicredi_http_error';
    }
    if (
      error.code === 'SICREDI_CHARGE_FAILED' ||
      error.code === 'SICREDI_GET_FAILED' ||
      error.code === 'SICREDI_MISSING_PIX'
    ) {
      return context?.httpStatus && context.httpStatus >= 400
        ? 'sicredi_http_error'
        : 'sicredi_invalid_response';
    }
    if (error.code === 'AMOUNT_MISMATCH' || error.message.includes('divergente')) {
      return 'amount_mismatch';
    }
  }

  if (error && typeof error === 'object') {
    const record = error as { code?: string; message?: string; name?: string };
    const code = String(record.code ?? '');
    const message = String(record.message ?? '').toLowerCase();
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || message.includes('timeout')) {
      return 'sicredi_timeout';
    }
    if (code.startsWith('22') || code.startsWith('23') || code === 'PGRST') {
      return 'database_error';
    }
    if (message.includes('audit')) return 'audit_error';
  }

  if (context?.httpStatus === 401 || context?.httpStatus === 403) {
    return 'sicredi_auth_error';
  }
  if (context?.httpStatus && context.httpStatus >= 400) {
    return 'sicredi_http_error';
  }
  if (context?.operation === 'audit_write') return 'audit_error';

  return 'unknown_error';
}

export function extractSicrediCorrelationId(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const candidates = [
    record.correlationId,
    record.correlation_id,
    record['x-correlation-id'],
    record['X-Correlation-Id'],
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  }
  return undefined;
}
