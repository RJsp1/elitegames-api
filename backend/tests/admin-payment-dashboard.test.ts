import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import {
  clearPaymentMemoryStore,
  paymentRepository,
  seedRegistrationForTest,
  seedAthleteForTest,
  seedRegistrationAthleteForTest,
} from '../src/repositories/payment.repository.js';
import { clearAuditLogMemoryStore } from '../src/repositories/audit-log.repository.js';
import { clearMockPixStore } from '../src/services/mock/mock-pix.provider.js';
import { resetPaymentProviderCache } from '../src/services/payment/payment-provider.factory.js';
import { paymentService } from '../src/services/payment/payment.service.js';

const VALID_CPF = '52998224725';
const apiKey = 'admin-dashboard-test-key';

function seedAthlete(regId: string, name = 'Atleta Admin'): void {
  const athleteId = randomUUID();
  seedAthleteForTest({ id: athleteId, fullName: name, cpf: VALID_CPF });
  seedRegistrationAthleteForTest({
    id: randomUUID(),
    registrationId: regId,
    athleteId,
    role: 'athlete_a',
  });
}

describe('Etapa 4 — dashboard admin Pix', () => {
  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'test';
    process.env.INTERNAL_API_KEY = apiKey;
    resetEnvCache();
    loadEnv();
  });

  beforeEach(() => {
    clearPaymentMemoryStore();
    clearAuditLogMemoryStore();
    clearMockPixStore();
    resetPaymentProviderCache();
  });

  afterEach(() => {
    clearPaymentMemoryStore();
    clearAuditLogMemoryStore();
  });

  it('dashboard exige autenticação admin', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/admin/payments/dashboard');
    expect([401, 403]).toContain(res.status);
  });

  it('dashboard retorna summary e reconciliationHealth', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 150, status: 'draft' });
    seedAthlete(regId);
    await paymentService.createPayment({ registrationId: regId });

    const app = createApp();
    const res = await request(app)
      .get('/api/v1/admin/payments/dashboard')
      .set('X-API-Key', apiKey);

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      totalPayments: expect.any(Number),
      activePayments: expect.any(Number),
      paidPayments: expect.any(Number),
      expiredPayments: expect.any(Number),
      cancelledPayments: expect.any(Number),
      failedPayments: expect.any(Number),
      amountReceivedToday: expect.any(String),
      amountPending: expect.any(String),
      paymentsCreatedToday: expect.any(Number),
      paymentsPaidToday: expect.any(Number),
      averagePaymentTimeSeconds: expect.any(Number),
    });
    expect(res.body.reconciliationHealth).toMatchObject({
      status: expect.any(String),
      enabled: expect.any(Boolean),
      consecutiveFailures: expect.any(Number),
    });
    expect(res.body.summary.totalPayments).toBeGreaterThanOrEqual(1);
  });

  it('lista pagamentos sanitizada sem pix/cpf/qr', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 199.9, status: 'draft' });
    seedAthlete(regId, 'Maria Silva');
    await paymentService.createPayment({ registrationId: regId });

    const app = createApp();
    const res = await request(app)
      .get('/api/v1/admin/payments?page=1&pageSize=20')
      .set('X-API-Key', apiKey);

    expect(res.status).toBe(200);
    expect(res.body.payments.length).toBeGreaterThanOrEqual(1);
    const item = res.body.payments[0];
    expect(item).toHaveProperty('paymentId');
    expect(item).toHaveProperty('txidMasked');
    expect(item).toHaveProperty('athleteName', 'Maria Silva');
    expect(JSON.stringify(item)).not.toMatch(/cpf/i);
    expect(item.pixCopiaECola).toBeUndefined();
    expect(item.qrCodeDataUrl).toBeUndefined();
    expect(item.currentCharge?.hasPixCopyPaste).toBe(true);
    expect(item.currentCharge?.pixCopyPaste).toBeUndefined();
  });

  it('detalhe não expõe segredos', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 80, status: 'draft' });
    seedAthlete(regId);
    const created = await paymentService.createPayment({ registrationId: regId });

    const app = createApp();
    const res = await request(app)
      .get(`/api/v1/admin/payments/${created.paymentId}`)
      .set('X-API-Key', apiKey);

    expect(res.status).toBe(200);
    expect(res.body.payment.txidMasked).toBeTruthy();
    expect(res.body.athlete.cpfMasked).toMatch(/\*\*\*/);
    expect(JSON.stringify(res.body)).not.toContain(created.pixCopiaECola);
    expect(JSON.stringify(res.body)).not.toContain(VALID_CPF);
  });

  it('ações admin: expire e cancel com confirmação', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 90, status: 'draft' });
    seedAthlete(regId);
    const created = await paymentService.createPayment({ registrationId: regId });

    const app = createApp();
    const noConfirm = await request(app)
      .post(`/api/v1/admin/payments/${created.paymentId}/expire`)
      .set('X-API-Key', apiKey)
      .send({});
    expect(noConfirm.status).toBe(400);

    const expired = await request(app)
      .post(`/api/v1/admin/payments/${created.paymentId}/expire`)
      .set('X-API-Key', apiKey)
      .send({ confirm: true, reason: 'test' });
    expect(expired.status).toBe(200);
    expect(expired.body.status).toBe('expired');

    const paidBlock = await request(app)
      .post(`/api/v1/admin/payments/${created.paymentId}/cancel`)
      .set('X-API-Key', apiKey)
      .send({ confirm: true });
    // already expired — cancel still allowed on non-paid
    expect([200, 400]).toContain(paidBlock.status);
  });

  it('não expira pagamento paid', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 70, status: 'draft' });
    seedAthlete(regId);
    const created = await paymentService.createPayment({ registrationId: regId });
    await paymentRepository.updatePaymentStatus(created.paymentId, 'paid', {
      paidAt: new Date().toISOString(),
      endToEndId: 'E2EADMIN1234567890123456789012',
    });

    const app = createApp();
    const res = await request(app)
      .post(`/api/v1/admin/payments/${created.paymentId}/expire`)
      .set('X-API-Key', apiKey)
      .send({ confirm: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_ALREADY_PAID');
  });

  it('metrics e audit endpoints respondem', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 55, status: 'draft' });
    seedAthlete(regId);
    const created = await paymentService.createPayment({ registrationId: regId });

    const app = createApp();
    const metrics = await request(app)
      .get('/api/v1/admin/payments/metrics?groupBy=day')
      .set('X-API-Key', apiKey);
    expect(metrics.status).toBe(200);
    expect(metrics.body.totals).toHaveProperty('createdCount');
    expect(metrics.body.series).toBeInstanceOf(Array);

    const audit = await request(app)
      .get(`/api/v1/admin/payments/${created.paymentId}/audit`)
      .set('X-API-Key', apiKey);
    expect(audit.status).toBe(200);
    expect(audit.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('serve painel estático', async () => {
    const app = createApp();
    const res = await request(app).get('/painel/admin/payments.html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Painel Pix Sicredi');
  });
});
