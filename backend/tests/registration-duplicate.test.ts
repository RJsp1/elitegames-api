import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import {
  clearPaymentMemoryStore,
  paymentRepository,
  setExpireRegistrationMode,
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
import { clearRegistrationCreateLocksForTest } from '../src/services/public/registration-duplicate.js';
import { paymentService } from '../src/services/payment/payment.service.js';
import { resolveConfiguredProviderName } from '../src/services/payment/payment-provider.selection.js';

const CPF_A = '52998224725';
const CPF_B = '39053344705';
const CPF_C = '11144477735';

describe('Anti-duplicidade inscrição + PIX', () => {
  let eventId: string;
  let categoryId: string;
  let otherCategoryId: string;
  let otherEventId: string;
  let otherEventCategoryId: string;

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
    clearRegistrationCreateLocksForTest();
    resetPaymentProviderCache();
    setExpireRegistrationMode('draft');

    eventId = randomUUID();
    categoryId = randomUUID();
    otherCategoryId = randomUUID();
    otherEventId = randomUUID();
    otherEventCategoryId = randomUUID();

    seedEventForTest({
      id: eventId,
      slug: `elite-${eventId.slice(0, 8)}`,
      name: 'Elite Games',
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
      capacity: 50,
    });
    seedCategoryForTest({
      id: otherCategoryId,
      eventId,
      name: 'Outra Cat',
      format: 'individual',
      teamSize: 1,
      capacity: 50,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Lote',
      pricePerAthlete: 199.9,
      categoryIds: null,
    });

    seedEventForTest({
      id: otherEventId,
      slug: `other-${otherEventId.slice(0, 8)}`,
      name: 'Outro Evento',
      status: 'registration_open',
      isPublic: true,
      registrationStart: new Date(Date.now() - 86400000).toISOString(),
      registrationEnd: new Date(Date.now() + 86400000 * 30).toISOString(),
    });
    seedCategoryForTest({
      id: otherEventCategoryId,
      eventId: otherEventId,
      name: 'Individual Outro',
      format: 'individual',
      teamSize: 1,
      capacity: 50,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId: otherEventId,
      name: 'Lote outro',
      pricePerAthlete: 150,
      categoryIds: null,
    });
  });

  afterEach(() => {
    clearPaymentMemoryStore();
    clearCatalogMemoryStore();
    clearPublicAccessMemoryStore();
    clearRegistrationCreateLocksForTest();
  });

  function athlete(cpf = CPF_A, name = 'Atleta A') {
    return { fullName: name, cpf, email: `${cpf}@t.com`, phone: '11999999999' };
  }

  async function postRegistration(overrides: Record<string, unknown> = {}) {
    const app = createApp();
    return request(app)
      .post('/api/v1/public/registrations')
      .send({
        eventId,
        categoryId,
        athletes: [athlete()],
        termsAccepted: true,
        privacyAccepted: true,
        waiver: {
          regulationAccepted: true,
          privacyAccepted: true,
          imageUseAccepted: true,
          fitnessAccepted: true,
          signatureDataUrl: 'data:image/png;base64,aa',
        },
        ...overrides,
      });
  }

  async function postPayment(registrationId: string, token: string, requestId?: string) {
    const app = createApp();
    const req = request(app)
      .post(`/api/v1/public/registrations/${registrationId}/payment`)
      .set('Authorization', `Bearer ${token}`);
    if (requestId) req.set('X-Request-Id', requestId);
    return req.send({});
  }

  it('1) primeira inscrição cria registration + payment mock (não manual_pix)', async () => {
    expect(resolveConfiguredProviderName()).toBe('mock');
    const reg = await postRegistration({ requestId: `dup-first-1-${randomUUID()}` });
    expect(reg.status).toBe(201);
    expect(reg.body.outcome).toBe('NEW_REGISTRATION');
    expect(reg.body.registrationId).toBeTruthy();

    const pay = await postPayment(
      reg.body.registrationId,
      reg.body.registrationAccessToken,
      `pay-first-1-${randomUUID()}`,
    );
    expect(pay.status).toBe(201);
    expect(pay.body.outcome).toBe('NEW_PAYMENT');
    expect(pay.body.pixCopiaECola).toBeTruthy();
    expect(pay.body.status).toBe('active');

    const payment = await paymentRepository.findPaymentById(pay.body.paymentId);
    const provider = await paymentRepository.findProviderById(payment!.providerId);
    expect(provider?.code).not.toBe('manual_pix');
    expect(['mock', 'sicredi']).toContain(provider?.code);
  });

  it('2) double submit mesmo requestId → uma única registration', async () => {
    const rid = `idem-same-cpf-1-${randomUUID()}`;
    const a = await postRegistration({ requestId: rid });
    const b = await postRegistration({ requestId: rid });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.registrationId).toBe(a.body.registrationId);
  });

  it('3) segunda tentativa com PIX active → reutiliza inscrição e cobrança', async () => {
    const first = await postRegistration({ requestId: `reuse-reg-1-${randomUUID()}` });
    expect(first.status).toBe(201);
    const pay1 = await postPayment(
      first.body.registrationId,
      first.body.registrationAccessToken,
      `reuse-pay-1-${randomUUID()}`,
    );
    expect(pay1.status).toBe(201);
    expect(pay1.body.status).toBe('active');

    const second = await postRegistration({ requestId: `reuse-reg-2-${randomUUID()}` });
    expect(second.status).toBe(201);
    expect(second.body.outcome).toBe('REUSED_PENDING_REGISTRATION');
    expect(second.body.registrationId).toBe(first.body.registrationId);

    const pay2 = await postPayment(
      second.body.registrationId,
      second.body.registrationAccessToken,
      `reuse-pay-2-${randomUUID()}`,
    );
    expect(pay2.status).toBe(201);
    expect(pay2.body.outcome).toBe('REUSED_ACTIVE_CHARGE');
    expect(pay2.body.paymentId).toBe(pay1.body.paymentId);
    expect(pay2.body.pixCopiaECola).toBe(pay1.body.pixCopiaECola);
  });

  it('4) PIX expirado → mesma registration + nova charge', async () => {
    const first = await postRegistration({ requestId: `exp-reg-1-${randomUUID()}` });
    expect(first.status).toBe(201);
    const pay1 = await postPayment(
      first.body.registrationId,
      first.body.registrationAccessToken,
      `exp-pay-1-${randomUUID()}`,
    );
    expect(pay1.status).toBe(201);

    const past = new Date(Date.now() - 60_000).toISOString();
    await paymentRepository.updatePaymentStatus(pay1.body.paymentId, 'expired', {
      expiresAt: past,
    });
    await paymentRepository.updateChargeStatus(pay1.body.chargeId, 'expired', {
      isCurrent: false,
      expiresAt: past,
    });
    await paymentRepository.updateRegistrationStatus(first.body.registrationId, 'draft');

    const second = await postRegistration({ requestId: `exp-reg-2-${randomUUID()}` });
    expect(second.body.outcome).toBe('REUSED_PENDING_REGISTRATION');
    expect(second.body.registrationId).toBe(first.body.registrationId);

    const pay2 = await postPayment(
      second.body.registrationId,
      second.body.registrationAccessToken,
      `exp-pay-2-${randomUUID()}`,
    );
    expect(pay2.body.outcome).toBe('NEW_PAYMENT');
    expect(pay2.body.paymentId).not.toBe(pay1.body.paymentId);
    expect(pay2.body.registrationId).toBe(first.body.registrationId);

    const old = await paymentRepository.findPaymentById(pay1.body.paymentId);
    expect(old?.status).toBe('expired');
  });

  it('5) registration paid → bloqueia nova inscrição', async () => {
    const first = await postRegistration({ requestId: `paid-reg-1-${randomUUID()}` });
    expect(first.status).toBe(201);
    const pay = await postPayment(
      first.body.registrationId,
      first.body.registrationAccessToken,
      `paid-pay-1-${randomUUID()}`,
    );
    expect(pay.status).toBe(201);
    await paymentService.simulatePaid(pay.body.paymentId);

    const second = await postRegistration({ requestId: `paid-reg-2-${randomUUID()}` });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('REGISTRATION_ALREADY_PAID');
    expect(second.body.error.details.registrationId).toBe(first.body.registrationId);
    expect(second.body.error.message).toMatch(/confirmada/i);
  });

  it('6) payment paid → registration paid', async () => {
    const first = await postRegistration({ requestId: `liq-1-${randomUUID()}` });
    expect(first.status).toBe(201);
    const pay = await postPayment(
      first.body.registrationId,
      first.body.registrationAccessToken,
      `liq-pay-1-${randomUUID()}`,
    );
    expect(pay.status).toBe(201);
    expect(pay.body.paymentId).toBeTruthy();
    await paymentService.simulatePaid(pay.body.paymentId);
    const reg = await paymentRepository.findRegistrationById(first.body.registrationId);
    const payment = await paymentRepository.findPaymentById(pay.body.paymentId);
    expect(reg?.status).toBe('paid');
    expect(payment?.status).toBe('paid');
  });

  it('7) duas charges históricas, uma paga → cancela irmã active', async () => {
    const first = await postRegistration({ requestId: `sib-1-${randomUUID()}` });
    expect(first.status).toBe(201);
    const pay1 = await postPayment(
      first.body.registrationId,
      first.body.registrationAccessToken,
      `sib-pay-1-${randomUUID()}`,
    );
    expect(pay1.status).toBe(201);
    // força segunda payment ativa “irmã” (simula legado)
    const past = new Date(Date.now() - 60_000).toISOString();
    await paymentRepository.updatePaymentStatus(pay1.body.paymentId, 'expired', {
      expiresAt: past,
    });
    await paymentRepository.updateChargeStatus(pay1.body.chargeId, 'expired', {
      isCurrent: false,
    });
    await paymentRepository.updateRegistrationStatus(first.body.registrationId, 'draft');

    const pay2 = await postPayment(
      first.body.registrationId,
      first.body.registrationAccessToken,
      `sib-pay-2-${randomUUID()}`,
    );
    expect(pay2.status).toBe(201);
    expect(pay2.body.paymentId).not.toBe(pay1.body.paymentId);

    // reativa pay1 como active indevida (cenário legado)
    await paymentRepository.updatePaymentStatus(pay1.body.paymentId, 'active');
    await paymentRepository.updateChargeStatus(pay1.body.chargeId, 'active', {
      isCurrent: false,
    });

    await paymentService.simulatePaid(pay2.body.paymentId);

    const sibling = await paymentRepository.findPaymentById(pay1.body.paymentId);
    const paid = await paymentRepository.findPaymentById(pay2.body.paymentId);
    expect(paid?.status).toBe('paid');
    expect(sibling?.status).toBe('cancelled');

    const open = await paymentService.findOpenCurrentChargeForRegistration(
      first.body.registrationId,
    );
    expect(open).toBeNull();
  });

  it('8) categorias diferentes → inscrição permitida', async () => {
    const a = await postRegistration({
      requestId: `cat-a-${randomUUID()}`,
      categoryId,
    });
    expect(a.status).toBe(201);
    expect(a.body.outcome).toBe('NEW_REGISTRATION');
    const b = await postRegistration({
      requestId: `cat-b-${randomUUID()}`,
      categoryId: otherCategoryId,
    });
    expect(b.status).toBe(201);
    expect(b.body.outcome).toBe('NEW_REGISTRATION');
    expect(b.body.registrationId).not.toBe(a.body.registrationId);
  });

  it('9) eventos diferentes → inscrição permitida', async () => {
    const a = await postRegistration({ requestId: `evt-a-${randomUUID()}` });
    expect(a.status).toBe(201);
    const b = await postRegistration({
      requestId: `evt-b-${randomUUID()}`,
      eventId: otherEventId,
      categoryId: otherEventCategoryId,
    });
    expect(b.status).toBe(201);
    expect(b.body.outcome).toBe('NEW_REGISTRATION');
    expect(b.body.registrationId).not.toBe(a.body.registrationId);
  });

  it('10) dupla/equipe — qualquer atleta já inscrito bloqueia/reutiliza', async () => {
    const duplaId = randomUUID();
    seedCategoryForTest({
      id: duplaId,
      eventId,
      name: 'Dupla',
      format: 'dupla',
      teamSize: 2,
      capacity: 40,
    });

    const first = await postRegistration({
      requestId: `dupla-1-${randomUUID()}`,
      categoryId: duplaId,
      teamName: 'Time 1',
      athletes: [athlete(CPF_A, 'A1'), athlete(CPF_B, 'A2')],
    });
    expect(first.status).toBe(201);
    expect(first.body.outcome).toBe('NEW_REGISTRATION');

    // Novo time com CPF_B (já na dupla) + CPF_C
    const second = await postRegistration({
      requestId: `dupla-2-${randomUUID()}`,
      categoryId: duplaId,
      teamName: 'Time 2',
      athletes: [athlete(CPF_C, 'C1'), athlete(CPF_B, 'B2')],
    });
    expect(second.status).toBe(201);
    expect(second.body.outcome).toBe('REUSED_PENDING_REGISTRATION');
    expect(second.body.registrationId).toBe(first.body.registrationId);
  });

  it('11) concorrência — dois requestIds distintos, mesmo CPF → uma registration', async () => {
    const [a, b] = await Promise.all([
      postRegistration({ requestId: `conc-a-${randomUUID()}` }),
      postRegistration({ requestId: `conc-b-${randomUUID()}` }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const ids = new Set([a.body.registrationId, b.body.registrationId]);
    expect(ids.size).toBe(1);
    const outcomes = [a.body.outcome, b.body.outcome];
    expect(outcomes).toContain('NEW_REGISTRATION');
    expect(outcomes).toContain('REUSED_PENDING_REGISTRATION');
  });

  it('12) nenhum fluxo usa manual_pix', async () => {
    expect(resolveConfiguredProviderName()).toBe('mock');
    const reg = await postRegistration({ requestId: `prov-1-${randomUUID()}` });
    expect(reg.status).toBe(201);
    const pay = await postPayment(
      reg.body.registrationId,
      reg.body.registrationAccessToken,
      `prov-pay-1-${randomUUID()}`,
    );
    expect(pay.status).toBe(201);
    const payment = await paymentRepository.findPaymentById(pay.body.paymentId);
    const provider = await paymentRepository.findProviderById(payment!.providerId);
    expect(provider?.code).toBe('mock');
  });
});
