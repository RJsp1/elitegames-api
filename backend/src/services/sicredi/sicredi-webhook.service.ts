import { getSicrediConfig, SICREDI_ENDPOINTS } from '../../config/sicredi.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';
import { redactSensitiveData } from '../../utils/redact-sensitive-data.js';
import { createSicrediHttpClient } from './sicredi-http-client.js';
import { sicrediAuthService } from './sicredi-auth.service.js';

export type PixKeyApparentType = 'CPF' | 'CNPJ' | 'email' | 'telefone' | 'EVP';

export interface MaskedPixKeyDiagnostic {
  masked: string;
  length: number;
  type: PixKeyApparentType;
}

export interface SanitizedSicrediWebhookError {
  status: number;
  type?: string;
  title?: string;
  detail?: string;
  codigo?: string | number;
  code?: string | number;
  mensagem?: string;
  message?: string;
  violacoes?: unknown;
}

function asRecord(data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

function pickString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function pickCodigo(value: unknown): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
}

function scrubSecretFragments(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    if (result.includes(secret)) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
}

/**
 * Inferência aparente do tipo da chave Pix (Bacen), sem validar dígitos verificadores.
 */
export function detectPixKeyApparentType(pixKey: string): PixKeyApparentType {
  const trimmed = pixKey.trim();
  if (trimmed.includes('@')) return 'email';
  if (trimmed.startsWith('+')) return 'telefone';
  if (/^\d{11}$/.test(trimmed)) return 'CPF';
  if (/^\d{14}$/.test(trimmed)) return 'CNPJ';
  return 'EVP';
}

/**
 * Máscara segura da chave Pix para logs: 4 primeiros + 2 últimos + length + tipo.
 */
export function maskPixKeyDiagnostic(pixKey: string): MaskedPixKeyDiagnostic {
  const trimmed = pixKey.trim();
  const length = trimmed.length;
  const type = detectPixKeyApparentType(trimmed);
  const masked =
    length <= 6 ? '****' : `${trimmed.slice(0, 4)}…${trimmed.slice(-2)}`;
  return { masked, length, type };
}

/**
 * Extrai somente campos diagnósticos do corpo de erro Sicredi/Bacen.
 * Nunca inclui headers, Authorization, token, Client Secret, chave Pix completa
 * nem material de certificado.
 */
export function sanitizeSicrediWebhookErrorBody(
  status: number,
  data: unknown,
  secretsToScrub: string[] = [],
): SanitizedSicrediWebhookError {
  const body = asRecord(data);
  const scrub = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    return scrubSecretFragments(value, secretsToScrub);
  };

  const sanitized: SanitizedSicrediWebhookError = { status };

  const type = scrub(pickString(body.type));
  if (type) sanitized.type = type;

  const title = scrub(pickString(body.title));
  if (title) sanitized.title = title;

  const detail = scrub(pickString(body.detail));
  if (detail) sanitized.detail = detail;

  if (body.codigo !== undefined) {
    const codigo = pickCodigo(body.codigo);
    if (codigo !== undefined) sanitized.codigo = codigo;
  }
  if (body.code !== undefined) {
    const code = pickCodigo(body.code);
    if (code !== undefined) sanitized.code = code;
  }

  const mensagem = scrub(pickString(body.mensagem));
  if (mensagem) sanitized.mensagem = mensagem;

  const message = scrub(pickString(body.message));
  if (message) sanitized.message = message;

  if (body.violacoes !== undefined) {
    sanitized.violacoes = redactSensitiveData(body.violacoes);
  }

  return sanitized;
}

function secretsForScrub(config: { pixKey: string; clientSecret: string }): string[] {
  return [config.pixKey, config.clientSecret].filter(Boolean);
}

export class SicrediWebhookService {
  async registerWebhook(webhookUrl?: string): Promise<{ url: string }> {
    const config = getSicrediConfig();
    const url = webhookUrl || config.webhookUrl;
    if (!url) {
      throw AppError.badRequest('SICREDI_WEBHOOK_URL não configurada');
    }
    if (!config.pixKey) {
      throw AppError.badRequest('SICREDI_PIX_KEY não configurada');
    }

    const client = createSicrediHttpClient();
    const token = await sicrediAuthService.getAccessToken();

    const response = await client.put(
      SICREDI_ENDPOINTS.webhook(config.pixKey),
      { webhookUrl: url },
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (response.status < 200 || response.status >= 300) {
      const sanitized = sanitizeSicrediWebhookErrorBody(
        response.status,
        response.data,
        secretsForScrub(config),
      );
      logger.error('Falha ao registrar webhook Sicredi', {
        ...sanitized,
        pixKey: maskPixKeyDiagnostic(config.pixKey),
      });
      throw new AppError(
        'Falha ao registrar webhook Sicredi',
        503,
        'SICREDI_WEBHOOK_REGISTER_FAILED',
        sanitized,
      );
    }

    logger.info('Webhook Sicredi registrado', { url });
    return { url };
  }

  async getWebhook(): Promise<unknown | null> {
    const config = getSicrediConfig();
    if (!config.pixKey) {
      throw AppError.badRequest('SICREDI_PIX_KEY não configurada');
    }

    const client = createSicrediHttpClient();
    const token = await sicrediAuthService.getAccessToken();

    const response = await client.get(SICREDI_ENDPOINTS.webhook(config.pixKey), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) {
      return null;
    }

    if (response.status < 200 || response.status >= 300) {
      const sanitized = sanitizeSicrediWebhookErrorBody(
        response.status,
        response.data,
        secretsForScrub(config),
      );
      logger.error('Falha ao consultar webhook Sicredi', {
        ...sanitized,
        pixKey: maskPixKeyDiagnostic(config.pixKey),
      });
      throw new AppError(
        'Falha ao consultar webhook Sicredi',
        503,
        'SICREDI_WEBHOOK_GET_FAILED',
        sanitized,
      );
    }

    return response.data;
  }
}

export const sicrediWebhookService = new SicrediWebhookService();
