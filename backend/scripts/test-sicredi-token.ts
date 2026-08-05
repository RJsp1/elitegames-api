/**
 * Testa apenas autenticação OAuth Sicredi com mTLS.
 * Não exige Supabase, chave Pix nem webhook.
 * Não altera PAYMENT_PROVIDER, não cria cobrança, não imprime segredos.
 */
import { loadEnvForSicrediOauthScript } from '../src/config/env.js';
import { getSicrediConfig, SICREDI_ENDPOINTS } from '../src/config/sicredi.js';
import { createSicrediHttpClient } from '../src/services/sicredi/sicredi-http-client.js';
import type { SicrediTokenResponse } from '../src/types/sicredi.types.js';
import { AppError } from '../src/utils/app-error.js';
import { redactSensitiveData } from '../src/utils/redact-sensitive-data.js';

function maskClientId(value: string): string {
  if (!value) return '(vazio)';
  if (value.length <= 4) return '****';
  return `…${value.slice(-4)}`;
}

function last4Token(token: string): string {
  if (!token || token.length < 4) return '****';
  return token.slice(-4);
}

function sanitizeErrorMessage(input: unknown): string {
  if (input == null) return '(sem mensagem)';
  if (typeof input === 'string') {
    return input.slice(0, 200);
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const msg =
      (typeof obj.detail === 'string' && obj.detail) ||
      (typeof obj.title === 'string' && obj.title) ||
      (typeof obj.message === 'string' && obj.message) ||
      (typeof obj.error_description === 'string' && obj.error_description) ||
      (typeof obj.error === 'string' && obj.error) ||
      (typeof obj.mensagem === 'string' && obj.mensagem) ||
      null;
    if (msg) return msg.slice(0, 300);
    try {
      return JSON.stringify(redactSensitiveData(obj)).slice(0, 200);
    } catch {
      return '(mensagem não serializável)';
    }
  }
  return String(input).slice(0, 200);
}

function extractErrorCode(data: unknown): string {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.code === 'string') return obj.code;
    if (typeof obj.codigo === 'string') return obj.codigo;
    if (typeof obj.title === 'string') return obj.title;
    if (typeof obj.type === 'string') {
      const parts = obj.type.split('/');
      return parts[parts.length - 1] || obj.type;
    }
  }
  return '(não informado)';
}

async function main(): Promise<void> {
  console.log('=== sicredi:token (OAuth + mTLS) ===');

  let env;
  try {
    env = loadEnvForSicrediOauthScript();
  } catch (err) {
    console.error('ERRO de pré-checagem:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log(`PAYMENT_PROVIDER: ${env.PAYMENT_PROVIDER}`);
  console.log(`SICREDI_BASE_URL: ${env.SICREDI_BASE_URL}`);
  console.log(`SICREDI_CLIENT_ID (últimos 4): ${maskClientId(env.SICREDI_CLIENT_ID)}`);
  console.log('Supabase / PIX key / webhook: não exigidos neste script.');
  console.log('---');

  const config = getSicrediConfig();
  const client = createSicrediHttpClient();
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  try {
    const response = await client.post<SicrediTokenResponse>(
      `${SICREDI_ENDPOINTS.token}?grant_type=client_credentials`,
      undefined,
      {
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    if (response.status < 200 || response.status >= 300) {
      console.error('ERRO na autenticação OAuth Sicredi');
      console.error(`status: ${response.status}`);
      console.error(`código: ${extractErrorCode(response.data)}`);
      console.error(`mensagem: ${sanitizeErrorMessage(response.data)}`);
      process.exit(1);
    }

    const data = response.data;
    if (!data?.access_token || data.expires_in == null) {
      console.error('ERRO: resposta OAuth inválida (sem access_token ou expires_in)');
      console.error(`status: ${response.status}`);
      console.error(`código: ${extractErrorCode(data)}`);
      console.error(`mensagem: ${sanitizeErrorMessage(data)}`);
      process.exit(1);
    }

    console.log('SUCESSO: autenticação OAuth Sicredi com mTLS');
    console.log(`token_type: ${data.token_type || 'Bearer'}`);
    console.log(`expires_in: ${data.expires_in}`);
    console.log(`scopes: ${data.scope ?? '(não informado)'}`);
    console.log(`access_token (últimos 4): …${last4Token(data.access_token)}`);
    process.exit(0);
  } catch (err) {
    console.error('ERRO na autenticação OAuth Sicredi');

    if (err instanceof AppError) {
      console.error(`status: ${err.statusCode}`);
      console.error(`código: ${err.code}`);
      console.error(`mensagem: ${sanitizeErrorMessage(err.message)}`);
      if (err.details) {
        const details = redactSensitiveData(err.details) as Record<string, unknown>;
        if (details.tlsCode) console.error(`tlsCode: ${String(details.tlsCode)}`);
      }
    } else if (err && typeof err === 'object' && 'response' in err) {
      const ax = err as {
        response?: { status?: number; data?: unknown };
        code?: string;
        message?: string;
      };
      console.error(`status: ${ax.response?.status ?? '(sem status)'}`);
      console.error(`código: ${ax.code ?? extractErrorCode(ax.response?.data)}`);
      console.error(
        `mensagem: ${sanitizeErrorMessage(ax.response?.data ?? ax.message ?? err)}`,
      );
    } else if (err instanceof Error) {
      console.error(`status: (sem status HTTP)`);
      console.error(`código: ${(err as Error & { code?: string }).code ?? 'EXCEPTION'}`);
      console.error(`mensagem: ${sanitizeErrorMessage(err.message)}`);
    } else {
      console.error(`status: (desconhecido)`);
      console.error(`código: UNKNOWN`);
      console.error(`mensagem: ${sanitizeErrorMessage(err)}`);
    }

    process.exit(1);
  }
}

main();
