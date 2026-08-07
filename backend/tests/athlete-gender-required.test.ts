import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { clearPaymentMemoryStore } from '../src/repositories/payment.repository.js';
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

const CPF_A = '52998224725';
const CPF_B = '39053344705';

function athlete(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Com Gender',
    cpf: CPF_A,
    email: 'a@example.com',
    phone: '11999999999',
    birthDate: '1990-01-01',
    gender: 'masculino',
    ...overrides,
  };
}

describe('athletes.gender obrigatório', () => {
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
    resetPaymentProviderCache();

    eventId = randomUUID();
    categoryId = randomUUID();
    duplaId = randomUUID();

    seedEventForTest({
      id: eventId,
      slug: `g-${eventId.slice(0, 8)}`,
      name: 'Gender Test',
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
    clearPaymentMemoryStore();
    clearCatalogMemoryStore();
    clearPublicAccessMemoryStore();
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

  it('atleta sem gender → 400 VALIDATION_ERROR, sem INSERT', async () => {
    const { gender: _g, ...rest } = athlete();
    const res = await post({ athletes: [rest] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).toMatch(/gênero|genero|gender/i);
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(0);
  });

  it('gender vazio → 400', async () => {
    const res = await post({
      athletes: [athlete({ gender: '   ' })],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(0);
  });

  it('gender válido → cria atleta', async () => {
    const res = await post({
      athletes: [athlete()],
    });
    expect(res.status).toBe(201);
    const athletes = __testPublicRegistrationMemory.listAthletes();
    expect(athletes).toHaveLength(1);
    expect(athletes[0]?.gender).toBe('masculino');
  });

  it('dupla: todos os atletas precisam de gender', async () => {
    const incomplete = athlete({ cpf: CPF_B, fullName: 'A2', email: 'b@example.com' });
    delete (incomplete as { gender?: string }).gender;
    const missing = await post({
      categoryId: duplaId,
      teamName: 'Dupla X',
      athletes: [athlete({ cpf: CPF_A }), incomplete],
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(0);

    const ok = await post({
      categoryId: duplaId,
      teamName: 'Dupla Ok',
      athletes: [
        athlete({ cpf: CPF_A }),
        athlete({
          cpf: CPF_B,
          fullName: 'A2',
          email: 'b@example.com',
          gender: 'feminino',
        }),
      ],
    });
    expect(ok.status).toBe(201);
    expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(2);
  });
});
