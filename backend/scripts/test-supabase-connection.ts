/**
 * Testa conexão com Supabase (somente leitura).
 * Consulta payment_providers (sicredi, manual_pix).
 * Nunca imprime SUPABASE_SERVICE_ROLE_KEY.
 * Não insere, atualiza nem exclui dados.
 *
 * Encerramento limpo no Windows: define process.exitCode e deixa o event loop drenar
 * (não usa process.exit()).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const CODES = ['sicredi', 'manual_pix'] as const;

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(url inválida)';
  }
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  console.log('=== supabase:test ===');

  if (!url) {
    console.error('ERRO: conexão não iniciada');
    console.error('[env] Exige SUPABASE_URL');
    process.exitCode = 1;
    return;
  }

  if (!key) {
    console.error('ERRO: conexão não iniciada');
    console.error('[env] Exige SUPABASE_SERVICE_ROLE_KEY');
    process.exitCode = 1;
    return;
  }

  console.log(`SUPABASE_URL: ${maskUrl(url)}`);
  console.log('SUPABASE_SERVICE_ROLE_KEY: (não exibida)');
  console.log('---');

  const supabase = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase
    .from('payment_providers')
    .select('id, name, code, environment, is_active, is_default, priority')
    .in('code', [...CODES])
    .order('code', { ascending: true });

  if (error) {
    console.error('ERRO: falha na consulta a payment_providers');
    console.error(`mensagem: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log('OK: conexão Supabase');
  console.log(`registros encontrados: ${(data ?? []).length}`);
  console.log('---');

  for (const row of data ?? []) {
    console.log(`id: ${row.id}`);
    console.log(`name: ${row.name}`);
    console.log(`code: ${row.code}`);
    console.log(`environment: ${row.environment ?? '(null)'}`);
    console.log(`is_active: ${row.is_active}`);
    console.log(`is_default: ${row.is_default}`);
    console.log(`priority: ${row.priority ?? '(null)'}`);
    console.log('---');
  }

  process.exitCode = 0;
}

main().catch((err) => {
  console.error('ERRO: conexão Supabase');
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
