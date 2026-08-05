import type { RequestHandler } from 'express';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

/**
 * Autenticação via X-API-Key para rotas internas da plataforma.
 * Em modo mock/development sem INTERNAL_API_KEY configurada, permite acesso local.
 */
export const authenticationMiddleware: RequestHandler = (req, _res, next) => {
  const env = getEnv();
  const apiKey = req.header('X-API-Key') ?? req.header('Authorization')?.replace(/^Bearer\s+/i, '');

  if (!env.INTERNAL_API_KEY) {
    if (env.isProduction) {
      next(AppError.unauthorized('INTERNAL_API_KEY não configurada'));
      return;
    }
    next();
    return;
  }

  if (!apiKey || apiKey !== env.INTERNAL_API_KEY) {
    next(AppError.unauthorized('API key inválida'));
    return;
  }

  next();
};
