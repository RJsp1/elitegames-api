import { resolve } from 'node:path';
import { getEnv } from './env.js';

export interface SicrediConfig {
  environment: 'homologacao' | 'producao';
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  pixKey: string;
  privateKeyPath: string;
  certificatePath: string;
  caChainPath: string;
  webhookCertificatePath: string;
  webhookUrl: string;
  requestTimeoutMs: number;
  tokenSafetySeconds: number;
  chargeExpirationSeconds: number;
}

export function getSicrediConfig(): SicrediConfig {
  const env = getEnv();
  return {
    environment: env.SICREDI_ENVIRONMENT,
    baseUrl: env.SICREDI_BASE_URL.replace(/\/$/, ''),
    clientId: env.SICREDI_CLIENT_ID,
    clientSecret: env.SICREDI_CLIENT_SECRET,
    pixKey: env.SICREDI_PIX_KEY,
    privateKeyPath: resolve(env.SICREDI_PRIVATE_KEY_PATH),
    certificatePath: resolve(env.SICREDI_CERTIFICATE_PATH),
    caChainPath: resolve(env.SICREDI_CA_CHAIN_PATH),
    webhookCertificatePath: resolve(env.SICREDI_WEBHOOK_CERTIFICATE_PATH),
    webhookUrl: env.SICREDI_WEBHOOK_URL,
    requestTimeoutMs: env.SICREDI_REQUEST_TIMEOUT_MS,
    tokenSafetySeconds: env.SICREDI_TOKEN_SAFETY_SECONDS,
    chargeExpirationSeconds: env.PIX_CHARGE_EXPIRATION_SECONDS,
  };
}

export const SICREDI_ENDPOINTS = {
  token: '/oauth/token',
  cob: '/api/v3/cob',
  cobPut: (txid: string) => `/api/v3/cob/${txid}`,
  cobGet: (txid: string) => `/api/v3/cob/${txid}`,
  pix: '/api/v3/pix',
  webhook: (pixKey: string) => `/api/v3/webhook/${encodeURIComponent(pixKey)}`,
  refund: (e2eId: string, refundId: string) =>
    `/api/v3/pix/${e2eId}/devolucao/${refundId}`,
} as const;
