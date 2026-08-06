/**
 * PM2 ecosystem — sem segredos.
 * Configure variáveis sensíveis via .env / ecosystem deploy / painel do host.
 */
module.exports = {
  apps: [
    {
      name: 'elitegames-api',
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'elitegames-reconciliation',
      script: 'dist/scripts/start-reconciliation-worker-entrypoint.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      time: true,
      env: {
        NODE_ENV: 'production',
        PAYMENT_RECONCILIATION_ENABLED: 'true',
        PAYMENT_RECONCILIATION_INTERVAL_MS: '10000',
        PAYMENT_RECONCILIATION_BATCH_SIZE: '50',
        PAYMENT_RECONCILIATION_CONCURRENCY: '5',
        PAYMENT_EXPIRATION_ENABLED: 'true',
        PAYMENT_EXPIRATION_BATCH_SIZE: '50',
        PAYMENT_EXPIRATION_CONCURRENCY: '5',
      },
    },
  ],
};
