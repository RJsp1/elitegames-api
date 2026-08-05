import { getSicrediConfig, SICREDI_ENDPOINTS } from '../../config/sicredi.js';
import type { SicrediCachedToken, SicrediTokenResponse } from '../../types/sicredi.types.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';
import { maskToken } from '../../utils/redact-sensitive-data.js';
import { createSicrediHttpClient } from './sicredi-http-client.js';
import { sicrediTokenCache } from './sicredi-token-cache.js';

export class SicrediAuthService {
  async getAccessToken(): Promise<string> {
    const token = await sicrediTokenCache.getOrFetch(() => this.fetchToken());
    return token.accessToken;
  }

  async getTokenInfo(): Promise<Omit<SicrediCachedToken, 'accessToken'> & { accessTokenMasked: string }> {
    const token = await sicrediTokenCache.getOrFetch(() => this.fetchToken());
    return {
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
      scope: token.scope,
      accessTokenMasked: maskToken(token.accessToken),
    };
  }

  private async fetchToken(): Promise<SicrediCachedToken> {
    const config = getSicrediConfig();
    const client = createSicrediHttpClient();

    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

    const response = await client.post<SicrediTokenResponse>(
      `${SICREDI_ENDPOINTS.token}?grant_type=client_credentials`,
      undefined,
      {
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    if (response.status < 200 || response.status >= 300) {
      logger.error('Falha ao obter token Sicredi', { status: response.status });
      throw AppError.serviceUnavailable(
        'Falha na autenticação OAuth Sicredi',
        'SICREDI_AUTH_FAILED',
      );
    }

    const data = response.data;
    if (!data?.access_token || !data.expires_in) {
      throw AppError.serviceUnavailable(
        'Resposta OAuth Sicredi inválida',
        'SICREDI_AUTH_INVALID',
      );
    }

    const safetyMs = config.tokenSafetySeconds * 1000;
    const expiresAt = Date.now() + data.expires_in * 1000 - safetyMs;

    logger.info('Token Sicredi obtido', {
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      scope: data.scope,
      accessTokenMasked: maskToken(data.access_token),
    });

    return {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      expiresAt,
      scope: data.scope,
    };
  }
}

export const sicrediAuthService = new SicrediAuthService();
