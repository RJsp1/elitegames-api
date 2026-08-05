/**
 * Registra webhook Pix Sicredi.
 * Não executa chamada real sem ALLOW_REAL_SICREDI_TEST=true e PAYMENT_PROVIDER=sicredi.
 */
import { loadEnv } from '../src/config/env.js';
import { AppError } from '../src/utils/app-error.js';

function extractWebhookUrl(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const url = record.webhookUrl ?? record.webhook_url ?? record.url;
  return typeof url === 'string' && url.trim() ? url : null;
}

async function main(): Promise<void> {
  const env = loadEnv();

  if (env.PAYMENT_PROVIDER !== 'sicredi') {
    console.error('Exige PAYMENT_PROVIDER=sicredi');
    process.exitCode = 1;
    return;
  }

  if (process.env.ALLOW_REAL_SICREDI_TEST !== 'true') {
    console.error('Exige ALLOW_REAL_SICREDI_TEST=true');
    process.exitCode = 1;
    return;
  }

  const { sicrediWebhookService } = await import(
    '../src/services/sicredi/sicredi-webhook.service.js'
  );

  try {
    const current = await sicrediWebhookService.getWebhook();
    if (current === null) {
      console.log('Webhook atual: não cadastrado');
    } else {
      const currentUrl = extractWebhookUrl(current);
      console.log(
        currentUrl
          ? `Webhook atual: ${currentUrl}`
          : 'Webhook atual: cadastrado (URL não informada no retorno)',
      );
    }
  } catch (err) {
    if (err instanceof AppError && err.details) {
      console.error('Falha ao consultar webhook atual:', err.message);
      console.error(JSON.stringify(err.details, null, 2));
    } else {
      console.error(err instanceof Error ? err.message : err);
    }
    process.exitCode = 1;
    return;
  }

  try {
    const result = await sicrediWebhookService.registerWebhook();
    console.log('Webhook registrado:', result.url);
  } catch (err) {
    if (err instanceof AppError && err.details) {
      console.error('Falha ao registrar webhook:', err.message);
      console.error(JSON.stringify(err.details, null, 2));
    } else {
      console.error(err instanceof Error ? err.message : err);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
