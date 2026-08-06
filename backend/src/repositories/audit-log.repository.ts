import { createHash, randomUUID } from 'node:crypto';
import { getSupabase } from '../config/supabase.js';
import { nowIso } from '../utils/date.js';
import {
  maskEndToEndId,
  maskTxid,
  redactSensitiveData,
} from '../utils/redact-sensitive-data.js';
import { logger } from '../utils/logger.js';

/**
 * Schema real de public.audit_logs (consultado no Supabase):
 * - id, actor_id, action, entity_table (NOT NULL), entity_id
 * - before, after, reason, ip, created_at
 *
 * before/after = before_data/after_data do domínio.
 * Idempotência: reason = `${origin}|idemp:${key}` + consulta prévia.
 */
const AUDIT_LOGS_COLUMNS = [
  'id',
  'actor_id',
  'action',
  'entity_table',
  'entity_id',
  'before',
  'after',
  'reason',
  'ip',
  'created_at',
] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENTITY_TABLE_ALIASES: Record<string, string> = {
  payment: 'payments',
  payments: 'payments',
  registration: 'registrations',
  registrations: 'registrations',
  charge: 'payment_charges',
  payment_charge: 'payment_charges',
  payment_charges: 'payment_charges',
};

export type FinancialAuditAction =
  | 'PAYMENT_CREATED'
  | 'PIX_CHARGE_CREATED'
  | 'PAYMENT_STATUS_CHANGED'
  | 'PAYMENT_RECONCILED'
  | 'PAYMENT_AMOUNT_MISMATCH'
  | 'PIX_CHARGE_CANCELLED'
  | 'PIX_CHARGE_EXPIRED'
  | 'REGISTRATION_STATUS_CHANGED';

export type FinancialAuditOrigin =
  | 'polling_sicredi'
  | 'webhook_sicredi'
  | 'admin_manual'
  | 'expiration_worker'
  | 'payment_create'
  | 'system';

export interface AuditLogRecord {
  id: string;
  action: string;
  entityType: string;
  entityTable: string;
  entityId: string | null;
  actor: string | null;
  metadata: unknown;
  createdAt: string;
  ip?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface WriteFinancialEventInput {
  action: FinancialAuditAction | string;
  entityTable: 'payments' | 'payment_charges' | 'registrations' | string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: FinancialAuditOrigin | string | null;
  /** Chave de idempotência; se omitida, eventos repetíveis (ex.: STATUS_CHANGED). */
  idempotencyKey?: string | null;
  actorId?: string | null;
  ip?: string | null;
}

export interface WriteFinancialEventResult {
  ok: boolean;
  duplicated: boolean;
  record: AuditLogRecord | null;
  errorCode?: string;
  errorMessage?: string;
}

const memoryStore: AuditLogRecord[] = [];

export function clearAuditLogMemoryStore(): void {
  memoryStore.length = 0;
}

export function getAuditLogsSchemaColumns(): readonly string[] {
  return AUDIT_LOGS_COLUMNS;
}

export function listAuditLogMemoryStore(): AuditLogRecord[] {
  return [...memoryStore];
}

export function resolveAuditEntityTable(entityType: string): string {
  const key = entityType.trim().toLowerCase();
  return ENTITY_TABLE_ALIASES[key] ?? entityType.trim();
}

function toActorId(actor: string | null | undefined): string | null {
  if (!actor) return null;
  return UUID_RE.test(actor) ? actor : null;
}

export function sanitizeAuditError(error: unknown): {
  message: string;
  code?: string;
} {
  if (error && typeof error === 'object') {
    const record = error as {
      message?: unknown;
      code?: unknown;
      details?: unknown;
      hint?: unknown;
    };
    const parts = [
      typeof record.message === 'string' ? record.message : null,
      typeof record.details === 'string' ? record.details : null,
      typeof record.hint === 'string' ? record.hint : null,
    ].filter(Boolean) as string[];

    const message = (parts.join(' | ') || 'unknown_audit_error').slice(0, 400);
    const code = typeof record.code === 'string' ? record.code : undefined;
    return code ? { message, code } : { message };
  }

  if (typeof error === 'string' && error.trim()) {
    return { message: error.slice(0, 400) };
  }

  return { message: 'unknown_audit_error' };
}

export function buildAuditReason(
  origin: string | null | undefined,
  idempotencyKey?: string | null,
): string | null {
  const base = (origin ?? '').trim();
  const key = (idempotencyKey ?? '').trim();
  if (!base && !key) return null;
  if (!key) return base || null;
  if (!base) return `idemp:${key}`;
  return `${base}|idemp:${key}`;
}

export function buildMismatchIdempotencyKey(input: {
  expectedCents: number;
  receivedCents: number;
  txid?: string | null;
}): string {
  const tx = input.txid ? maskTxid(input.txid) : 'notxid';
  return `mismatch:${input.expectedCents}:${input.receivedCents}:${tx}`;
}

export function hashIdempotencyPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

function stripForbiddenAuditFields(value: unknown): unknown {
  const redacted = redactSensitiveData(value);
  if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) {
    return redacted;
  }

