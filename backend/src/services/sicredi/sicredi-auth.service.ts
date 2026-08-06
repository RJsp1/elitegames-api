import { getSicrediConfig, SICREDI_ENDPOINTS } from '../../config/sicredi.js';
import type { SicrediCachedToken, SicrediTokenResponse } from '../../types/sicredi.types.js';
import { AppError } from '../../utils/app-error.js';
import { maskToken } from '../../utils/redact-sensitive-data.js';
import {
  classifyPixError,
  extractSicrediCorrelationId,
  measureDurationMs,
  pixLog,
} from '../../utils/observability.js';
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
    const startedAt = Date.now();
    const attempt = 1;

    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

    try {
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

      const durationMs = measureDurationMs(startedAt);
      const sicrediCorrelationId = extractSicrediCorrelationId(response.headers);

      if (response.status < 200 || response.status >= 300) {
        const errorCode = classifyPixError(null, {
          httpStatus: response.status,
          operation: 'sicredi_token',
        });
        pixLog('error', 'Falha ao obter token Sicredi', {
          operation: 'sicredi_token',
          provider: 'sicredi',
          attempt,
          httpStatus: response.status,
          durationMs,
          errorCode,
          endpoint: 'oauth/token',
          sicrediCorrelationId,
        });
        throw AppError.serviceUnavailable(
          'Falha na autenticação OAuth Sicredi',
          'SICREDI_AUTH_FAILED',
        );
      }

      const data = response.data;
      if (!data?.access_token || !data.expires_in) {
        pixLog('error', 'Resposta OAuth Sicredi inválida', {
          operation: 'sicredi_token',
          provider: 'sicredi',
          attempt,
          httpStatus: response.status,
          durationMs,
          errorCode: 'sicredi_invalid_response',
          endpoint: 'oauth/token',
        });
        throw AppError.serviceUnavailable(
          'Resposta OAuth Sicredi inválida',
          'SICREDI_AUTH_INVALID',
        );
      }

      const safetyMs = config.tokenSafetySeconds * 1000;
      const expiresAt = Date.now() + data.expires_in * 1000 - safetyMs;

      pixLog('info', 'Token Sicredi obtido', {
        operation: 'sicredi_token',
        provider: 'sicredi',
        attempt,
        durationMs,
        httpStatus: response.status,
        endpoint: 'oauth/token',
        sicrediCorrelationId,
      });

      return {
        accessToken: data.access_token,
        tokenType: data.token_type || 'Bearer',
        expiresAt,
        scope: data.scope,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      const durationMs = measureDurationMs(startedAt);
      const errorCode = classifyPixError(error, { operation: 'sicredi_token' });
      pixLog('error', 'Erro ao obter token Sicredi', {
        operation: 'sicredi_token',
        provider: 'sicredi',
        attempt,
        durationMs,
        errorCode,
        errorMessage: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        endpoint: 'oauth/token',
      });
      throw error;
    }
  }
}

export const sicrediAuthService = new SicrediAuthService();
