import type { RequestHandler } from 'express';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

/**
 * Middleware admin — exige INTERNAL_API_KEY válida.
 */
export const adminMiddleware: RequestHandler = (req, _res, next) => {
  const env = getEnv();
  const apiKey = req.header('X-API-Key') ?? req.header('Authorization')?.replace(/^Bearer\s+/i, '');

  if (!env.INTERNAL_API_KEY) {
    if (env.isProduction) {
      next(AppError.forbidden('Admin API key não configurada'));
      return;
    }
    req.isAdmin = true;
    next();
    return;
  }

  if (!apiKey || apiKey !== env.INTERNAL_API_KEY) {
    next(AppError.forbidden('Acesso admin negado'));
    return;
  }

  req.isAdmin = true;
  next();
};
