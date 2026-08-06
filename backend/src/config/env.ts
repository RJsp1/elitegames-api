import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const baseSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_BASE_URL: z.string().url().default('http://localhost:3001'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  PAYMENT_PROVIDER: z.enum(['mock', 'sicredi']).default('mock'),
  PIX_CHARGE_EXPIRATION_SECONDS: z.coerce.number().int().positive().default(1800),
  INTERNAL_API_KEY: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ALLOW_REAL_SICREDI_TEST: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  ALLOW_REAL_SICREDI_CHARGE: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),

  SICREDI_ENVIRONMENT: z.enum(['homologacao', 'producao']).default('homologacao'),
  SICREDI_BASE_URL: z.string().url().default('https://api-pix-h.sicredi.com.br'),
  SICREDI_CLIENT_ID: z.string().optional().default(''),
  SICREDI_CLIENT_SECRET: z.string().optional().default(''),
  SICREDI_PIX_KEY: z.string().optional().default(''),
  SICREDI_PRIVATE_KEY_PATH: z
    .string()
    .default('./certificates/homologacao/api-pix-elitegames-api.key'),
  SICREDI_CERTIFICATE_PATH: z
    .string()
    .default('./certificates/homologacao/63325362000172.cer'),
  SICREDI_CA_CHAIN_PATH: z
    .string()
    .default('./certificates/homologacao/CadeiaCompletaSicredi.cer'),
  SICREDI_WEBHOOK_CERTIFICATE_PATH: z
    .string()
    .default('./certificates/homologacao/webhook-sicredi.cer'),
  SICREDI_WEBHOOK_URL: z.string().optional().default(''),
  SICREDI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  SICREDI_TOKEN_SAFETY_SECONDS: z.coerce.number().int().nonnegative().default(30),

  SUPABASE_URL: z.string().optional().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),

  PAYMENT_RECONCILIATION_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  PAYMENT_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  PAYMENT_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(50),
  PAYMENT_RECONCILIATION_CONCURRENCY: z.coerce.number().int().positive().max(20).default(5),

  PAYMENT_EXPIRATION_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((v) => v === 'true'),
  PAYMENT_EXPIRATION_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  PAYMENT_EXPIRATION_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(50),
  PAYMENT_EXPIRATION_CONCURRENCY: z.coerce.number().int().positive().max(20).default(5),
});

export type Env = z.infer<typeof baseSchema> & {
  isMock: boolean;
  isSicredi: boolean;
  isProduction: boolean;
};

function assertFilePresent(pathValue: string, label: string): void {
  const absolute = resolve(pathValue);
  if (!existsSync(absolute)) {
    throw new Error(`[env] ${label} não encontrado: ${pathValue}`);
  }
  const stats = statSync(absolute);
  if (stats.size === 0) {
    throw new Error(`[env] ${label} está vazio: ${pathValue}`);
  }
  const head = readFileSync(absolute, 'utf8').slice(0, 80);
  if (head.includes('BEGIN CERTIFICATE REQUEST') || head.includes('BEGIN NEW CERTIFICATE REQUEST')) {
    throw new Error(
      `[env] ${label} parece ser um CSR, não um certificado: ${pathValue}`,
    );
  }
}

function validateSicrediMtlsFiles(parsed: z.infer<typeof baseSchema>): void {
  assertFilePresent(parsed.SICREDI_PRIVATE_KEY_PATH, 'SICREDI_PRIVATE_KEY_PATH');
  assertFilePresent(parsed.SICREDI_CERTIFICATE_PATH, 'SICREDI_CERTIFICATE_PATH');
  assertFilePresent(parsed.SICREDI_CA_CHAIN_PATH, 'SICREDI_CA_CHAIN_PATH');
}

function validateSicrediRequirements(parsed: z.infer<typeof baseSchema>): void {
  const missing: string[] = [];
  if (!parsed.SICREDI_CLIENT_ID) missing.push('SICREDI_CLIENT_ID');
  if (!parsed.SICREDI_CLIENT_SECRET) missing.push('SICREDI_CLIENT_SECRET');
  if (!parsed.SICREDI_PIX_KEY) missing.push('SICREDI_PIX_KEY');
  if (!parsed.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!parsed.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) {
    throw new Error(
      `[env] PAYMENT_PROVIDER=sicredi exige: ${missing.join(', ')}`,
    );
  }

  validateSicrediMtlsFiles(parsed);
}

let cachedEnv: Env | null = null;

/**
 * Carrega env para cobrança Pix Sicredi persistida no Supabase.
 * Exige Sicredi (OAuth + Pix + mTLS), ALLOW_REAL_SICREDI_CHARGE e Supabase.
 * Não altera a validação do servidor (loadEnv).
 */
export function loadEnvForPersistedPaymentScript(): Env {
  resetEnvCache();
  const parsed = baseSchema.parse(process.env);

  if (parsed.PAYMENT_PROVIDER !== 'sicredi') {
    throw new Error('[env] Exige PAYMENT_PROVIDER=sicredi');
  }
  if (!parsed.ALLOW_REAL_SICREDI_CHARGE) {
    throw new Error('[env] Exige ALLOW_REAL_SICREDI_CHARGE=true');
  }

  const missing: string[] = [];
  if (!parsed.SICREDI_CLIENT_ID) missing.push('SICREDI_CLIENT_ID');
  if (!parsed.SICREDI_CLIENT_SECRET) missing.push('SICREDI_CLIENT_SECRET');
  if (!parsed.SICREDI_PIX_KEY) missing.push('SICREDI_PIX_KEY');
  if (!parsed.SICREDI_BASE_URL) missing.push('SICREDI_BASE_URL');
  if (!parsed.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!parsed.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    throw new Error(`[env] Script de pagamento persistido exige: ${missing.join(', ')}`);
  }

  validateSicrediMtlsFiles(parsed);

  const env: Env = {
    ...parsed,
    isMock: false,
    isSicredi: true,
    isProduction: parsed.NODE_ENV === 'production',
  };
  cachedEnv = env;
  return env;
}

