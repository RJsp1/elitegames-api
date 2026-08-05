import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import {
  clearPaymentMemoryStore,
  seedRegistrationForTest,
  seedAthleteForTest,
  seedRegistrationAthleteForTest,
} from '../src/repositories/payment.repository.js';
import { clearMockPixStore } from '../src/services/mock/mock-pix.provider.js';
import { resetPaymentProviderCache } from '../src/services/payment/payment-provider.factory.js';

const VALID_CPF = '52998224725';

describe('webhook idempotency (schema real)', () => {
  const app = createApp();
  const apiKey = process.env.INTERNAL_API_KEY || 'test-internal-api-key';

  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'test';
    resetEnvCache();
    loadEnv();
  });

  beforeEach(() => {
    clearPaymentMemoryStore();
    clearMockPixStore();
    resetPaymentProviderCache();
  });

  it('processa webhook e ignora duplicata por endToEndId', async () => {
    const regId = randomUUID();
    const athleteId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 199.9, status: 'draft' });
    seedAthleteForTest({ id: athleteId, fullName: 'Atleta Webhook', cpf: VALID_CPF });
    seedRegistrationAthleteForTest({
      id: randomUUID(),
      registrationId: regId,
      athleteId,
      role: 'athlete_a',
    });

    const createRes = await request(app)
      .post('/api/v1/payments')
      .set('X-API-Key', apiKey)
      .send({ registrationId: regId });

    expect(createRes.status).toBe(201);
    const { txid, paymentId } = createRes.body;

    const pixItem = {
      endToEndId: 'E2EIDEM1234567890123456789012',
      txid,
      valor: '199.90',
      horario: new Date().toISOString(),
    };

    const first = await request(app).post('/api/v1/webhooks/sicredi/pix').send({ pix: [pixItem] });
    expect(first.status).toBe(200);
    expect(first.body.processed).toBe(1);

    const second = await request(app).post('/api/v1/webhooks/sicredi/pix').send({ pix: [pixItem] });
    expect(second.status).toBe(200);
    expect(second.body.duplicated).toBeGreaterThanOrEqual(1);

    const getRes = await request(app)
      .get(`/api/v1/payments/${paymentId}`)
      .set('X-API-Key', apiKey);
    expect(getRes.body.status).toBe('paid');
  });
});
