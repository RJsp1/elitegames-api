import { randomUUID } from 'node:crypto';
import { getSupabase } from '../config/supabase.js';
import { nowIso } from '../utils/date.js';
import { redactSensitiveData } from '../utils/redact-sensitive-data.js';
import { logger } from '../utils/logger.js';

/**
 * Schema real de public.audit_logs (consultado no Supabase — não alterar automaticamente):
 * - id
 * - action
 * - entity_id
 * - actor_id
 * - created_at
 * - ip
 *
 * Colunas que NÃO existem neste projeto: actor, entity_type, metadata, details, payload.
 * Campos de domínio extras (entityType/metadata/actor) ficam só em memória/logs sanitizados.
 */
const AUDIT_LOGS_COLUMNS = [
  'id',
  'action',
  'entity_id',
  'actor_id',
  'created_at',
  'ip',
] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditLogRecord {
  id: string;
  action: string;
  entityType: string;
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

function toActorId(actor: string | null | undefined): string | null {
  if (!actor) return null;
  return UUID_RE.test(actor) ? actor : null;
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 300);
  }
  return 'unknown_audit_error';
}

export class AuditLogRepository {
  async write(input: {
    action: string;
    entityType: string;
    entityId?: string | null;
    actor?: string | null;
    ip?: string | null;
    metadata?: unknown;
  }): Promise<AuditLogRecord> {
    const record: AuditLogRecord = {
      id: randomUUID(),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      actor: input.actor ?? null,
      metadata: redactSensitiveData(input.metadata ?? {}),
      createdAt: nowIso(),
      ip: input.ip ?? null,
    };

    const supabase = getSupabase();
    if (!supabase) {
      memoryStore.push(record);
      logger.debug('audit', {
        action: record.action,
        entityType: record.entityType,
        entityId: record.entityId ?? undefined,
      });
      return record;
    }

    try {
      const row = {
        id: record.id,
        action: record.action,
        entity_id: record.entityId,
        actor_id: toActorId(record.actor),
        created_at: record.createdAt,
        ip: record.ip,
      };

      const { error } = await supabase.from('audit_logs').insert(row);

      if (error) {
        logger.warn('Falha ao gravar audit log', {
          message: sanitizeErrorMessage(error),
          action: record.action,
          entityId: record.entityId ?? undefined,
        });
      } else {
        logger.debug('audit', {
          action: record.action,
          entityType: record.entityType,
          entityId: record.entityId ?? undefined,
        });
      }
    } catch (error) {
      logger.warn('Falha ao gravar audit log', {
        message: sanitizeErrorMessage(error),
        action: record.action,
        entityId: record.entityId ?? undefined,
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
        .select('id, action, entity_id, actor_id, created_at, ip')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.warn('Falha ao listar audit logs', {
          message: sanitizeErrorMessage(error),
        });
        return [];
      }

      return (data ?? []).map((row) => ({
        id: String(row.id),
        action: String(row.action),
        entityType: '',
        entityId: (row.entity_id as string | null) ?? null,
        actor: (row.actor_id as string | null) ?? null,
        metadata: null,
        createdAt: String(row.created_at),
        ip: (row.ip as string | null) ?? null,
      }));
    } catch (error) {
      logger.warn('Falha ao listar audit logs', {
        message: sanitizeErrorMessage(error),
      });
      return [];
    }
  }
}

export const auditLogRepository = new AuditLogRepository();
