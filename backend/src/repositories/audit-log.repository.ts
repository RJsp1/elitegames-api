import { randomUUID } from 'node:crypto';
import { getSupabase } from '../config/supabase.js';
import { nowIso } from '../utils/date.js';
import { redactSensitiveData } from '../utils/redact-sensitive-data.js';
import { logger } from '../utils/logger.js';

/**
 * Schema real de public.audit_logs (consultado no Supabase — não alterar automaticamente):
 * - id
 * - actor_id
 * - action
 * - entity_table (NOT NULL)
 * - entity_id
 * - before
 * - after
 * - reason
 * - ip
 * - created_at
 *
 * Colunas que NÃO existem: actor, entity_type, metadata, details, payload.
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
}

const memoryStore: AuditLogRecord[] = [];

export function clearAuditLogMemoryStore(): void {
  memoryStore.length = 0;
}

export function getAuditLogsSchemaColumns(): readonly string[] {
  return AUDIT_LOGS_COLUMNS;
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

export class AuditLogRepository {
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
  }): Promise<AuditLogRecord> {
    const entityTable = resolveAuditEntityTable(input.entityType);
    const metadata = redactSensitiveData(input.metadata ?? {});
    const before = input.before !== undefined ? redactSensitiveData(input.before) : null;
    const after = input.after !== undefined ? redactSensitiveData(input.after) : null;

    const record: AuditLogRecord = {
      id: randomUUID(),
      action: input.action,
      entityType: input.entityType,
      entityTable,
      entityId: input.entityId ?? null,
      actor: input.actor ?? null,
      metadata,
      createdAt: nowIso(),
      ip: input.ip ?? null,
    };

    const supabase = getSupabase();
    if (!supabase) {
      memoryStore.push(record);
      logger.debug('audit', {
        action: record.action,
        entityTable: record.entityTable,
        entityId: record.entityId ?? undefined,
      });
      return record;
    }

    try {
      const row: Record<string, unknown> = {
        id: record.id,
        action: record.action,
        entity_table: record.entityTable,
        entity_id: record.entityId,
        actor_id: toActorId(record.actor),
        created_at: record.createdAt,
        ip: record.ip,
        before,
        after,
        reason: input.reason ?? null,
      };

      const { error } = await supabase.from('audit_logs').insert(row);

      if (error) {
        const sanitized = sanitizeAuditError(error);
        logger.warn('Falha ao gravar audit log', {
          message: sanitized.message,
          code: sanitized.code,
          action: record.action,
          entityId: record.entityId ?? undefined,
          entityTable: record.entityTable,
        });
      } else {
        logger.debug('audit', {
          action: record.action,
          entityTable: record.entityTable,
          entityId: record.entityId ?? undefined,
        });
      }
    } catch (error) {
      const sanitized = sanitizeAuditError(error);
      logger.warn('Falha ao gravar audit log', {
        message: sanitized.message,
        code: sanitized.code,
        action: record.action,
        entityId: record.entityId ?? undefined,
        entityTable: record.entityTable,
      });
    }

    return record;
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
