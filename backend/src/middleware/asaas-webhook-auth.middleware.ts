import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { getAsaasConfig } from '../config/asaas.js';
import { AppError } from '../utils/app-error.js';
import { logger } from '../utils/logger.js';

/** Asaas envia o authToken configurado no webhook no header `asaas-access-token`. */
export const asaasWebhookAuthMiddleware: RequestHandler = (req, _res, next) => {
  const expected = getAsaasConfig().webhookToken;
  if (!expected) {
    logger.error('ASAAS_WEBHOOK_TOKEN não configurado — webhook Asaas recusado');
    next(AppError.serviceUnavailable('Webhook não configurado', 'ASAAS_WEBHOOK_NOT_CONFIGURED'));
    return;
  }

  const received = req.header('asaas-access-token') ?? '';
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logger.warn('Webhook Asaas com token inválido', { requestId: req.requestId });
    next(AppError.unauthorized('Token de webhook inválido', 'ASAAS_WEBHOOK_UNAUTHORIZED'));
    return;
  }
  next();
};
