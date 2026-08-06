import type { RequestHandler } from 'express';
import { getSupabase } from '../config/supabase.js';
import { registrationAccessTokenRepository } from '../repositories/registration-access-token.repository.js';
import { AppError } from '../utils/app-error.js';

function extractBearer(req: { header: (name: string) => string | undefined }): string | null {
  const auth = req.header('Authorization');
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/**
 * Token temporário da inscrição (opaco).
 * Nunca aceita token por query string.
 */
export const registrationAccessMiddleware: RequestHandler = async (req, _res, next) => {
  try {
    if (req.query.token || req.query.accessToken || req.query.access_token) {
      next(
        AppError.badRequest(
          'Token não pode ser enviado por query string',
          'TOKEN_QUERY_FORBIDDEN',
        ),
      );
      return;
    }

    const raw = extractBearer(req);
    if (!raw) {
      next(AppError.unauthorized('Token de inscrição obrigatório', 'REGISTRATION_TOKEN_REQUIRED'));
      return;
    }

    // JWT Supabase (3 partes) não é access token de inscrição.
    if (raw.split('.').length === 3) {
      next(AppError.unauthorized('Token de inscrição inválido', 'REGISTRATION_TOKEN_INVALID'));
      return;
    }

    const record = await registrationAccessTokenRepository.findValidByRawToken(raw);
    if (!record) {
      next(
        AppError.unauthorized(
          'Token de inscrição inválido ou expirado',
          'REGISTRATION_TOKEN_INVALID',
        ),
      );
      return;
    }

    req.registrationAccess = {
      registrationId: record.registrationId,
      tokenId: record.id,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/** Valida JWT Supabase quando presente; não bloqueia se ausente. */
export const optionalSupabaseAuthMiddleware: RequestHandler = async (req, _res, next) => {
  try {
    const raw = extractBearer(req);
    if (!raw || raw.split('.').length !== 3) {
      req.supabaseUserId = null;
      next();
      return;
    }

    const supabase = getSupabase();
    if (!supabase) {
      req.supabaseUserId = null;
      next();
      return;
    }

    const { data, error } = await supabase.auth.getUser(raw);
    if (error || !data.user) {
      req.supabaseUserId = null;
      next();
      return;
    }
    req.supabaseUserId = data.user.id;
    next();
  } catch {
    req.supabaseUserId = null;
    next();
  }
};

/** Garante que o token da inscrição bate com o registrationId da rota. */
export function assertRegistrationTokenMatches(req: {
  registrationAccess?: { registrationId: string };
  params: { registrationId?: string };
}): void {
  const tokenRegId = req.registrationAccess?.registrationId;
  const routeRegId = req.params.registrationId;
  if (!tokenRegId || !routeRegId || tokenRegId !== routeRegId) {
    throw AppError.forbidden('Token não autoriza esta inscrição', 'REGISTRATION_FORBIDDEN');
  }
}
