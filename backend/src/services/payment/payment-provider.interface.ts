import type {
  ProviderChargeResult,
  ProviderChargeStatus,
  ProviderRefundResult,
} from '../../types/payment.types.js';

export interface PaymentProvider {
  readonly name: 'mock' | 'sicredi';

  createCharge(input: {
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
  }): Promise<ProviderChargeResult>;

  getCharge(txid: string): Promise<ProviderChargeStatus>;

  refund?(input: {
    endToEndId: string;
    refundId: string;
    amountOriginal: string;
  }): Promise<ProviderRefundResult>;

  simulatePaid?(paymentId: string, txid: string): Promise<ProviderChargeStatus>;
}
