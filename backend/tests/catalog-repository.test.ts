import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  clearCatalogMemoryStore,
  seedEventForTest,
  seedCategoryForTest,
  seedPriceBatchForTest,
  seedPriceBatchCategoryOverrideForTest,
  catalogRepository,
  calculatePriceCentsFromBatch,
  resolveCategoryPriceCents,
  totalPriceFromCents,
  selectCurrentPriceBatch,
  isEventPubliclyEligible,
  normalizeVideoUrls,
} from '../src/repositories/catalog.repository.js';
import {
  clearPaymentMemoryStore,
  paymentRepository,
  seedRegistrationForTest,
} from '../src/repositories/payment.repository.js';
import { centsToPixAmount, toCents } from '../src/utils/money.js';

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

describe('resolveCategoryPriceCents — overrides price_batch_categories', () => {
  beforeEach(() => {
    clearCatalogMemoryStore();
    clearPaymentMemoryStore();
  });

  it('sem override → preço do lote preservado', () => {
    const batch = seedPriceBatchForTest({
      id: randomUUID(),
      eventId: randomUUID(),
      name: 'Lote',
      pricePerAthlete: 199.9,
      pricePerTeam: null,
    });
    const categoryId = randomUUID();
    expect(
      resolveCategoryPriceCents({ batch, override: null, teamSize: 1, categoryId }),
    ).toBe(19990);
    expect(
      resolveCategoryPriceCents({ batch, override: null, teamSize: 2, categoryId }),
    ).toBe(39980);
  });

  it('override individual price_per_athlete = 0.02', () => {
    const batchId = randomUUID();
    const categoryId = randomUUID();
    const batch = seedPriceBatchForTest({
      id: batchId,
      eventId: randomUUID(),
      name: 'Lote',
      pricePerAthlete: 199.9,
    });
    const override = seedPriceBatchCategoryOverrideForTest({
      id: randomUUID(),
      batchId,
      categoryId,
      pricePerAthlete: 0.02,
      pricePerTeam: null,
      isActive: true,
    });
    const cents = resolveCategoryPriceCents({
      batch,
      override,
      teamSize: 1,
      categoryId,
    });
    expect(cents).toBe(2);
    expect(centsToPixAmount(cents)).toBe('0.02');
    expect(totalPriceFromCents(cents)).toBe(0.02);
  });

  it('override dupla por atleta: 0.01 × 2 = 0.02', () => {
    const batchId = randomUUID();
    const categoryId = randomUUID();
    const batch = seedPriceBatchForTest({
      id: batchId,
      eventId: randomUUID(),
      name: 'Lote',
      pricePerAthlete: 199.9,
    });
    const override = seedPriceBatchCategoryOverrideForTest({
      id: randomUUID(),
      batchId,
      categoryId,
      pricePerAthlete: 0.01,
      pricePerTeam: null,
    });
    const cents = resolveCategoryPriceCents({
      batch,
      override,
      teamSize: 2,
      categoryId,
    });
    expect(cents).toBe(2);
    expect(centsToPixAmount(cents)).toBe('0.02');
  });

  it('override dupla por equipe: price_per_team = 0.01', () => {
    const batchId = randomUUID();
    const categoryId = randomUUID();
    const batch = seedPriceBatchForTest({
      id: batchId,
      eventId: randomUUID(),
      name: 'Lote',
      pricePerAthlete: 199.9,
    });
    const override = seedPriceBatchCategoryOverrideForTest({
      id: randomUUID(),
      batchId,
      categoryId,
      pricePerAthlete: 0.01,
      pricePerTeam: 0.01,
    });
    const cents = resolveCategoryPriceCents({
      batch,
      override,
      teamSize: 2,
      categoryId,
    });
    expect(cents).toBe(1);
    expect(centsToPixAmount(cents)).toBe('0.01');
  });

  it('override inativo é ignorado', () => {
    const batchId = randomUUID();
    const categoryId = randomUUID();
    const batch = seedPriceBatchForTest({
      id: batchId,
      eventId: randomUUID(),
      name: 'Lote',
      pricePerAthlete: 199.9,
    });
    const override = seedPriceBatchCategoryOverrideForTest({
      id: randomUUID(),
      batchId,
      categoryId,
      pricePerAthlete: 0.02,
      isActive: false,
    });
    expect(
      resolveCategoryPriceCents({ batch, override, teamSize: 1, categoryId }),
    ).toBe(19990);
  });

  it('override de outra categoria é ignorado', () => {
    const batchId = randomUUID();
    const categoryId = randomUUID();
    const batch = seedPriceBatchForTest({
      id: batchId,
      eventId: randomUUID(),
      name: 'Lote',
      pricePerAthlete: 199.9,
    });
    const override = seedPriceBatchCategoryOverrideForTest({
      id: randomUUID(),
      batchId,
      categoryId: randomUUID(),
      pricePerAthlete: 0.02,
      isActive: true,
    });
    expect(
      resolveCategoryPriceCents({ batch, override, teamSize: 1, categoryId }),
    ).toBe(19990);
  });

  it('override de outro batch é ignorado', () => {
    const batch = seedPriceBatchForTest({
      id: randomUUID(),
      eventId: randomUUID(),
      name: 'Lote',
      pricePerAthlete: 199.9,
    });
    const categoryId = randomUUID();
    const override = seedPriceBatchCategoryOverrideForTest({
      id: randomUUID(),
      batchId: randomUUID(),
      categoryId,
      pricePerAthlete: 0.02,
      isActive: true,
    });
    expect(
      resolveCategoryPriceCents({ batch, override, teamSize: 1, categoryId }),
    ).toBe(19990);
  });

  it('catálogo e total de inscrição usam exatamente o mesmo centavo', async () => {
    const eventId = randomUUID();
    const categoryId = randomUUID();
    const batchId = randomUUID();
    seedEventForTest({
      id: eventId,
      slug: 'override-same',
      name: 'P',
      status: 'registration_open',
      isPublic: true,
    });
    seedCategoryForTest({
      id: categoryId,
      eventId,
      name: 'Intermediário Masculino',
      format: 'individual',
      teamSize: 1,
      capacity: null,
    });
    seedPriceBatchForTest({
      id: batchId,
      eventId,
      name: 'Lote',
      pricePerAthlete: 199.9,
    });
    seedPriceBatchCategoryOverrideForTest({
      id: randomUUID(),
      batchId,
      categoryId,
      pricePerAthlete: 0.02,
      pricePerTeam: null,
      isActive: true,
    });

    const cat = await catalogRepository.findCategoryById(categoryId);
    expect(cat!.priceCents).toBe(2);
    expect(centsToPixAmount(cat!.priceCents)).toBe('0.02');
    expect(totalPriceFromCents(cat!.priceCents)).toBe(0.02);

    const resolvedAgain = resolveCategoryPriceCents({
      batch: seedPriceBatchForTest({
        id: batchId,
        eventId,
        name: 'Lote',
        pricePerAthlete: 199.9,
      }),
      override: {
        id: randomUUID(),
        batchId,
        categoryId,
        pricePerAthlete: 0.02,
        pricePerTeam: null,
        isActive: true,
        slots: null,
      },
      teamSize: 1,
      categoryId,
    });
    expect(resolvedAgain).toBe(cat!.priceCents);
  });

  it('R$ 0,01 / R$ 0,02 não sofrem arredondamento incorreto', () => {
    expect(toCents(0.01)).toBe(1);
    expect(toCents(0.02)).toBe(2);
    expect(centsToPixAmount(1)).toBe('0.01');
    expect(centsToPixAmount(2)).toBe('0.02');
    expect(totalPriceFromCents(1)).toBe(0.01);
    expect(totalPriceFromCents(2)).toBe(0.02);
  });

  it('hydrate lista aplica override ativo da categoria', async () => {
    const eventId = randomUUID();
    const catA = randomUUID();
    const catB = randomUUID();
    const batchId = randomUUID();
    seedEventForTest({
      id: eventId,
      slug: 'ov-list',
      name: 'P',
      status: 'registration_open',
      isPublic: true,
    });
    seedCategoryForTest({
      id: catA,
      eventId,
      name: 'Com override',
      format: 'individual',
      teamSize: 1,
      capacity: null,
    });
    seedCategoryForTest({
      id: catB,
      eventId,
      name: 'Sem override',
      format: 'individual',
      teamSize: 1,
      capacity: null,
    });
    seedPriceBatchForTest({
      id: batchId,
      eventId,
      name: 'Lote',
      pricePerAthlete: 199.9,
    });
    seedPriceBatchCategoryOverrideForTest({
      id: randomUUID(),
      batchId,
      categoryId: catA,
      pricePerAthlete: 0.02,
      isActive: true,
    });

    const list = await catalogRepository.listCategoriesByEventId(eventId);
    expect(list.find((c) => c.id === catA)!.priceCents).toBe(2);
    expect(list.find((c) => c.id === catB)!.priceCents).toBe(19990);
  });
});
