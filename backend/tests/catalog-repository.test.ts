import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  clearCatalogMemoryStore,
  seedEventForTest,
  seedCategoryForTest,
  seedPriceBatchForTest,
  catalogRepository,
  calculatePriceCentsFromBatch,
  selectCurrentPriceBatch,
  isEventPubliclyEligible,
  normalizeVideoUrls,
} from '../src/repositories/catalog.repository.js';
import {
  clearPaymentMemoryStore,
  paymentRepository,
  seedRegistrationForTest,
} from '../src/repositories/payment.repository.js';

describe('catalog.repository — schema Lovable', () => {
  beforeEach(() => {
    clearCatalogMemoryStore();
    clearPaymentMemoryStore();
  });

  it('status registration_open retorna evento público', async () => {
    const id = randomUUID();
    seedEventForTest({
      id,
      slug: 'elite-open',
      name: 'Elite',
      status: 'registration_open',
      isPublic: true,
      registrationStart: new Date(Date.now() - 60_000).toISOString(),
      registrationEnd: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const found = await catalogRepository.findPublishedEventBySlug('elite-open');
    expect(found).not.toBeNull();
    expect(found!.status).toBe('registration_open');
    expect(found!.published).toBe(true);
  });

  it('is_public=false retorna 404 (null)', async () => {
    seedEventForTest({
      id: randomUUID(),
      slug: 'privado',
      name: 'Privado',
      status: 'registration_open',
      isPublic: false,
    });
    expect(await catalogRepository.findPublishedEventBySlug('privado')).toBeNull();
  });

  it('evento fora do período de inscrição não é elegível', () => {
    const event = seedEventForTest({
      id: randomUUID(),
      slug: 'fechado',
      name: 'Fechado',
      status: 'registration_open',
      isPublic: true,
      registrationStart: new Date(Date.now() + 86_400_000).toISOString(),
      registrationEnd: new Date(Date.now() + 172_800_000).toISOString(),
    });
    expect(isEventPubliclyEligible(event)).toBe(false);
  });

  it('categoria individual calcula 19990 centavos', () => {
    const batch = seedPriceBatchForTest({
      id: randomUUID(),
      eventId: randomUUID(),
      name: 'Lote 1',
      pricePerAthlete: 199.9,
      pricePerTeam: null,
    });
    expect(calculatePriceCentsFromBatch(batch, 1)).toBe(19990);
  });

  it('categoria dupla calcula 39980 centavos', () => {
    const batch = seedPriceBatchForTest({
      id: randomUUID(),
      eventId: randomUUID(),
      name: 'Lote 1',
      pricePerAthlete: 199.9,
      pricePerTeam: null,
    });
    expect(calculatePriceCentsFromBatch(batch, 2)).toBe(39980);
  });

  it('price_per_team tem prioridade', () => {
    const batch = seedPriceBatchForTest({
      id: randomUUID(),
      eventId: randomUUID(),
      name: 'Lote team',
      pricePerAthlete: 199.9,
      pricePerTeam: 350.0,
    });
    expect(calculatePriceCentsFromBatch(batch, 2)).toBe(35000);
  });

  it('lote inativo é ignorado', async () => {
    const eventId = randomUUID();
    const categoryId = randomUUID();
    seedEventForTest({
      id: eventId,
      slug: 'e1',
      name: 'E',
      status: 'registration_open',
      isPublic: true,
    });
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'Ind',
      format: 'individual',
      teamSize: 1,
      capacity: 10,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Inativo',
      isActive: false,
      pricePerAthlete: 199.9,
      categoryIds: [categoryId],
    });
    const cat = await catalogRepository.findCategoryById(categoryId);
    expect(cat!.priceBatchId).toBeNull();
    expect(cat!.registrationOpen).toBe(false);
  });

  it('lote fora da data é ignorado', async () => {
    const eventId = randomUUID();
    const categoryId = randomUUID();
    seedEventForTest({
      id: eventId,
      slug: 'e2',
      name: 'E',
      status: 'registration_open',
      isPublic: true,
    });
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'Ind',
      format: 'individual',
      teamSize: 1,
      capacity: 10,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Futuro',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      pricePerAthlete: 199.9,
    });
    const cat = await catalogRepository.findCategoryById(categoryId);
    expect(cat!.registrationOpen).toBe(false);
  });

  it('category_ids vazio vale para todas', () => {
    const eventId = randomUUID();
    const categoryId = randomUUID();
    const batch = seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Geral',
      pricePerAthlete: 199.9,
      categoryIds: [],
    });
    const selected = selectCurrentPriceBatch([batch], categoryId, eventId);
    expect(selected?.id).toBe(batch.id);
  });

  it('category_ids contendo categoria funciona', () => {
    const eventId = randomUUID();
    const categoryId = randomUUID();
    const other = randomUUID();
    const batch = seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Específico',
      pricePerAthlete: 199.9,
      categoryIds: [other, categoryId],
    });
    expect(selectCurrentPriceBatch([batch], categoryId, eventId)?.id).toBe(batch.id);
    expect(selectCurrentPriceBatch([batch], randomUUID(), eventId)).toBeNull();
  });

  it('categoria sem lote válido fica registrationOpen=false', async () => {
    const eventId = randomUUID();
    const categoryId = randomUUID();
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'Sem lote',
      format: 'individual',
      teamSize: 1,
      capacity: 5,
    });
    const cat = await catalogRepository.findCategoryById(categoryId);
    expect(cat!.registrationOpen).toBe(false);
    expect(cat!.priceCents).toBe(0);
  });

  it('capacidade null significa ilimitada', async () => {
    const eventId = randomUUID();
    const categoryId = randomUUID();
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'Ilimitada',
      format: 'individual',
      teamSize: 1,
      capacity: null,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Lote',
      pricePerAthlete: 199.9,
    });
    const cat = await catalogRepository.findCategoryById(categoryId);
    expect(cat!.capacity).toBeNull();
    expect(cat!.availableSlots).toBeNull();
    expect(cat!.soldOut).toBe(false);
    expect(cat!.registrationOpen).toBe(true);
  });

  it('soldOut correto e ocupação por registrations', async () => {
    const eventId = randomUUID();
    const categoryId = randomUUID();
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'Lotada',
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
      categoryId,
      eventId,
      totalPrice: 199.9,
      status: 'draft',
    });
    seedRegistrationForTest({
      id: randomUUID(),
      categoryId,
      eventId,
      totalPrice: 199.9,
      status: 'cancelled',
    });

    let cat = await catalogRepository.findCategoryById(categoryId);
    expect(cat!.occupiedSlots).toBe(0);
    expect(cat!.soldOut).toBe(false);

    seedRegistrationForTest({
      id: randomUUID(),
      categoryId,
      eventId,
      totalPrice: 199.9,
      status: 'pending_payment',
    });

    cat = await catalogRepository.findCategoryById(categoryId);
    expect(cat!.occupiedSlots).toBe(1);
    expect(cat!.soldOut).toBe(true);
    expect(cat!.registrationOpen).toBe(false);
    expect(await paymentRepository.countOccupyingRegistrationsByCategoryId(categoryId)).toBe(1);
  });

  it('nenhum UPDATE em categories (incrementOccupiedSlots é no-op de escrita)', async () => {
    const eventId = randomUUID();
    const categoryId = randomUUID();
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'X',
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
    const before = await catalogRepository.findCategoryById(categoryId);
    const after = await catalogRepository.incrementOccupiedSlots(categoryId, 1);
    expect(after.occupiedSlots).toBe(before!.occupiedSlots);
    expect(after.capacity).toBe(10);
  });

  it('hydrate lista individual/dupla com preços corretos', async () => {
    const eventId = randomUUID();
    const ind = randomUUID();
    const dup = randomUUID();
    seedEventForTest({
      id: eventId,
      slug: 'precos',
      name: 'P',
      status: 'registration_open',
      isPublic: true,
    });
    seedCategoryForTest({
      id: ind,
      eventId,
      name: 'Individual',
      format: 'individual',
      teamSize: 1,
      capacity: 50,
    });
    seedCategoryForTest({
      id: dup,
      eventId,
      name: 'Dupla',
      format: 'dupla',
      teamSize: 2,
      capacity: 50,
    });
    seedPriceBatchForTest({
      id: randomUUID(),
      eventId,
      name: 'Lote único',
      pricePerAthlete: 199.9,
      categoryIds: null,
      orderIndex: 0,
    });

    const list = await catalogRepository.listCategoriesByEventId(eventId);
    const individual = list.find((c) => c.id === ind)!;
    const dupla = list.find((c) => c.id === dup)!;
    expect(individual.priceCents).toBe(19990);
    expect(dupla.priceCents).toBe(39980);
  });

  it('normalizeVideoUrls: null → []; filtra não-string e vazios', () => {
    expect(normalizeVideoUrls(null)).toEqual([]);
    expect(normalizeVideoUrls(undefined)).toEqual([]);
    expect(normalizeVideoUrls('x')).toEqual([]);
    expect(
      normalizeVideoUrls(['a', '', '  ', 1, null, 'b.mp4', { u: 1 }]),
    ).toEqual(['a', 'b.mp4']);
  });
});
