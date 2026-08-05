/**
 * Consulta cobrança Pix Sicredi por txid (GET /api/v3/cob/{txid}).
 * Não cria cobrança, não atualiza Supabase, não imprime segredos.
 *
 * Uso:
 *   $env:ALLOW_REAL_SICREDI_TEST='true'
 *   $env:SICREDI_TEST_TXID='...'
 *   npm run sicredi:check-charge
 */
import { loadEnvForSicrediOauthScript } from '../src/config/env.js';
import { SICREDI_ENDPOINTS } from '../src/config/sicredi.js';
import { createSicrediHttpClient } from '../src/services/sicredi/sicredi-http-client.js';
import { sicrediAuthService } from '../src/services/sicredi/sicredi-auth.service.js';
import type { SicrediCobResponse } from '../src/types/sicredi.types.js';
import { assertValidTxid } from '../src/utils/txid.js';
import { AppError } from '../src/utils/app-error.js';
import { redactSensitiveData } from '../src/utils/redact-sensitive-data.js';

type CobGetResponse = SicrediCobResponse & {
  pix?: Array<{
    endToEndId?: string;
    horario?: string;
    valor?: string;
  }>;
};

function maskEndToEndId(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function sanitizeErrorMessage(input: unknown): string {
  if (input == null) return '(sem mensagem)';
  if (typeof input === 'string') return input.slice(0, 300);
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const msg =
      (typeof obj.detail === 'string' && obj.detail) ||
      (typeof obj.title === 'string' && obj.title) ||
      (typeof obj.message === 'string' && obj.message) ||
      null;
    if (msg) return msg.slice(0, 300);
    try {
      return JSON.stringify(redactSensitiveData(obj)).slice(0, 300);
    } catch {
      return '(mensagem não serializável)';
    }
  }
  return String(input).slice(0, 300);
}

async function main(): Promise<void> {
  console.log('=== sicredi:check-charge ===');

  let env;
  try {
    env = loadEnvForSicrediOauthScript();
  } catch (err) {
    console.error('ERRO de pré-checagem:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const txid = (process.env.SICREDI_TEST_TXID ?? '').trim();
  if (!txid) {
    console.error('Exige SICREDI_TEST_TXID com o txid da cobrança.');
    process.exit(1);
  }

  try {
    assertValidTxid(txid);
  } catch {
    console.error('SICREDI_TEST_TXID inválido: deve ter 26 caracteres alfanuméricos.');
    process.exit(1);
  }

  console.log(`PAYMENT_PROVIDER: ${env.PAYMENT_PROVIDER}`);
  console.log(`SICREDI_BASE_URL: ${env.SICREDI_BASE_URL}`);
  console.log(`txid: ${txid}`);
  console.log('---');

  try {
    const client = createSicrediHttpClient();
    const token = await sicrediAuthService.getAccessToken();

    const response = await client.get<CobGetResponse>(SICREDI_ENDPOINTS.cobGet(txid), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) {
      console.error('ERRO: cobrança não encontrada');
      console.error(`status: 404`);
      process.exit(1);
    }

    if (response.status < 200 || response.status >= 300) {
      console.error('ERRO ao consultar cobrança');
      console.error(`status: ${response.status}`);
      console.error(`mensagem: ${sanitizeErrorMessage(response.data)}`);
      process.exit(1);
    }

    const data = response.data;
    const pixList = Array.isArray(data.pix) ? data.pix : [];
    const firstPix = pixList[0];

    console.log('SUCESSO: cobrança consultada');
    console.log(`txid: ${data.txid || txid}`);
    console.log(`status: ${data.status}`);
    console.log(`criacao: ${data.calendario?.criacao ?? '(não informado)'}`);
    console.log(`expiracao: ${data.calendario?.expiracao ?? '(não informado)'}s`);
    console.log(`valor original: ${data.valor?.original ?? '(não informado)'}`);
    console.log(`pix recebidos: ${pixList.length}`);

    if (firstPix?.endToEndId) {
      console.log(`endToEndId (mascarado): ${maskEndToEndId(firstPix.endToEndId)}`);
    }
    if (firstPix?.horario) {
      console.log(`horario pagamento: ${firstPix.horario}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('ERRO ao consultar cobrança');
    if (err instanceof AppError) {
      console.error(`código: ${err.code}`);
      console.error(`mensagem: ${sanitizeErrorMessage(err.message)}`);
    } else if (err instanceof Error) {
      console.error(`mensagem: ${sanitizeErrorMessage(err.message)}`);
    } else {
      console.error(`mensagem: ${sanitizeErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

main();
