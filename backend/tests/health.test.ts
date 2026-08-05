import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';

describe('GET /health', () => {
  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'test';
    resetEnvCache();
    loadEnv();
  });

  it('retorna status ok', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('elite-games-api');
    expect(res.body.paymentProvider).toBe('mock');
  });
});
