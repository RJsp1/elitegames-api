import { getSicrediConfig, SICREDI_ENDPOINTS } from '../../config/sicredi.js';
import type { SicrediRefundRequest, SicrediRefundResponse } from '../../types/sicredi.types.js';
import type { ProviderRefundResult } from '../../types/payment.types.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';
import { createSicrediHttpClient } from './sicredi-http-client.js';
import { sicrediAuthService } from './sicredi-auth.service.js';

export class SicrediRefundService {
  async refund(input: {
    endToEndId: string;
    refundId: string;
    amountOriginal: string;
  }): Promise<ProviderRefundResult> {
    getSicrediConfig();
    const client = createSicrediHttpClient();
    const token = await sicrediAuthService.getAccessToken();

    const body: SicrediRefundRequest = { valor: input.amountOriginal };

    const response = await client.put<SicrediRefundResponse>(
      SICREDI_ENDPOINTS.refund(input.endToEndId, input.refundId),
      body,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (response.status < 200 || response.status >= 300) {
      logger.error('Falha ao estornar Pix Sicredi', { status: response.status });
      throw AppError.serviceUnavailable(
        'Falha ao estornar pagamento Sicredi',
        'SICREDI_REFUND_FAILED',
      );
    }

    return {
      refundId: response.data.id || input.refundId,
      status: response.data.status,
      amount: response.data.valor,
      raw: response.data,
    };
  }
}

export const sicrediRefundService = new SicrediRefundService();
