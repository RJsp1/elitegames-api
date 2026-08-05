/**
 * Testa handshake mTLS. Não faz chamada real por padrão.
 */
import { loadEnv } from '../src/config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();

  if (env.ALLOW_REAL_SICREDI_TEST !== true && process.env.ALLOW_REAL_SICREDI_TEST !== 'true') {
    console.log('=== test-mtls (dry-run) ===');
    console.log('Nenhuma chamada real será feita.');
    console.log('Defina ALLOW_REAL_SICREDI_TEST=true para testar o handshake.');

    const { loadMtlsMaterial } = await import('../src/services/sicredi/sicredi-http-client.js');
    try {
      loadMtlsMaterial();
      console.log('Material mTLS carregado e validado localmente (sem rede).');
      console.log('rejectUnauthorized=true; keepAlive=true.');
    } catch (err) {
      console.error('Falha na validação local mTLS:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  console.log('=== test-mtls (real) ===');
  const { createSicrediHttpClient } = await import('../src/services/sicredi/sicredi-http-client.js');
  const client = createSicrediHttpClient();

  try {
    const response = await client.get('/');
    console.log('Handshake mTLS OK');
    console.log(`HTTP status: ${response.status}`);
  } catch (err) {
    console.error('Falha no handshake mTLS:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
