import { getEnv } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import type { PaymentProvider } from './payment-provider.interface.js';
import type { ProviderChargeResult } from '../../types/payment.types.js';

/** Código canônico do Sicredi em `payment_providers.code` e em PAYMENT_PROVIDER. */
export const SICREDI_PROVIDER_CODE = 'sicredi' as const;
export const MOCK_PROVIDER_CODE = 'mock' as const;

/** Códigos que NUNCA devem ser usados pelo backend elitegames-api. */
export const FORBIDDEN_BACKEND_PROVIDER_CODES = ['manual_pix', 'sicredi_pix'] as const;

export type ConfiguredPaymentProviderName = typeof MOCK_PROVIDER_CODE | typeof SICREDI_PROVIDER_CODE;

/**
 * Resolve o provedor exclusivamente a partir de PAYMENT_PROVIDER.
 * Não consulta is_default do banco e nunca faz fallback para manual_pix.
 */
export function resolveConfiguredProviderName(
  paymentProviderEnv: string = getEnv().PAYMENT_PROVIDER,
): ConfiguredPaymentProviderName {
  const code = String(paymentProviderEnv ?? '').trim().toLowerCase();

  if (code === MOCK_PROVIDER_CODE) return MOCK_PROVIDER_CODE;
  if (code === SICREDI_PROVIDER_CODE) return SICREDI_PROVIDER_CODE;

  if ((FORBIDDEN_BACKEND_PROVIDER_CODES as readonly string[]).includes(code)) {
    throw AppError.internal(
      `Provedor '${code}' não é suportado pelo backend. Use PAYMENT_PROVIDER=sicredi ou mock.`,
      'PROVIDER_FORBIDDEN',
    );
  }

  throw AppError.internal(
    `Provedor de pagamento inválido: ${paymentProviderEnv}`,
    'PROVIDER_INVALID',
  );
}

/**
 * Em produção + PAYMENT_PROVIDER=sicredi, o runtime provider DEVE ser Sicredi.
 * Falha explícita — sem fallback silencioso.
 */
export function assertRuntimeProviderMatchesConfig(provider: PaymentProvider): void {
  const configured = resolveConfiguredProviderName();
  if (configured === SICREDI_PROVIDER_CODE && provider.name !== SICREDI_PROVIDER_CODE) {
    throw AppError.serviceUnavailable(
      `PAYMENT_PROVIDER=sicredi exige runtime Sicredi; recebido '${provider.name}'`,
      'PROVIDER_MISMATCH',
    );
  }
  if (configured === MOCK_PROVIDER_CODE && provider.name !== MOCK_PROVIDER_CODE) {
    throw AppError.internal(
      `PAYMENT_PROVIDER=mock exige runtime mock; recebido '${provider.name}'`,
      'PROVIDER_MISMATCH',
    );
  }
}

/**
 * Garante que a cobrança veio do Sicredi (não de generatePixPayload local).
 */
export function assertSicrediChargeResult(result: ProviderChargeResult): void {
  if (!result.pixCopiaECola || result.pixCopiaECola.trim().length < 20) {
    throw AppError.serviceUnavailable(
      'Cobrança Sicredi sem pixCopiaECola',
      'SICREDI_MISSING_PIX',
    );
  }

  if (!result.pixCopiaECola.startsWith('000201')) {
    throw AppError.serviceUnavailable(
      'pixCopiaECola Sicredi com formato EMV inválido',
      'SICREDI_INVALID_PIX',
    );
  }

  const raw = result.raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // Assinatura típica do Manual PIX local (elitecdt): { brCode, generatedAt }
    if (
      Object.prototype.hasOwnProperty.call(obj, 'brCode') &&
      Object.prototype.hasOwnProperty.call(obj, 'generatedAt') &&
      !Object.prototype.hasOwnProperty.call(obj, 'status') &&
      !Object.prototype.hasOwnProperty.call(obj, 'location') &&
      !Object.prototype.hasOwnProperty.call(obj, 'loc')
    ) {
      throw AppError.serviceUnavailable(
        'Resposta de cobrança parece Manual PIX local; Sicredi exigido',
        'PROVIDER_NOT_SICREDI',
      );
    }
  }
}
