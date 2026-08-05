import { getEnv } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import type { PaymentProvider } from './payment-provider.interface.js';
import { MockPixProvider } from '../mock/mock-pix.provider.js';

let cached: PaymentProvider | null = null;

export async function getPaymentProvider(): Promise<PaymentProvider> {
  if (cached) return cached;

  const env = getEnv();

  if (env.PAYMENT_PROVIDER === 'mock') {
    cached = new MockPixProvider();
    return cached;
  }

  if (env.PAYMENT_PROVIDER === 'sicredi') {
    const { SicrediPixProvider } = await import('../sicredi/sicredi-pix.provider.js');
    cached = new SicrediPixProvider();
    return cached;
  }

  throw AppError.internal(`Provedor de pagamento inválido: ${env.PAYMENT_PROVIDER}`);
}

export function resetPaymentProviderCache(): void {
  cached = null;
}
