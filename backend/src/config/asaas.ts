import { getEnv } from './env.js';

export interface CardFeeTier {
  from: number;
  to: number;
  percent: number;
}

export interface AsaasConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  webhookToken: string;
  requestTimeoutMs: number;
  isSandbox: boolean;
  maxInstallments: number;
  minInstallmentValue: number;
  feeFixed: number;
  feeTiers: CardFeeTier[];
}

export function getAsaasConfig(): AsaasConfig {
  const env = getEnv();
  const baseUrl = env.ASAAS_BASE_URL.replace(/\/$/, '');
  return {
    enabled: env.ASAAS_ENABLED && env.ASAAS_API_KEY.length > 0,
    apiKey: env.ASAAS_API_KEY,
    baseUrl,
    webhookToken: env.ASAAS_WEBHOOK_TOKEN,
    requestTimeoutMs: env.ASAAS_REQUEST_TIMEOUT_MS,
    isSandbox: baseUrl.includes('sandbox'),
    maxInstallments: env.ASAAS_CARD_MAX_INSTALLMENTS,
    minInstallmentValue: env.ASAAS_CARD_MIN_INSTALLMENT_VALUE,
    feeFixed: env.ASAAS_CARD_FEE_FIXED,
    feeTiers: [
      { from: 1, to: 1, percent: env.ASAAS_CARD_FEE_PCT_1X },
      { from: 2, to: 6, percent: env.ASAAS_CARD_FEE_PCT_2_6 },
      { from: 7, to: 12, percent: env.ASAAS_CARD_FEE_PCT_7_12 },
      { from: 13, to: 21, percent: env.ASAAS_CARD_FEE_PCT_13_21 },
    ],
  };
}

export const ASAAS_PROVIDER_CODE = 'asaas';
