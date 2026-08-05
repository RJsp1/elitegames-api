/**
 * Cria cobrança Pix de teste na API Sicredi.
 * Não grava Supabase, não cadastra webhook, não imprime segredos.
 *
 * PRODUÇÃO (api-pix.sicredi.com.br):
 * - exige confirmação digitada exatamente: CONFIRMAR COBRANCA PRODUCAO
 * - valor padrão R$ 0,01
 * - valor só via TEST_CHARGE_AMOUNT
 * - bloqueia valores > R$ 1,00
 */
import { createInterface } from 'node:readline';
import { loadEnvForSicrediChargeScript } from '../src/config/env.js';
import { getSicrediConfig, SICREDI_ENDPOINTS } from '../src/config/sicredi.js';
import { createSicrediHttpClient } from '../src/services/sicredi/sicredi-http-client.js';
import { sicrediAuthService } from '../src/services/sicredi/sicredi-auth.service.js';
import type { SicrediCobResponse } from '../src/types/sicredi.types.js';
import { generateTxid, assertValidTxid } from '../src/utils/txid.js';
import { AppError } from '../src/utils/app-error.js';
import { redactSensitiveData } from '../src/utils/redact-sensitive-data.js';
import { maskPixKey } from '../src/utils/redact-sensitive-data.js';

const PROD_CONFIRM_PHRASE = 'CONFIRMAR COBRANCA PRODUCAO';
const MAX_TEST_AMOUNT = 1.0;
const DEFAULT_PROD_AMOUNT = '0.01';
const DEFAULT_HOMOLOG_AMOUNT = '0.01';
const EXPIRATION_SECONDS = 1800;

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isSicrediProductionApi(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api-pix.sicredi.com.br';
  } catch {
    return /api-pix\.sicredi\.com\.br/i.test(baseUrl) && !/api-pix-h\.sicredi\.com\.br/i.test(baseUrl);
  }
}

function parseAmount(raw: string): { display: string; numeric: number } {
  const normalized = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Valor inválido: ${raw}. Use formato 0.01`);
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('Valor deve ser maior que zero.');
  }
  return { display: numeric.toFixed(2), numeric };
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
  console.log('=== sicredi:charge (cobrança de teste) ===');
  console.log('Este script NÃO atualiza Supabase e NÃO cadastra webhook.\n');

  let env;
  try {
    env = loadEnvForSicrediChargeScript();
  } catch (err) {
    console.error('ERRO de pré-checagem:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const config = getSicrediConfig();
  const production = isSicrediProductionApi(env.SICREDI_BASE_URL);

  console.log(`PAYMENT_PROVIDER: ${env.PAYMENT_PROVIDER}`);
  console.log(`SICREDI_ENVIRONMENT: ${env.SICREDI_ENVIRONMENT}`);
  console.log(`SICREDI_BASE_URL: ${env.SICREDI_BASE_URL}`);
  console.log(`Produção detectada (api-pix.sicredi.com.br): ${production ? 'SIM' : 'NÃO'}`);
  console.log(`SICREDI_PIX_KEY (mascarada): ${maskPixKey(env.SICREDI_PIX_KEY)}`);
  console.log('---');

  if (production) {
    console.log('');
    console.log('############################################################');
    console.log('#  ATENÇÃO: AMBIENTE DE PRODUÇÃO SICREDI                   #');
    console.log('#  Cobrança será REAL e pode gerar liquidação financeira. #');
    console.log('############################################################');
    console.log('');

    const typed = await ask(
      `Digite exatamente "${PROD_CONFIRM_PHRASE}" para continuar (ou Enter para cancelar): `,
    );
    if (typed !== PROD_CONFIRM_PHRASE) {
      console.log('Cancelado. Confirmação de produção não conferiu.');
      process.exit(0);
    }
  }

  let amountRaw: string;
  if (process.env.TEST_CHARGE_AMOUNT) {
    amountRaw = process.env.TEST_CHARGE_AMOUNT;
  } else if (production) {
    amountRaw = DEFAULT_PROD_AMOUNT;
    console.log(`Valor padrão de produção: R$ ${DEFAULT_PROD_AMOUNT}`);
    console.log('Para outro valor (máx. R$ 1,00), use TEST_CHARGE_AMOUNT.');
  } else {
    amountRaw = DEFAULT_HOMOLOG_AMOUNT;
    console.log(`Valor padrão: R$ ${DEFAULT_HOMOLOG_AMOUNT}`);
    console.log('Para outro valor (máx. R$ 1,00), use TEST_CHARGE_AMOUNT.');
  }

  let amount: { display: string; numeric: number };
  try {
    amount = parseAmount(amountRaw);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (amount.numeric > MAX_TEST_AMOUNT) {
    console.error(
      `Bloqueado: valor R$ ${amount.display} excede o máximo deste script (R$ ${MAX_TEST_AMOUNT.toFixed(2)}).`,
    );
    process.exit(1);
  }

  const txid = generateTxid('EG');
  assertValidTxid(txid);

  console.log('---');
  console.log('Resumo da cobrança de teste:');
  console.log(`  txid: ${txid}`);
  console.log(`  valor: ${amount.display}`);
  console.log(`  expiracao: ${EXPIRATION_SECONDS}s`);
  console.log(`  solicitacaoPagador: Teste integração Elite Games`);
  console.log(`  infoAdicionais: tipo=Teste técnico`);
  console.log('  devedor/CPF: omitido (sem CPF neste teste)');
  console.log('---');

  const proceed = await ask('Confirma envio PUT /api/v3/cob/{txid}? (sim/não): ');
  if (proceed.toLowerCase() !== 'sim') {
    console.log('Cancelado pelo operador.');
    process.exit(0);
  }

  // Payload mínimo Bacen/Sicredi — sem CPF/devedor neste primeiro teste.
  const body = {
    calendario: { expiracao: EXPIRATION_SECONDS },
    valor: { original: amount.display },
    chave: config.pixKey,
    solicitacaoPagador: 'Teste integração Elite Games',
    infoAdicionais: [{ nome: 'tipo', valor: 'Teste técnico' }],
  };

  try {
    const client = createSicrediHttpClient();
    const token = await sicrediAuthService.getAccessToken();

    const response = await client.put<SicrediCobResponse>(
      SICREDI_ENDPOINTS.cobPut(txid),
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (response.status < 200 || response.status >= 300) {
      console.error('ERRO ao criar cobrança');
      console.error(`status: ${response.status}`);
      console.error(`mensagem: ${sanitizeErrorMessage(response.data)}`);
      process.exit(1);
    }

    const data = response.data;
    const location = data.location ?? data.loc?.location;

    console.log('');
    console.log('SUCESSO: cobrança criada (sem persistência local/Supabase)');
    console.log(`txid: ${data.txid || txid}`);
    console.log(`status: ${data.status}`);
    console.log(`valor: ${data.valor?.original ?? amount.display}`);
    console.log(
      `expiracao: ${data.calendario?.expiracao ?? EXPIRATION_SECONDS}s` +
        (data.calendario?.criacao ? ` (criacao: ${data.calendario.criacao})` : ''),
    );
    console.log(`pixCopiaECola: ${data.pixCopiaECola ?? '(não retornado)'}`);
    if (location) {
      console.log(`location: ${location}`);
    }
    process.exit(0);
  } catch (err) {
    console.error('ERRO ao criar cobrança');
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
