import type { PaymentProvider } from '../payment/payment-provider.interface.js';
import type {
  ProviderChargeResult,
  ProviderChargeStatus,
  ProviderRefundResult,
} from '../../types/payment.types.js';
import { sicrediChargeService } from './sicredi-charge.service.js';
import { sicrediRefundService } from './sicredi-refund.service.js';

export class SicrediPixProvider implements PaymentProvider {
  readonly name = 'sicredi' as const;

  async createCharge(input: {
    txid: string;
    amountOriginal: string;
    expirationSeconds: number;
    debtorName: string;
    debtorCpf: string;
    registrationNumber: string;
    categoryName?: string;
    solicitacaoPagador?: string;
    correlationId?: string;
    paymentId?: string;
    registrationId?: string;
  }): Promise<ProviderChargeResult> {
    if (!input.debtorCpf || !input.debtorName) {
      throw new Error('SicrediPixProvider exige debtorName e debtorCpf');
    }
    return sicrediChargeService.createImmediateCharge({
      ...input,
      debtorName: input.debtorName,
      debtorCpf: input.debtorCpf,
    });
  }

  async getCharge(txid: string): Promise<ProviderChargeStatus> {
    return sicrediChargeService.getCharge(txid);
  }

  async refund(input: {
    endToEndId: string;
    refundId: string;
    amountOriginal: string;
  }): Promise<ProviderRefundResult> {
    return sicrediRefundService.refund(input);
  }
}
