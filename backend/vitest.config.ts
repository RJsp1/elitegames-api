import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    env: {
      NODE_ENV: 'test',
      PAYMENT_PROVIDER: 'mock',
      PORT: '3001',
      APP_BASE_URL: 'http://localhost:3001',
      FRONTEND_URL: 'http://localhost:5173',
      LOG_LEVEL: 'error',
      PIX_CHARGE_EXPIRATION_SECONDS: '1800',
      INTERNAL_API_KEY: 'test-internal-api-key',
    },
  },
});
