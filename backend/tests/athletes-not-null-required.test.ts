import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import {
  clearPaymentMemoryStore,
  paymentRepository,
  seedAthleteForTest,
  seedRegistrationAthleteForTest,
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
import { __testPublicRegistrationMemory } from '../src/services/public/public-registration.service.js';
import { clearRegistrationCreateLocksForTest } from '../src/services/public/registration-duplicate.js';

const CPF_A = '52998224725';
const CPF_B = '39053344705';

function completeAthlete(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Atleta Completo',
    cpf: CPF_A,
    email: 'atleta@example.com',
    phone: '11999999999',
    birthDate: '1990-01-15',
    gender: 'masculino',
    ...overrides,
  };
}

describe('athletes NOT NULL — contrato público', () => {
  let eventId: string;
  let categoryId: string;
  let duplaId: string;

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

    eventId = randomUUID();
    categoryId = randomUUID();
    duplaId = randomUUID();

    seedEventForTest({
      id: eventId,
      slug: `nn-${eventId.slice(0, 8)}`,
      name: 'NOT NULL Test',
      status: 'registration_open',
      isPublic: true,
      registrationStart: new Date(Date.now() - 86400000).toISOString(),
      registrationEnd: new Date(Date.now() + 86400000 * 30).toISOString(),
    });
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'Individual',
      format: 'individual',
      teamSize: 1,
      capacity: 20,
    });
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
      pricePerAthlete: 100,
      categoryIds: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearPaymentMemoryStore();
    clearCatalogMemoryStore();
    clearPublicAccessMemoryStore();
    clearRegistrationCreateLocksForTest();
  });

  async function post(body: Record<string, unknown>) {
    return request(createApp()).post('/api/v1/public/registrations').send({
      eventId,
      categoryId,
      termsAccepted: true,
      privacyAccepted: true,
      ...body,
    });
  }

  it('email ausente → 400 antes de INSERT', async () => {
    const { email: _e, ...rest } = completeAthlete();
    const res = await post({ athletes: [rest] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).toMatch(/e-mail|email/i);
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(0);
  });

  it('email inválido → 400 com mensagem do contrato', async () => {
    const res = await post({
      athletes: [completeAthlete({ email: 'nao-e-email' })],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Informe um e-mail válido para o atleta/i);
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(0);
  });

  it('gender ausente → 400 antes de INSERT', async () => {
    const { gender: _g, ...rest } = completeAthlete();
    const res = await post({ athletes: [rest] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).toMatch(/gênero|genero|gender/i);
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(0);
  });

  it('phone ausente → 400 antes de INSERT', async () => {
    const { phone: _p, ...rest } = completeAthlete();
    const res = await post({ athletes: [rest] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(0);
  });

  it('birthDate ausente → 400 antes de INSERT', async () => {
    const { birthDate: _b, ...rest } = completeAthlete();
    const res = await post({ athletes: [rest] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(0);
  });

  it('todos os NOT NULL ausentes → validação 400', async () => {
    const res = await post({
      athletes: [{ fullName: 'Só Nome', cpf: CPF_A }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(0);
  });

  it('payload completo → cria atleta com email/phone/birthDate/gender', async () => {
    const res = await post({ athletes: [completeAthlete()] });
    expect(res.status).toBe(201);
    const athletes = __testPublicRegistrationMemory.listAthletes();
    expect(athletes).toHaveLength(1);
    expect(athletes[0]?.email).toBe('atleta@example.com');
    expect(athletes[0]?.phone).toBe('11999999999');
    expect(athletes[0]?.birthDate).toBe('1990-01-15');
    expect(athletes[0]?.gender).toBe('masculino');
  });

  it('erro ao criar vínculo/waiver → não deixa registration válida (compensa cancelled)', async () => {
    const spy = vi
      .spyOn(paymentRepository, 'createWaiver')
      .mockRejectedValueOnce(new Error('waiver boom'));

    const res = await post({
      athletes: [completeAthlete()],
      requestId: `fail-waiver-${randomUUID()}`,
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    spy.mockRestore();

    const linked = await paymentRepository.findBlockingRegistrationsForAthletes({
      eventId,
      categoryId,
      athleteCpfs: [CPF_A],
      blockingStatuses: ['draft', 'pending_payment', 'cancelled'],
    });
    expect(linked.every((r) => r.status === 'cancelled')).toBe(true);
    expect(linked.some((r) => r.status === 'draft')).toBe(false);

    const retry = await post({
      athletes: [completeAthlete()],
      requestId: `retry-after-fail-${randomUUID()}`,
    });
    expect(retry.status).toBe(201);
    expect(retry.body.outcome).toBe('NEW_REGISTRATION');
  });

  it('draft técnica (sem waiver) não bloqueia nova inscrição', async () => {
    const athlete = seedAthleteForTest({
      id: randomUUID(),
      cpf: CPF_A,
      fullName: 'Órfão',
      email: 'orfao@example.com',
      phone: '11988887777',
      birthDate: '1991-02-02',
      gender: 'masculino',
    });
    const orphan = seedRegistrationForTest({
      id: randomUUID(),
      eventId,
      categoryId,
      status: 'draft',
      totalPrice: 100,
    });
    seedRegistrationAthleteForTest({
      id: randomUUID(),
      registrationId: orphan.id,
      athleteId: athlete.id,
      role: 'athlete_a',
    });
    // sem waiver → incompleta

    const res = await post({
      athletes: [completeAthlete()],
      requestId: `after-orphan-${randomUUID()}`,
    });
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('NEW_REGISTRATION');
    expect(res.body.registrationId).not.toBe(orphan.id);
  });

  it('pending_payment continua reutilizando', async () => {
    const first = await post({
      athletes: [completeAthlete()],
      requestId: `pending-1-${randomUUID()}`,
    });
    expect(first.status).toBe(201);
    await paymentRepository.updateRegistrationStatus(first.body.registrationId, 'pending_payment');

    const second = await post({
      athletes: [completeAthlete()],
      requestId: `pending-2-${randomUUID()}`,
    });
    expect(second.status).toBe(201);
    expect(second.body.outcome).toBe('REUSED_PENDING_REGISTRATION');
    expect(second.body.registrationId).toBe(first.body.registrationId);
  });

  it('paid continua bloqueando', async () => {
    const first = await post({
      athletes: [completeAthlete()],
      requestId: `paid-1-${randomUUID()}`,
    });
    expect(first.status).toBe(201);
    await paymentRepository.updateRegistrationStatus(first.body.registrationId, 'paid');

    const second = await post({
      athletes: [completeAthlete()],
      requestId: `paid-2-${randomUUID()}`,
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('REGISTRATION_ALREADY_PAID');
  });

  it('fluxo válido chega ao payment mock (Sicredi inalterado)', async () => {
    const reg = await post({
      athletes: [completeAthlete()],
      requestId: `pay-flow-${randomUUID()}`,
    });
    expect(reg.status).toBe(201);
    const pay = await request(createApp())
      .post(`/api/v1/public/registrations/${reg.body.registrationId}/payment`)
      .set('Authorization', `Bearer ${reg.body.registrationAccessToken}`)
      .send({});
    expect(pay.status).toBe(201);
    expect(pay.body.pixCopiaECola).toBeTruthy();
  });

  it('dupla: todos os atletas precisam dos campos NOT NULL', async () => {
    const missing = await post({
      categoryId: duplaId,
      teamName: 'Dupla X',
      athletes: [
        completeAthlete({ cpf: CPF_A }),
        { fullName: 'A2', cpf: CPF_B, gender: 'feminino' },
      ],
    });
    expect(missing.status).toBe(400);
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(0);

    const ok = await post({
      categoryId: duplaId,
      teamName: 'Dupla Ok',
      athletes: [
        completeAthlete({ cpf: CPF_A, email: 'a1@t.com' }),
        completeAthlete({
          cpf: CPF_B,
          fullName: 'A2',
          email: 'a2@t.com',
          gender: 'feminino',
        }),
      ],
    });
    expect(ok.status).toBe(201);
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(2);
  });
});
