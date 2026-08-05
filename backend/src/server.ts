import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { startExpirePaymentsJob } from './jobs/expire-payments.job.js';
import { startReconcilePaymentsJob } from './jobs/reconcile-payments.job.js';

const env = loadEnv();
const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info('ELITE GAMES API iniciada', {
    port: env.PORT,
    env: env.NODE_ENV,
    paymentProvider: env.PAYMENT_PROVIDER,
    baseUrl: env.APP_BASE_URL,
  });

  startExpirePaymentsJob();
  startReconcilePaymentsJob();
});

function shutdown(signal: string): void {
  logger.info(`Encerrando (${signal})...`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
