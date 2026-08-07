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

import {
  __testPublicRegistrationMemory,
} from '../src/services/public/public-registration.service.js';
import { MAX_SIGNATURE_DATA_URL_LENGTH } from '../src/schemas/public-registration.schema.js';

const CPF_A = '52998224725';
const CPF_B = '39053344705';
const CPF_C = '11144477735';
const CPF_RESP = '85351346893';

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
      slug: 'open-individual',
      name: 'Open Individual',
      format: 'individual',
      teamSize: 1,
      capacity: 10,
      shortDescription: 'Catálogo aberto',
      videoUrls: [
        'https://cdn.example/a.mp4',
        '',
        42,
        '  ',
        'https://cdn.example/b.mp4',
      ] as unknown as string[],
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
        athletes: [{ fullName: 'Atleta A', cpf: CPF_A, gender: 'masculino' }],
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

  it('lista de categorias retorna slug e campos expandidos', async () => {
    const app = createApp();
    const res = await request(app).get(`/api/v1/public/events/${slug}/categories`);
    expect(res.status).toBe(200);
    const cat = res.body.categories[0];
    expect(cat.slug).toBe('open-individual');
    expect(cat.shortDescription).toBe('Catálogo aberto');
    expect(cat.teamSize).toBe(1);
    expect(cat.videoUrls).toEqual([
      'https://cdn.example/a.mp4',
      'https://cdn.example/b.mp4',
    ]);
    expect(cat.categoryId).toBe(categoryId);
    expect(cat.name).toBe('Open Individual');
    expect(cat.currentPrice).toBe('199.90');
  });

  it('videoUrls null vira []', async () => {
    clearCatalogMemoryStore();
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
      slug: 'sem-video',
      name: 'Sem vídeo',
      format: 'individual',
      teamSize: 1,
      capacity: 10,
      videoUrls: null as unknown as string[],
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Lote',
      pricePerAthlete: 199.9,
    });

    const res = await request(createApp()).get(`/api/v1/public/events/${slug}/categories`);
    expect(res.status).toBe(200);
    expect(res.body.categories[0].videoUrls).toEqual([]);
  });

  it('detalhe por slug: preço e ocupação iguais à lista', async () => {
    const app = createApp();
    const list = await request(app).get(`/api/v1/public/events/${slug}/categories`);
    const fromList = list.body.categories[0];

    const detail = await request(app).get(
      `/api/v1/public/events/${slug}/categories/open-individual`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.slug).toBe('open-individual');
    expect(detail.body.currentPrice).toBe(fromList.currentPrice);
    expect(detail.body.occupiedSlots).toBe(fromList.occupiedSlots);
    expect(detail.body.availableSlots).toBe(fromList.availableSlots);
    expect(detail.body.priceBatchId).toBe(fromList.priceBatchId);
    expect(detail.body.teamSize).toBe(fromList.teamSize);
  });

  it('detalhe: categoria de outro evento retorna 404', async () => {
    const otherEvent = randomUUID();
    seedEventForTest({
      id: otherEvent,
      slug: `outro-${otherEvent.slice(0, 8)}`,
      name: 'Outro',
      status: 'registration_open',
      isPublic: true,
      registrationStart: new Date(Date.now() - 86400000).toISOString(),
      registrationEnd: new Date(Date.now() + 86400000).toISOString(),
    });
    seedCategoryForTest({
      id: randomUUID(),
      eventId: otherEvent,
      slug: 'outra-cat',
      name: 'Outra',
      format: 'individual',
      teamSize: 1,
    });

    const res = await request(createApp()).get(
      `/api/v1/public/events/${slug}/categories/outra-cat`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CATEGORY_NOT_FOUND');
  });

  it('detalhe: categoria inativa retorna 404', async () => {
    seedCategoryForTest({
      id: randomUUID(),
      eventId,
      slug: 'inativa',
      name: 'Inativa',
      format: 'individual',
      teamSize: 1,
      isActive: false,
    });
    const res = await request(createApp()).get(
      `/api/v1/public/events/${slug}/categories/inativa`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CATEGORY_NOT_FOUND');
  });

  it('detalhe: categoria deletada retorna 404', async () => {
    seedCategoryForTest({
      id: randomUUID(),
      eventId,
      slug: 'deletada',
      name: 'Deletada',
      format: 'individual',
      teamSize: 1,
      deletedAt: new Date().toISOString(),
    });
    const res = await request(createApp()).get(
      `/api/v1/public/events/${slug}/categories/deletada`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CATEGORY_NOT_FOUND');
  });

  it('valor calculado no servidor', async () => {
    const cats = await request(createApp()).get(`/api/v1/public/events/${slug}/categories`);
    expect(cats.body.categories[0].currentPrice).toBe('199.90');

    const res = await createRegistration({ amount: 1, totalPrice: 1, price: 9, priceCents: 1 });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe('199.90');
    expect(res.body.registrationAccessToken).toHaveLength(64);
    expect(res.body.accessToken).toBeUndefined();

    const ok = await createRegistration();
    expect(ok.status).toBe(201);
    expect(ok.body.amount).toBe('199.90');
    expect(ok.body.registrationAccessToken).toHaveLength(64);
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
        { fullName: 'A1', cpf: CPF_A, gender: 'masculino' },
        { fullName: 'A2', cpf: CPF_B, gender: 'feminino' },
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
        { fullName: 'A1', cpf: CPF_A, gender: 'masculino' },
        { fullName: 'A2', cpf: CPF_A, gender: 'masculino' },
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
      athletes: [{ fullName: 'Outro', cpf: CPF_B, gender: 'masculino' }],
    });

    const app = createApp();
    const invalid = await request(app)
      .post(`/api/v1/public/registrations/${first.body.registrationId}/payment`)
      .set('Authorization', 'Bearer deadbeef');
    expect(invalid.status).toBe(401);

    const cross = await request(app)
      .post(`/api/v1/public/registrations/${first.body.registrationId}/payment`)
      .set('Authorization', `Bearer ${second.body.registrationAccessToken}`);
    expect(cross.status).toBe(403);

    const queryToken = await request(app).get(
      `/api/v1/public/payments/${randomUUID()}/status?token=abc`,
    );
    expect(queryToken.status).toBe(400);
  });

  it('criação de cobrança, status pendente, expiração, reemissão, comprovante, idempotência', async () => {
    const created = await createRegistration({ requestId: 'idem-reg-1' });
    expect(created.status).toBe(201);
    const token = created.body.registrationAccessToken as string;
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

  describe('contrato Elite CDT', () => {
    function seedDupla() {
      const duplaId = randomUUID();
      seedCategoryForTest({
        id: duplaId,
        eventId,
        name: 'Dupla Elite',
        format: 'dupla',
        teamSize: 2,
        capacity: 40,
      });
      seedPriceBatchForTest({
        id: randomUUID(),
        eventId,
        name: 'Lote dupla elite',
        pricePerAthlete: 199.9,
        categoryIds: [duplaId],
      });
      return duplaId;
    }

    function seedEquipe(teamSize: number) {
      const equipeId = randomUUID();
      seedCategoryForTest({
        id: equipeId,
        eventId,
        name: 'Equipe Elite',
        format: 'equipe',
        teamSize,
        capacity: 40,
      });
      // Usa o lote do beforeEach (199.90, categoryIds null) — evita lote concorrente flaky.
      return equipeId;
    }

    it('individual com 1 atleta completo', async () => {
      const res = await createRegistration({
        athletes: [
          {
            fullName: 'Maria Silva',
            cpf: CPF_A,
            email: 'maria@example.com',
            phone: '11999999999',
            birthDate: '1995-05-10',
            gender: 'feminino',
            shirtSize: 'M',
            emergencyName: 'Ana',
            emergencyPhone: '11988887777',
            medicalNotes: 'asma leve',
          },
        ],
        teamName: 'Ignorar este nome',
        responsible: {
          isAthlete1: true,
          fullName: 'Maria Silva',
          cpf: CPF_A,
          email: 'maria@example.com',
          phone: '11999999999',
        },
        waiver: {
          regulationAccepted: true,
          privacyAccepted: true,
          imageUseAccepted: true,
          fitnessAccepted: true,
          signatureDataUrl: 'data:image/png;base64,abc',
        },
        termsAccepted: undefined,
        privacyAccepted: undefined,
      });
      expect(res.status).toBe(201);
      expect(res.body.registrationAccessToken).toBeTruthy();
      expect(__testPublicRegistrationMemory.listTeams()).toHaveLength(0);
      expect(__testPublicRegistrationMemory.listGuardians()).toHaveLength(0);
      const athletes = __testPublicRegistrationMemory.listAthletes();
      expect(athletes).toHaveLength(1);
      expect(athletes[0]?.email).toBe('maria@example.com');
      expect(athletes[0]?.medicalRestrictions).toBe('asma leve');
      expect(athletes[0]?.emergencyName).toBe('Ana');
      const waivers = __testPublicRegistrationMemory.listWaivers();
      expect(waivers).toHaveLength(1);
      expect(waivers[0]?.regulationAccepted).toBe(true);
      expect(waivers[0]?.lgpdAccepted).toBe(true);
      expect(waivers[0]?.imageUseAccepted).toBe(true);
      expect(waivers[0]?.fitnessDeclarationAccepted).toBe(true);
      expect(waivers[0]?.signatureUrl).toBe('data:image/png;base64,abc');
    });

    it('dupla com 2 atletas e teamName', async () => {
      const duplaId = seedDupla();
      const res = await createRegistration({
        categoryId: duplaId,
        teamName: 'Time Relâmpago',
        athletes: [
          { fullName: 'A1', cpf: CPF_A, phone: '11911112222', gender: 'masculino' },
          { fullName: 'A2', cpf: CPF_B, phone: '11933334444', gender: 'feminino' },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.amount).toBe('399.80');
      const teams = __testPublicRegistrationMemory.listTeams();
      expect(teams).toHaveLength(1);
      expect(teams[0]?.name).toBe('Time Relâmpago');
      const reg = await paymentRepository.findRegistrationById(res.body.registrationId);
      expect(reg?.teamId).toBe(teams[0]?.id);
    });

    it('equipe conforme team_size do banco', async () => {
      const equipeId = seedEquipe(3);
      const ok = await createRegistration({
        categoryId: equipeId,
        teamName: 'Trio Elite',
        teamSize: 99,
        categoryFormat: 'individual',
        athletes: [
          { fullName: 'A1', cpf: CPF_A, gender: 'masculino' },
          { fullName: 'A2', cpf: CPF_B, gender: 'feminino' },
          { fullName: 'A3', cpf: CPF_C, gender: 'outro' },
        ],
      });
      expect(ok.status).toBe(201);
      // Lote vigente do evento (beforeEach): 199.90 × team_size 3
      expect(ok.body.amount).toBe('599.70');
      expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(3);
      expect(__testPublicRegistrationMemory.listTeams()).toHaveLength(1);
    });

    it('quantidade inferior bloqueada', async () => {
      const duplaId = seedDupla();
      const res = await createRegistration({
        categoryId: duplaId,
        athletes: [{ fullName: 'A1', cpf: CPF_A, gender: 'masculino' }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ATHLETE_COUNT');
    });

    it('quantidade superior bloqueada', async () => {
      const equipeId = seedEquipe(2);
      const res = await createRegistration({
        categoryId: equipeId,
        athletes: [
          { fullName: 'A1', cpf: CPF_A, gender: 'masculino' },
          { fullName: 'A2', cpf: CPF_B, gender: 'feminino' },
          { fullName: 'A3', cpf: CPF_C, gender: 'outro' },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ATHLETE_COUNT');
    });

    it('CPF duplicado bloqueado', async () => {
      const duplaId = seedDupla();
      const res = await createRegistration({
        categoryId: duplaId,
        athletes: [
          { fullName: 'A1', cpf: CPF_A, gender: 'masculino' },
          { fullName: 'A2', cpf: CPF_A, gender: 'masculino' },
        ],
      });
      expect(res.status).toBe(400);
    });

    it('responsável = Atleta 1 não cria guardian', async () => {
      const res = await createRegistration({
        responsible: {
          isAthlete1: true,
          fullName: 'Atleta A',
          cpf: CPF_A,
          email: 'a@example.com',
          phone: '11999999999',
        },
      });
      expect(res.status).toBe(201);
      expect(__testPublicRegistrationMemory.listGuardians()).toHaveLength(0);
    });

    it('responsável externo cria guardian', async () => {
      const res = await createRegistration({
        responsible: {
          isAthlete1: false,
          fullName: 'Responsável Externo',
          cpf: CPF_RESP,
          email: 'resp@example.com',
          phone: '11977776666',
        },
      });
      expect(res.status).toBe(201);
      const guardians = __testPublicRegistrationMemory.listGuardians();
      expect(guardians).toHaveLength(1);
      expect(guardians[0]?.fullName).toBe('Responsável Externo');
      expect(guardians[0]?.cpf).toBe(CPF_RESP);
    });

    it('teamName ignorado em individual', async () => {
      const res = await createRegistration({ teamName: 'Não deve criar' });
      expect(res.status).toBe(201);
      expect(__testPublicRegistrationMemory.listTeams()).toHaveLength(0);
      const reg = await paymentRepository.findRegistrationById(res.body.registrationId);
      expect(reg?.teamId).toBeNull();
    });

    it('assinatura grande bloqueada', async () => {
      const huge = `data:image/png;base64,${'a'.repeat(MAX_SIGNATURE_DATA_URL_LENGTH + 1)}`;
      const res = await createRegistration({
        waiver: {
          regulationAccepted: true,
          privacyAccepted: true,
          imageUseAccepted: true,
          fitnessAccepted: true,
          signatureDataUrl: huge,
        },
      });
      expect(res.status).toBe(400);
    });

    it('idempotência não duplica atletas, equipe nem waiver', async () => {
      const duplaId = seedDupla();
      const body = {
        categoryId: duplaId,
        teamName: 'Idem Team',
        requestId: 'idem-elite-cdt-registration-001',
        athletes: [
          { fullName: 'A1', cpf: CPF_A, email: 'a1@example.com', gender: 'masculino' },
          { fullName: 'A2', cpf: CPF_B, gender: 'feminino' },
        ],
        responsible: {
          isAthlete1: false,
          fullName: 'Resp',
          cpf: CPF_RESP,
          phone: '11955554444',
        },
        waiver: {
          regulationAccepted: true,
          privacyAccepted: true,
          imageUseAccepted: true,
          fitnessAccepted: true,
          signatureDataUrl: 'data:image/png;base64,xyz',
        },
      };

      const first = await createRegistration(body);
      expect(first.status).toBe(201);

      const second = await createRegistration(body);
      expect(second.status).toBe(201);
      expect(second.body.registrationId).toBe(first.body.registrationId);
      expect(second.body.registrationAccessToken).toBe(first.body.registrationAccessToken);

      expect(__testPublicRegistrationMemory.listAthletes()).toHaveLength(2);
      expect(__testPublicRegistrationMemory.listTeams()).toHaveLength(1);
      expect(__testPublicRegistrationMemory.listWaivers()).toHaveLength(1);
      expect(__testPublicRegistrationMemory.listGuardians()).toHaveLength(1);

      const viaHeader = await request(createApp())
        .post('/api/v1/public/registrations')
        .set('Idempotency-Key', 'idem-elite-cdt-via-header-002')
        .send({
          eventId,
          categoryId: duplaId,
          athletes: [
            { fullName: 'B1', cpf: CPF_C, gender: 'masculino' },
            { fullName: 'B2', cpf: CPF_RESP, gender: 'feminino' },
          ],
          teamName: 'Header Team',
          termsAccepted: true,
          privacyAccepted: true,
        });
      expect(viaHeader.status).toBe(201);

      const retryHeader = await request(createApp())
        .post('/api/v1/public/registrations')
        .set('Idempotency-Key', 'idem-elite-cdt-via-header-002')
        .send({
          eventId,
          categoryId: duplaId,
          athletes: [
            { fullName: 'B1', cpf: CPF_C, gender: 'masculino' },
            { fullName: 'B2', cpf: CPF_RESP, gender: 'feminino' },
          ],
          teamName: 'Header Team',
          termsAccepted: true,
          privacyAccepted: true,
        });
      expect(retryHeader.status).toBe(201);
      expect(retryHeader.body.registrationId).toBe(viaHeader.body.registrationId);
      expect(__testPublicRegistrationMemory.listTeams()).toHaveLength(2);
    });
  });
});
