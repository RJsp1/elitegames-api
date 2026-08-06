import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import {
  clearPaymentMemoryStore,
  paymentRepository,
  seedRegistrationForTest,
} from '../src/repositories/payment.repository.js';
import {
  clearCatalogMemoryStore,
  seedEventForTest,
  seedCategoryForTest,
  seedPriceBatchForTest,
} from '../src/repositories/catalog.repository.js';
import { clearPublicAccessMemoryStore } from '../src/repositories/registration-access-token.repository.js';
import { clearAuditLogMemoryStore } from '../src/repositories/audit-log.repository.js';
import { clearMockPixStore } from '../src/services/mock/mock-pix.provider.js';
import { resetPaymentProviderCache } from '../src/services/payment/payment-provider.factory.js';

const CPF_A = '52998224725';
const CPF_B = '39053344705';

describe('API pública de inscrição', () => {
  let eventId: string;
  let categoryId: string;
  let slug: string;

  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'test';
    process.env.INTERNAL_API_KEY = 'public-api-test-key';
    resetEnvCache();
    loadEnv();
  });

  beforeEach(() => {
    clearPaymentMemoryStore();
    clearCatalogMemoryStore();
    clearPublicAccessMemoryStore();
    clearAuditLogMemoryStore();
    clearMockPixStore();
    resetPaymentProviderCache();

    eventId = randomUUID();
    categoryId = randomUUID();
    slug = `elite-${eventId.slice(0, 8)}`;

    seedEventForTest({
      id: eventId,
      slug,
      name: 'Elite Games Teste',
      status: 'registration_open',
      isPublic: true,
      registrationStart: new Date(Date.now() - 86400000).toISOString(),
      registrationEnd: new Date(Date.now() + 86400000 * 30).toISOString(),
    });
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'Open Individual',
      format: 'individual',
      teamSize: 1,
      capacity: 10,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Lote teste',
      pricePerAthlete: 199.9,
      categoryIds: null,
      orderIndex: 0,
    });
  });

  afterEach(() => {
    clearPaymentMemoryStore();
    clearCatalogMemoryStore();
    clearPublicAccessMemoryStore();
  });

  async function createRegistration(overrides: Record<string, unknown> = {}) {
    const app = createApp();
    return request(app)
      .post('/api/v1/public/registrations')
      .send({
        eventId,
        categoryId,
        athletes: [{ fullName: 'Atleta A', cpf: CPF_A }],
        termsAccepted: true,
        privacyAccepted: true,
        ...overrides,
      });
  }

  it('evento publicado', async () => {
    const app = createApp();
    const res = await request(app).get(`/api/v1/public/events/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe(slug);
    expect(res.body.name).toBe('Elite Games Teste');
  });

  it('evento não publicado retorna 404', async () => {
    clearCatalogMemoryStore();
    seedEventForTest({
      id: eventId,
      slug,
      name: 'Rascunho',
      status: 'draft',
      isPublic: false,
    });
    const app = createApp();
    const res = await request(app).get(`/api/v1/public/events/${slug}`);
    expect(res.status).toBe(404);
  });

  it('categoria fora do período', async () => {
    clearCatalogMemoryStore();
    seedEventForTest({
      id: eventId,
      slug,
      name: 'Fechado',
      status: 'registration_open',
      isPublic: true,
      registrationStart: new Date(Date.now() + 86400000).toISOString(),
      registrationEnd: new Date(Date.now() + 86400000 * 2).toISOString(),
    });
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'Cat',
      format: 'individual',
      teamSize: 1,
      capacity: 10,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Lote',
      pricePerAthlete: 199.9,
    });

    const res = await createRegistration();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REGISTRATION_CLOSED');
  });

  it('categoria esgotada', async () => {
    clearCatalogMemoryStore();
    clearPaymentMemoryStore();
    seedEventForTest({
      id: eventId,
      slug,
      name: 'Lotado',
      status: 'registration_open',
      isPublic: true,
      registrationStart: new Date(Date.now() - 86400000).toISOString(),
      registrationEnd: new Date(Date.now() + 86400000).toISOString(),
    });
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'Full',
      format: 'individual',
      teamSize: 1,
      capacity: 1,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Lote',
      pricePerAthlete: 199.9,
    });
    seedRegistrationForTest({
      id: randomUUID(),
      eventId,
      categoryId,
      totalPrice: 199.9,
      status: 'pending_payment',
    });

    const res = await createRegistration();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_SOLD_OUT');
  });

  it('valor calculado no servidor', async () => {
    const cats = await request(createApp()).get(`/api/v1/public/events/${slug}/categories`);
    expect(cats.body.categories[0].currentPrice).toBe('199.90');

    const res = await createRegistration({ amount: 1, totalPrice: 1 });
    // strict schema rejeita preço do cliente OU cria com valor do servidor
    if (res.status === 201) {
      expect(res.body.amount).toBe('199.90');
    } else {
      expect(res.status).toBe(400);
    }

    const ok = await createRegistration();
    expect(ok.status).toBe(201);
    expect(ok.body.amount).toBe('199.90');
    expect(ok.body.accessToken).toHaveLength(64);
  });

  it('inscrição individual', async () => {
    const res = await createRegistration();
    expect(res.status).toBe(201);
    expect(res.body.registrationId).toBeTruthy();
    expect(res.body.paymentRequired).toBe(true);
  });

  it('dupla/equipe', async () => {
    const duplaId = randomUUID();
    seedCategoryForTest({
      id: duplaId,
      eventId,
      name: 'Dupla',
      format: 'dupla',
      teamSize: 2,
      capacity: 20,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Lote dupla',
      pricePerAthlete: 199.9,
      categoryIds: [duplaId],
    });

    const res = await createRegistration({
      categoryId: duplaId,
      athletes: [
        { fullName: 'A1', cpf: CPF_A },
        { fullName: 'A2', cpf: CPF_B },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe('399.80');
  });

  it('CPF repetido', async () => {
    const duplaId = randomUUID();
    seedCategoryForTest({
      id: duplaId,
      eventId,
      name: 'Dupla',
      format: 'dupla',
      teamSize: 2,
      capacity: 20,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Lote',
      pricePerAthlete: 199.9,
      categoryIds: [duplaId],
    });
    const res = await createRegistration({
      categoryId: duplaId,
      athletes: [
        { fullName: 'A1', cpf: CPF_A },
        { fullName: 'A2', cpf: CPF_A },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('token inválido e acesso cruzado', async () => {
    const first = await createRegistration();
    const secondCat = randomUUID();
    seedCategoryForTest({
      id: secondCat,
      eventId,
      name: 'Outra',
      format: 'individual',
      teamSize: 1,
      capacity: 5,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Lote 2',
      pricePerAthlete: 199.9,
      categoryIds: [secondCat],
    });
    const second = await createRegistration({
      categoryId: secondCat,
      athletes: [{ fullName: 'Outro', cpf: CPF_B }],
    });

    const app = createApp();
    const invalid = await request(app)
      .post(`/api/v1/public/registrations/${first.body.registrationId}/payment`)
      .set('Authorization', 'Bearer deadbeef');
    expect(invalid.status).toBe(401);

    const cross = await request(app)
      .post(`/api/v1/public/registrations/${first.body.registrationId}/payment`)
      .set('Authorization', `Bearer ${second.body.accessToken}`);
    expect(cross.status).toBe(403);

    const queryToken = await request(app).get(
      `/api/v1/public/payments/${randomUUID()}/status?token=abc`,
    );
    expect(queryToken.status).toBe(400);
  });

  it('criação de cobrança, status pendente, expiração, reemissão, comprovante, idempotência', async () => {
    const created = await createRegistration({ requestId: 'idem-reg-1' });
    expect(created.status).toBe(201);
    const token = created.body.accessToken as string;
    const registrationId = created.body.registrationId as string;

    const again = await createRegistration({ requestId: 'idem-reg-1' });
    expect(again.status).toBe(201);
    expect(again.body.registrationId).toBe(registrationId);

    const app = createApp();
    const pay = await request(app)
      .post(`/api/v1/public/registrations/${registrationId}/payment`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'idem-pay-1');
    expect(pay.status).toBe(201);
    expect(pay.body.pixCopiaECola).toBeTruthy();
    expect(pay.body.paymentId).toBeTruthy();

    const payAgain = await request(app)
      .post(`/api/v1/public/registrations/${registrationId}/payment`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'idem-pay-1');
    expect(payAgain.body.paymentId).toBe(pay.body.paymentId);

    const status = await request(app)
      .get(`/api/v1/public/payments/${pay.body.paymentId}/status`)
      .set('Authorization', `Bearer ${token}`);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('active');
    expect(status.body.canReissue).toBe(false);
    expect(JSON.stringify(status.body)).not.toContain(CPF_A);

    await paymentRepository.updatePaymentStatus(pay.body.paymentId, 'expired');
    await paymentRepository.updateChargeStatus(pay.body.chargeId, 'expired', {
      isCurrent: false,
    });
    await paymentRepository.updateRegistrationStatus(registrationId, 'draft');

    const statusExpired = await request(app)
      .get(`/api/v1/public/payments/${pay.body.paymentId}/status`)
      .set('Authorization', `Bearer ${token}`);
    expect(statusExpired.body.canReissue).toBe(true);

    const reissue = await request(app)
      .post(`/api/v1/public/payments/${pay.body.paymentId}/reissue`)
      .set('Authorization', `Bearer ${token}`);
    expect(reissue.status).toBe(201);
    expect(reissue.body.chargeId).not.toBe(pay.body.chargeId);

    await paymentRepository.updatePaymentStatus(reissue.body.paymentId, 'paid', {
      paidAt: new Date().toISOString(),
      endToEndId: 'E2EPUBLIC123456789012345678901',
    });
    await paymentRepository.updateRegistrationStatus(registrationId, 'paid');

    const statusPaid = await request(app)
      .get(`/api/v1/public/payments/${reissue.body.paymentId}/status`)
      .set('Authorization', `Bearer ${token}`);
    expect(statusPaid.body.status).toBe('paid');

    const receipt = await request(app)
      .get(`/api/v1/public/registrations/${registrationId}/receipt`)
      .set('Authorization', `Bearer ${token}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.athletes[0].cpfMasked).toMatch(/\*/);
    expect(receipt.body.confirmationCodeMasked).toBeTruthy();
  });
});