  const FORBIDDEN = new Set([
    'pixcopiacola',
    'pix_copy_paste',
    'pixcopiapaste',
    'qrcodedata',
    'qr_code_data',
    'qrcodeimageurl',
    'qr_code_image_url',
    'qrcodedataurl',
    'access_token',
    'client_secret',
    'private_key',
    'certificate',
    'cert',
  ]);

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(redacted as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN.has(normalized) || FORBIDDEN.has(key.toLowerCase())) {
      continue;
    }
    if (normalized === 'txid' && typeof entry === 'string') {
      result[key] = maskTxid(entry);
      continue;
    }
    if (
      (normalized === 'endtoendid' || normalized === 'endtendedid') &&
      typeof entry === 'string'
    ) {
      result[key] = maskEndToEndId(entry);
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      result[key] = stripForbiddenAuditFields(entry);
    } else {
      result[key] = entry;
    }
  }
  return result;
}

export class AuditLogRepository {
  /**
   * API centralizada de auditoria financeira.
   * Nunca lança — falhas viram warning sanitizado.
   */
  async writeFinancialEvent(input: WriteFinancialEventInput): Promise<WriteFinancialEventResult> {
    const entityTable = resolveAuditEntityTable(input.entityTable);
    const reason = buildAuditReason(input.reason ?? null, input.idempotencyKey);

    try {
      if (input.idempotencyKey) {
        const exists = await this.existsFinancialEvent({
          action: input.action,
          entityId: input.entityId,
          idempotencyKey: input.idempotencyKey,
        });
        if (exists) {
          return { ok: true, duplicated: true, record: null };
        }
      }

      const before = input.before !== undefined ? stripForbiddenAuditFields(input.before) : null;
      const after = input.after !== undefined ? stripForbiddenAuditFields(input.after) : null;

      const record: AuditLogRecord = {
        id: randomUUID(),
        action: input.action,
        entityType: entityTable,
        entityTable,
        entityId: input.entityId,
        actor: input.actorId ?? null,
        metadata: { before, after, reason },
        createdAt: nowIso(),
        ip: input.ip ?? null,
        reason,
        before,
        after,
      };

      const supabase = getSupabase();
      if (!supabase) {
        memoryStore.push(record);
        logger.debug('audit', {
          action: record.action,
          entityTable: record.entityTable,
          entityId: record.entityId ?? undefined,
        });
        return { ok: true, duplicated: false, record };
      }

      const { error } = await supabase.from('audit_logs').insert({
        id: record.id,
        action: record.action,
        entity_table: record.entityTable,
        entity_id: record.entityId,
        actor_id: toActorId(record.actor),
        created_at: record.createdAt,
        ip: record.ip,
        before,
        after,
        reason,
      });

      if (error) {
        // Concorrência: unique violation em migration futura
        if (error.code === '23505') {
          return { ok: true, duplicated: true, record: null };
        }
        const sanitized = sanitizeAuditError(error);
        logger.warn('Falha ao gravar audit log', {
          message: sanitized.message,
          code: sanitized.code,
          action: record.action,
          entityId: record.entityId ?? undefined,
          entityTable: record.entityTable,
        });
        return {
          ok: false,
          duplicated: false,
          record: null,
          errorCode: sanitized.code,
          errorMessage: sanitized.message,
        };
      }

      logger.debug('audit', {
        action: record.action,
        entityTable: record.entityTable,
        entityId: record.entityId ?? undefined,
      });
      return { ok: true, duplicated: false, record };
    } catch (error) {
      const sanitized = sanitizeAuditError(error);
      logger.warn('Falha ao gravar audit log', {
        message: sanitized.message,
        code: sanitized.code,
        action: input.action,
        entityId: input.entityId,
        entityTable,
      });
      return {
        ok: false,
        duplicated: false,
        record: null,
        errorCode: sanitized.code,
        errorMessage: sanitized.message,
      };
    }
  }

