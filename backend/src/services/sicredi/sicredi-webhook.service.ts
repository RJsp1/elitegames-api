import { getSicrediConfig, SICREDI_ENDPOINTS } from '../../config/sicredi.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';
import { createSicrediHttpClient } from './sicredi-http-client.js';
import { sicrediAuthService } from './sicredi-auth.service.js';

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
      logger.error('Falha ao registrar webhook Sicredi', { status: response.status });
      throw AppError.serviceUnavailable(
        'Falha ao registrar webhook Sicredi',
        'SICREDI_WEBHOOK_REGISTER_FAILED',
      );
    }

    logger.info('Webhook Sicredi registrado', { url });
    return { url };
  }

  async getWebhook(): Promise<unknown> {
    const config = getSicrediConfig();
    if (!config.pixKey) {
      throw AppError.badRequest('SICREDI_PIX_KEY não configurada');
    }

    const client = createSicrediHttpClient();
    const token = await sicrediAuthService.getAccessToken();

    const response = await client.get(SICREDI_ENDPOINTS.webhook(config.pixKey), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status < 200 || response.status >= 300) {
      throw AppError.serviceUnavailable(
        'Falha ao consultar webhook Sicredi',
        'SICREDI_WEBHOOK_GET_FAILED',
      );
    }

    return response.data;
  }
}

export const sicrediWebhookService = new SicrediWebhookService();
