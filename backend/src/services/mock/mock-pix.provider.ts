import { randomBytes } from 'node:crypto';
import type { PaymentProvider } from '../payment/payment-provider.interface.js';
import type {
  PaymentStatusV2,
  ProviderChargeResult,
  ProviderChargeStatus,
} from '../../types/payment.types.js';
import { addSeconds, nowIso } from '../../utils/date.js';
import { AppError } from '../../utils/app-error.js';
import { assertValidTxid } from '../../utils/txid.js';

const chargeStore = new Map<
  string,
  ProviderChargeStatus & { pixCopiaECola: string; expiresAt: string }
>();

export function clearMockPixStore(): void {
  chargeStore.clear();
}

function buildFakePixPayload(txid: string, amount: string): string {
  const merchant = 'ELITE GAMES';
  const city = 'SAO PAULO';
  return (
    `00020126580014BR.GOV.BCB.PIX0136mock-elite-games-${txid.slice(0, 8)}` +
    `52040000530398654${String(amount.length).padStart(2, '0')}${amount}` +
    `5802BR59${String(merchant.length).padStart(2, '0')}${merchant}` +
    `60${String(city.length).padStart(2, '0')}${city}` +
    `62${String(4 + txid.length).padStart(2, '0')}05${String(txid.length).padStart(2, '0')}${txid}` +
    `6304ABCD`
  );
}

export class MockPixProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  async createCharge(input: {
    txid: string;
    amountOriginal: string;
    expirationSeconds: number;
    debtorName: string;
    debtorCpf: string;
    registrationNumber: string;
    categoryName?: string;
  }): Promise<ProviderChargeResult> {
    assertValidTxid(input.txid);
    if (!input.debtorCpf || !input.debtorName) {
      throw AppError.badRequest('Mock exige debtorName e debtorCpf');
    }

    const pixCopiaECola = buildFakePixPayload(input.txid, input.amountOriginal);
    const expiresAt = addSeconds(new Date(), input.expirationSeconds).toISOString();
    const status: PaymentStatusV2 = 'active';

    chargeStore.set(input.txid, {
      txid: input.txid,
      status,
      pixCopiaECola,
      amountOriginal: input.amountOriginal,
      expiresAt,
    });

    return {
      txid: input.txid,
      status,
      pixCopiaECola,
      amountOriginal: input.amountOriginal,
      expiresAt,
      providerChargeId: input.txid,
      rawRequest: {
        txid: input.txid,
        amount: input.amountOriginal,
        expirationSeconds: input.expirationSeconds,
      },
      raw: {
        mock: true,
        registrationNumber: input.registrationNumber,
        categoryName: input.categoryName,
      },
    };
  }

  async getCharge(txid: string): Promise<ProviderChargeStatus> {
    const record = chargeStore.get(txid);
    if (!record) throw AppError.notFound('Cobrança mock não encontrada');

    if (
      (record.status === 'active' || record.status === 'pending') &&
      new Date(record.expiresAt).getTime() <= Date.now()
    ) {
      record.status = 'expired';
      chargeStore.set(txid, record);
    }

    return {
      txid: record.txid,
      status: record.status,
      pixCopiaECola: record.pixCopiaECola,
      amountOriginal: record.amountOriginal,
      endToEndId: record.endToEndId,
      paidAt: record.paidAt,
      raw: { mock: true },
    };
  }

  async simulatePaid(_paymentId: string, txid: string): Promise<ProviderChargeStatus> {
    const record = chargeStore.get(txid);
    if (!record) throw AppError.notFound('Cobrança mock não encontrada');

    const e2e = `E2EMOCK${randomBytes(10).toString('hex')}`.slice(0, 32).toUpperCase();
    record.status = 'paid';
    record.endToEndId = e2e;
    record.paidAt = nowIso();
    chargeStore.set(txid, record);

    return {
      txid: record.txid,
      status: 'paid',
      pixCopiaECola: record.pixCopiaECola,
      amountOriginal: record.amountOriginal,
      endToEndId: e2e,
      paidAt: record.paidAt,
      raw: { mock: true, simulated: true },
    };
  }
}
