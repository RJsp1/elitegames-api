/**
 * Registra webhook Pix Sicredi.
 */
import { loadEnv } from '../src/config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();

  if (env.PAYMENT_PROVIDER !== 'sicredi') {
    console.error('Exige PAYMENT_PROVIDER=sicredi');
    process.exit(1);
  }

  if (process.env.ALLOW_REAL_SICREDI_TEST !== 'true') {
    console.error('Exige ALLOW_REAL_SICREDI_TEST=true');
    process.exit(1);
  }

  const { sicrediWebhookService } = await import('../src/services/sicredi/sicredi-webhook.service.js');
  const result = await sicrediWebhookService.registerWebhook();
  console.log('Webhook registrado:', result.url);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
