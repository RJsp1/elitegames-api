import { getEnv } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import type { PaymentProvider } from './payment-provider.interface.js';
import { MockPixProvider } from '../mock/mock-pix.provider.js';
import {
  assertRuntimeProviderMatchesConfig,
  resolveConfiguredProviderName,
  SICREDI_PROVIDER_CODE,
} from './payment-provider.selection.js';

let cached: PaymentProvider | null = null;

/**
 * Seleciona o provedor de runtime só via PAYMENT_PROVIDER.
 * Nunca consulta is_default do banco e nunca cai em manual_pix.
 */
export async function getPaymentProvider(): Promise<PaymentProvider> {
  if (cached) {
    assertRuntimeProviderMatchesConfig(cached);
    return cached;
  }

  const configured = resolveConfiguredProviderName();

  if (configured === 'mock') {
    cached = new MockPixProvider();
    assertRuntimeProviderMatchesConfig(cached);
    return cached;
  }

  if (configured === SICREDI_PROVIDER_CODE) {
    try {
      const { SicrediPixProvider } = await import('../sicredi/sicredi-pix.provider.js');
      cached = new SicrediPixProvider();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha ao carregar SicrediPixProvider';
      throw AppError.serviceUnavailable(
        `Sicredi indisponível/mal configurado: ${message}`,
        'SICREDI_UNAVAILABLE',
      );
    }
    assertRuntimeProviderMatchesConfig(cached);
    return cached;
  }

  throw AppError.internal(`Provedor de pagamento inválido: ${getEnv().PAYMENT_PROVIDER}`);
}

export function resetPaymentProviderCache(): void {
  cached = null;
}

export {
  resolveConfiguredProviderName,
  assertRuntimeProviderMatchesConfig,
  assertSicrediChargeResult,
  SICREDI_PROVIDER_CODE,
} from './payment-provider.selection.js';