/**
 * Carrega env para scripts de autenticação OAuth/mTLS.
 * NÃO exige Supabase, chave Pix nem webhook — validação do servidor permanece intacta em loadEnv().
 */
export function loadEnvForSicrediOauthScript(): Env {
  resetEnvCache();
  const parsed = baseSchema.parse(process.env);

  if (parsed.PAYMENT_PROVIDER !== 'sicredi') {
    throw new Error('[env] Exige PAYMENT_PROVIDER=sicredi');
  }
  if (!parsed.ALLOW_REAL_SICREDI_TEST) {
    throw new Error('[env] Exige ALLOW_REAL_SICREDI_TEST=true');
  }

  const missing: string[] = [];
  if (!parsed.SICREDI_CLIENT_ID) missing.push('SICREDI_CLIENT_ID');
  if (!parsed.SICREDI_CLIENT_SECRET) missing.push('SICREDI_CLIENT_SECRET');
  if (!parsed.SICREDI_BASE_URL) missing.push('SICREDI_BASE_URL');
  if (missing.length > 0) {
    throw new Error(`[env] Script OAuth exige: ${missing.join(', ')}`);
  }

  validateSicrediMtlsFiles(parsed);

  const env: Env = {
    ...parsed,
    isMock: false,
    isSicredi: true,
    isProduction: parsed.NODE_ENV === 'production',
  };
  cachedEnv = env;
  return env;
}

/**
 * Carrega env para scripts de cobrança Pix de teste.
 * Exige credenciais OAuth, chave Pix e mTLS.
 * NÃO exige Supabase nem webhook — validação do servidor permanece intacta em loadEnv().
 */
export function loadEnvForSicrediChargeScript(): Env {
  resetEnvCache();
  const parsed = baseSchema.parse(process.env);

  if (parsed.PAYMENT_PROVIDER !== 'sicredi') {
    throw new Error('[env] Exige PAYMENT_PROVIDER=sicredi');
  }
  if (!parsed.ALLOW_REAL_SICREDI_CHARGE) {
    throw new Error('[env] Exige ALLOW_REAL_SICREDI_CHARGE=true');
  }

  const missing: string[] = [];
  if (!parsed.SICREDI_CLIENT_ID) missing.push('SICREDI_CLIENT_ID');
  if (!parsed.SICREDI_CLIENT_SECRET) missing.push('SICREDI_CLIENT_SECRET');
  if (!parsed.SICREDI_PIX_KEY) missing.push('SICREDI_PIX_KEY');
  if (!parsed.SICREDI_BASE_URL) missing.push('SICREDI_BASE_URL');
  if (missing.length > 0) {
    throw new Error(`[env] Script de cobrança exige: ${missing.join(', ')}`);
  }

  validateSicrediMtlsFiles(parsed);

  const env: Env = {
    ...parsed,
    isMock: false,
    isSicredi: true,
    isProduction: parsed.NODE_ENV === 'production',
  };
  cachedEnv = env;
  return env;
}

/**
 * Carrega env para scripts de leitura no Supabase.
 * Exige apenas SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.
 * Não altera a validação do servidor (loadEnv).
 */
export function loadEnvForSupabaseScript(): Env {
  resetEnvCache();
  const parsed = baseSchema.parse(process.env);

  if (!parsed.SUPABASE_URL) {
    throw new Error('[env] Exige SUPABASE_URL');
  }
  if (!parsed.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('[env] Exige SUPABASE_SERVICE_ROLE_KEY');
  }

  const env: Env = {
    ...parsed,
    isMock: true,
    isSicredi: false,
    isProduction: parsed.NODE_ENV === 'production',
  };
  cachedEnv = env;
  return env;
}

export function loadEnv(overrides?: Partial<Record<string, string>>): Env {
  if (cachedEnv && !overrides) return cachedEnv;

  const source = { ...process.env, ...overrides };
  const parsed = baseSchema.parse(source);

  if (parsed.PAYMENT_PROVIDER === 'sicredi') {
    validateSicrediRequirements(parsed);
  }

  const env: Env = {
    ...parsed,
    isMock: parsed.PAYMENT_PROVIDER === 'mock',
    isSicredi: parsed.PAYMENT_PROVIDER === 'sicredi',
    isProduction: parsed.NODE_ENV === 'production',
  };

  if (!overrides) {
    cachedEnv = env;
  }

  return env;
}

export function resetEnvCache(): void {
  cachedEnv = null;
}

export function getEnv(): Env {
  return loadEnv();
}

/** Validação usada em testes sem mutar cache global. */
export function parseEnvForTest(source: Record<string, string | undefined>): Env {
  const parsed = baseSchema.parse(source);
  if (parsed.PAYMENT_PROVIDER === 'sicredi') {
    validateSicrediRequirements(parsed);
  }
  return {
    ...parsed,
    isMock: parsed.PAYMENT_PROVIDER === 'mock',
    isSicredi: parsed.PAYMENT_PROVIDER === 'sicredi',
    isProduction: parsed.NODE_ENV === 'production',
  };
}
