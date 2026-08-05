/**
 * Cria cobrança Pix Sicredi real vinculada a uma inscrição existente no Supabase.
 *
 * Entrada: TEST_REGISTRATION_ID
 * Valor: exclusivamente registrations.total_price (não aceita valor por env/terminal).
 * Pagador: atleta vinculado (registration_athletes → athletes).
 *
 * Não paga automaticamente, não cadastra webhook, não imprime segredos.
 */
import { createInterface } from 'node:readline';
import { loadEnvForPersistedPaymentScript } from '../src/config/env.js';
import { resetSupabaseClient, getSupabase } from '../src/config/supabase.js';
import { paymentRepository } from '../src/repositories/payment.repository.js';
import { paymentService } from '../src/services/payment/payment.service.js';
import { AppError } from '../src/utils/app-error.js';
import { maskCpfDisplay } from '../src/utils/cpf.js';
import { maskPixKey } from '../src/utils/redact-sensitive-data.js';

const PROD_CONFIRM_PHRASE = 'CONFIRMAR PAGAMENTO PERSISTIDO';

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
    return (
      /api-pix\.sicredi\.com\.br/i.test(baseUrl) &&
      !/api-pix-h\.sicredi\.com\.br/i.test(baseUrl)
    );
  }
}

function maskPixCopiaECola(value: string | null | undefined): string {
  if (!value) return '(ausente)';
  if (value.length <= 16) return '****';
  return `${value.slice(0, 12)}…${value.slice(-8)} (len=${value.length})`;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(url inválida)';
  }
}

async function main(): Promise<void> {
  console.log('=== sicredi:create-persisted-payment ===');
  console.log('Fluxo real: payments + Sicredi + payment_charges + registrations.');
  console.log('Valor vem exclusivamente de registrations.total_price.');
  console.log('Pagador vem de registration_athletes → athletes.\n');

  let env;
  try {
    env = loadEnvForPersistedPaymentScript();
  } catch (err) {
    console.error('ERRO de pré-checagem:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  const registrationId = (process.env.TEST_REGISTRATION_ID ?? '').trim();
  if (!registrationId) {
    console.error('ERRO: Exige TEST_REGISTRATION_ID');
    process.exitCode = 1;
    return;
  }

  if (process.env.TEST_CHARGE_AMOUNT || process.env.TEST_PAYMENT_AMOUNT) {
    console.error(
      'ERRO: valor por variável de ambiente não é aceito. Use exclusivamente registrations.total_price.',
    );
    process.exitCode = 1;
    return;
  }

  const production = isSicrediProductionApi(env.SICREDI_BASE_URL);

  console.log(`PAYMENT_PROVIDER: ${env.PAYMENT_PROVIDER}`);
  console.log(`SICREDI_BASE_URL: ${env.SICREDI_BASE_URL}`);
  console.log(`Produção detectada: ${production ? 'SIM' : 'NÃO'}`);
  console.log(`SUPABASE_URL: ${maskUrl(env.SUPABASE_URL)}`);
  console.log('SUPABASE_SERVICE_ROLE_KEY: (não exibida)');
  console.log(`SICREDI_PIX_KEY (mascarada): ${maskPixKey(env.SICREDI_PIX_KEY)}`);
  console.log(`TEST_REGISTRATION_ID: ${registrationId}`);
  console.log('---');

  resetSupabaseClient();
  const supabase = getSupabase();
  if (!supabase) {
    console.error('ERRO: cliente Supabase indisponível');
    process.exitCode = 1;
    return;
  }

  const registration = await paymentRepository.findRegistrationById(registrationId);
  if (!registration) {
    console.error('ERRO: inscrição não encontrada em public.registrations');
    process.exitCode = 1;
    return;
  }

  let debtor;
  try {
    debtor = await paymentService.resolveDebtorForRegistration(registration.id);
  } catch (err) {
    console.error('ERRO ao resolver pagador (atleta vinculado)');
    if (err instanceof AppError) {
      console.error(`código: ${err.code}`);
      console.error(`mensagem: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`mensagem: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Inscrição encontrada:');
  console.log(`  registration_id: ${registration.id}`);
  console.log(`  registration_number: ${registration.registrationNumber}`);
  console.log(`  format: ${registration.format ?? '(null)'}`);
  console.log(`  total_price: ${Number(registration.totalPrice).toFixed(2)}`);
  console.log(`  status: ${registration.status}`);
  console.log(`Pagador: ${debtor.fullName}`);
  console.log(`CPF: ${maskCpfDisplay(debtor.cpfDigits)}`);
  console.log('---');

  if (production) {
    console.log('');
    console.log('############################################################');
    console.log('#  ATENÇÃO: COBRANÇA REAL EM PRODUÇÃO                      #');
    console.log('#  Valor = registrations.total_price (não será alterado)  #');
    console.log('############################################################');
    console.log('');

    const typed = await ask(
      `Digite exatamente "${PROD_CONFIRM_PHRASE}" para continuar (ou Enter para cancelar): `,
    );
    if (typed !== PROD_CONFIRM_PHRASE) {
      console.log('Cancelado. Confirmação de produção não conferiu.');
      process.exitCode = 0;
      return;
    }
  }

  const proceed = await ask(
    `Confirma criar pagamento persistido de R$ ${Number(registration.totalPrice).toFixed(2)}? (sim/não): `,
  );
  if (proceed.toLowerCase() !== 'sim') {
    console.log('Cancelado pelo operador.');
    process.exitCode = 0;
    return;
  }

  try {
    const result = await paymentService.createPayment({
      registrationId: registration.id,
    });

    const payment = await paymentRepository.findPaymentById(result.paymentId);
    const charge = await paymentRepository.findCurrentChargeByPaymentId(result.paymentId);
    const updatedRegistration = await paymentRepository.findRegistrationById(registration.id);

    console.log('');
    console.log('SUCESSO: pagamento persistido criado (sem liquidação automática)');
    console.log(`payment_id: ${result.paymentId}`);
    console.log(`registration_id: ${result.registrationId}`);
    console.log(`txid: ${result.txid}`);
    console.log(`status: ${result.status}`);
    console.log(`valor: ${result.amount}`);
    console.log(`expiração: ${result.expiresAt ?? '(não informado)'}`);
    console.log(`pixCopiaECola (mascarado): ${maskPixCopiaECola(result.pixCopiaECola)}`);
    console.log(`registro salvo em payments: ${payment ? 'sim' : 'não'}`);
    console.log(`registro salvo em payment_charges: ${charge ? 'sim' : 'não'}`);
    if (charge) {
      console.log(`  charge_id: ${charge.id}`);
      console.log(`  charge.status: ${charge.status}`);
      console.log(`  charge.is_current: ${charge.isCurrent}`);
    }
    console.log(`novo status da inscrição: ${updatedRegistration?.status ?? '(desconhecido)'}`);
    process.exitCode = 0;
  } catch (err) {
    console.error('ERRO ao criar pagamento persistido');
    if (err instanceof AppError) {
      console.error(`código: ${err.code}`);
      console.error(`mensagem: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`mensagem: ${err.message}`);
    } else {
      console.error(`mensagem: ${String(err)}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('ERRO:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
