import { existsSync, readFileSync } from 'node:fs';
import type { RequestHandler } from 'express';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Segurança do webhook Sicredi.
 * Validação com webhook-sicredi.cer é opcional nesta etapa —
 * não bloqueia desenvolvimento local se o certificado ainda não estiver ativo.
 */
export const webhookSecurityMiddleware: RequestHandler = (req, _res, next) => {
  const env = getEnv();
  const certPath = env.SICREDI_WEBHOOK_CERTIFICATE_PATH;

  if (!existsSync(certPath)) {
    logger.debug('Webhook certificate ausente — validação mTLS de webhook desabilitada', {
      requestId: req.requestId,
    });
    next();
    return;
  }

  try {
    const content = readFileSync(certPath, 'utf8');
    if (!content.includes('BEGIN CERTIFICATE')) {
      logger.warn('Arquivo webhook-sicredi.cer não parece um certificado PEM válido');
    }
    // Preparado para validação futura do certificado do cliente TLS (terminação no Nginx/proxy).
    // Em desenvolvimento local, apenas registra presença do arquivo.
    const clientCertHeader = req.header('X-Client-Cert') ?? req.header('X-SSL-Client-Cert');
    if (clientCertHeader) {
      logger.debug('Header de certificado de cliente presente no webhook', {
        requestId: req.requestId,
      });
    }
  } catch {
    logger.warn('Não foi possível ler certificado de webhook — seguindo sem bloqueio');
  }

  next();
};
