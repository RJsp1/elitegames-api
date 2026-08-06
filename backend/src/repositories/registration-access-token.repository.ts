import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getSupabase } from '../config/supabase.js';
import { nowIso } from '../utils/date.js';
import { AppError } from '../utils/app-error.js';
import type {
  PublicIdempotencyRecord,
  RegistrationAccessTokenRecord,
} from '../types/public-catalog.types.js';

const tokens = new Map<string, RegistrationAccessTokenRecord>();
const idempotency = new Map<string, PublicIdempotencyRecord>();

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

export function clearPublicAccessMemoryStore(): void {
  tokens.clear();
  idempotency.clear();
}

export function hashAccessToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function generateRawAccessToken(): string {
  return randomBytes(32).toString('hex');
}

function idemKey(scope: string, requestId: string): string {
  return `${scope}::${requestId}`;
}

export class RegistrationAccessTokenRepository {
  async issueToken(
    registrationId: string,
    ttlMs = DEFAULT_TTL_MS,
  ): Promise<{ rawToken: string; record: RegistrationAccessTokenRecord }> {
    const rawToken = generateRawAccessToken();
    const tokenHash = hashAccessToken(rawToken);
    const now = nowIso();
    const record: RegistrationAccessTokenRecord = {
      id: randomUUID(),
      registrationId,
      tokenHash,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      revokedAt: null,
      createdAt: now,
    };

    const supabase = getSupabase();
    if (!supabase) {
      tokens.set(record.tokenHash, record);
      return { rawToken, record };
    }

    const { data, error } = await supabase
      .from('registration_access_tokens')
      .insert({
        id: record.id,
        registration_id: record.registrationId,
        token_hash: record.tokenHash,
        expires_at: record.expiresAt,
        created_at: record.createdAt,
      })
      .select('*')
      .single();
    if (error) throw AppError.internal(error.message);
    return {
      rawToken,
      record: {
        id: String(data.id),
        registrationId: String(data.registration_id),
        tokenHash: String(data.token_hash),
        expiresAt: String(data.expires_at),
        revokedAt: (data.revoked_at as string) ?? null,
        createdAt: String(data.created_at),
      },
    };
  }

  async findValidByRawToken(rawToken: string): Promise<RegistrationAccessTokenRecord | null> {
    const tokenHash = hashAccessToken(rawToken);
    const now = Date.now();

    const supabase = getSupabase();
    if (!supabase) {
      const record = tokens.get(tokenHash);
      if (!record) return null;
      if (record.revokedAt) return null;
      if (Date.parse(record.expiresAt) <= now) return null;
      return record;
    }

    const { data, error } = await supabase
      .from('registration_access_tokens')
      .select('*')
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .gt('expires_at', new Date(now).toISOString())
      .maybeSingle();
    if (error) throw AppError.internal(error.message);
    if (!data) return null;
    return {
      id: String(data.id),
      registrationId: String(data.registration_id),
      tokenHash: String(data.token_hash),
      expiresAt: String(data.expires_at),
      revokedAt: (data.revoked_at as string) ?? null,
      createdAt: String(data.created_at),
    };
  }

  async findIdempotent(
    scope: string,
    requestId: string,
  ): Promise<PublicIdempotencyRecord | null> {
    const key = idemKey(scope, requestId);
    const supabase = getSupabase();
    if (!supabase) return idempotency.get(key) ?? null;

    const { data, error } = await supabase
      .from('public_idempotency_keys')
      .select('*')
      .eq('scope', scope)
      .eq('request_id', requestId)
      .maybeSingle();
    if (error) throw AppError.internal(error.message);
    if (!data) return null;
    return {
      id: String(data.id),
      scope: String(data.scope),
      requestId: String(data.request_id),
      resourceType: String(data.resource_type),
      resourceId: String(data.resource_id),
      responseSnapshot: (data.response_snapshot as Record<string, unknown>) ?? null,
      createdAt: String(data.created_at),
    };
  }

  async saveIdempotent(input: {
    scope: string;
    requestId: string;
    resourceType: string;
    resourceId: string;
    responseSnapshot: Record<string, unknown>;
  }): Promise<PublicIdempotencyRecord> {
    const record: PublicIdempotencyRecord = {
      id: randomUUID(),
      scope: input.scope,
      requestId: input.requestId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      responseSnapshot: input.responseSnapshot,
      createdAt: nowIso(),
    };

    const supabase = getSupabase();
    if (!supabase) {
      idempotency.set(idemKey(input.scope, input.requestId), record);
      return record;
    }

    const { data, error } = await supabase
      .from('public_idempotency_keys')
      .insert({
        id: record.id,
        scope: record.scope,
        request_id: record.requestId,
        resource_type: record.resourceType,
        resource_id: record.resourceId,
        response_snapshot: record.responseSnapshot,
        created_at: record.createdAt,
      })
      .select('*')
      .single();

    if (error) {
      // Concorrência: outra requisição gravou primeiro.
      if (String(error.code) === '23505') {
        const existing = await this.findIdempotent(input.scope, input.requestId);
        if (existing) return existing;
      }
      throw AppError.internal(error.message);
    }

    return {
      id: String(data.id),
      scope: String(data.scope),
      requestId: String(data.request_id),
      resourceType: String(data.resource_type),
      resourceId: String(data.resource_id),
      responseSnapshot: (data.response_snapshot as Record<string, unknown>) ?? null,
      createdAt: String(data.created_at),
    };
  }
}

export const registrationAccessTokenRepository = new RegistrationAccessTokenRepository();