  async existsFinancialEvent(input: {
    action: string;
    entityId: string;
    idempotencyKey?: string | null;
  }): Promise<boolean> {
    const key = (input.idempotencyKey ?? '').trim();
    const supabase = getSupabase();

    if (!supabase) {
      return memoryStore.some((row) => {
        if (row.action !== input.action || row.entityId !== input.entityId) return false;
        if (!key) return true;
        return typeof row.reason === 'string' && row.reason.includes(`idemp:${key}`);
      });
    }

    try {
      let query = supabase
        .from('audit_logs')
        .select('id')
        .eq('action', input.action)
        .eq('entity_id', input.entityId)
        .limit(1);

      if (key) {
        query = query.ilike('reason', `%idemp:${key}%`);
      }

      const { data, error } = await query;
      if (error) {
        const sanitized = sanitizeAuditError(error);
        logger.warn('Falha ao consultar audit log idempotente', {
          message: sanitized.message,
          code: sanitized.code,
          action: input.action,
          entityId: input.entityId,
        });
        return false;
      }
      return (data?.length ?? 0) > 0;
    } catch (error) {
      const sanitized = sanitizeAuditError(error);
      logger.warn('Falha ao consultar audit log idempotente', {
        message: sanitized.message,
        code: sanitized.code,
        action: input.action,
        entityId: input.entityId,
      });
      return false;
    }
  }

  /** Compatibilidade com chamadas legadas — delega para writeFinancialEvent. */
  async write(input: {
    action: string;
    entityType: string;
    entityId?: string | null;
    actor?: string | null;
    ip?: string | null;
    metadata?: unknown;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<AuditLogRecord> {
    const result = await this.writeFinancialEvent({
      action: input.action,
      entityTable: resolveAuditEntityTable(input.entityType),
      entityId: input.entityId ?? randomUUID(),
      before: input.before ?? null,
      after: input.after ?? input.metadata ?? null,
      reason: input.reason ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      actorId: input.actor ?? null,
      ip: input.ip ?? null,
    });
    return (
      result.record ?? {
        id: randomUUID(),
        action: input.action,
        entityType: input.entityType,
        entityTable: resolveAuditEntityTable(input.entityType),
        entityId: input.entityId ?? null,
        actor: input.actor ?? null,
        metadata: input.metadata ?? null,
        createdAt: nowIso(),
        ip: input.ip ?? null,
      }
    );
  }

  async list(limit = 50): Promise<AuditLogRecord[]> {
    const supabase = getSupabase();
    if (!supabase) {
      return [...memoryStore].reverse().slice(0, limit);
    }

    try {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('id, action, entity_table, entity_id, actor_id, created_at, ip, before, after, reason')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        const sanitized = sanitizeAuditError(error);
        logger.warn('Falha ao listar audit logs', {
          message: sanitized.message,
          code: sanitized.code,
        });
        return [];
      }

      return (data ?? []).map((row) => ({
        id: String(row.id),
        action: String(row.action),
        entityType: String(row.entity_table ?? ''),
        entityTable: String(row.entity_table ?? ''),
        entityId: (row.entity_id as string | null) ?? null,
        actor: (row.actor_id as string | null) ?? null,
        metadata: {
          before: row.before ?? null,
          after: row.after ?? null,
          reason: row.reason ?? null,
        },
        createdAt: String(row.created_at),
        ip: (row.ip as string | null) ?? null,
        reason: (row.reason as string | null) ?? null,
        before: row.before ?? null,
        after: row.after ?? null,
      }));
    } catch (error) {
      const sanitized = sanitizeAuditError(error);
      logger.warn('Falha ao listar audit logs', {
        message: sanitized.message,
        code: sanitized.code,
      });
      return [];
    }
  }
}

export const auditLogRepository = new AuditLogRepository();
