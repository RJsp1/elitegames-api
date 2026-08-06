import { randomUUID } from 'node:crypto';
import { getSupabase } from '../config/supabase.js';
import { paymentRepository } from './payment.repository.js';
import { AppError } from '../utils/app-error.js';
import { toCents } from '../utils/money.js';
import type {
  PublicCategoryRecord,
  PublicEventRecord,
  PublicPriceBatchRecord,
} from '../types/public-catalog.types.js';
import { PUBLIC_EVENT_STATUSES } from '../types/public-catalog.types.js';

const events = new Map<string, PublicEventRecord>();
const categories = new Map<string, PublicCategoryRecord & { teamSizeRaw?: number }>();
const priceBatches = new Map<string, PublicPriceBatchRecord>();

export function clearCatalogMemoryStore(): void {
  events.clear();
  categories.clear();
  priceBatches.clear();
}

export function seedEventForTest(
  partial: Partial<PublicEventRecord> & { id: string; slug: string; name: string },
): PublicEventRecord {
  const status = partial.status ?? 'registration_open';
  const isPublic = partial.isPublic ?? true;
  const deletedAt = partial.deletedAt ?? null;
  const registrationStart = partial.registrationStart ?? null;
  const registrationEnd = partial.registrationEnd ?? null;
  const record: PublicEventRecord = {
    id: partial.id,
    slug: partial.slug,
    name: partial.name,
    description: partial.description ?? null,
    startDate: partial.startDate ?? null,
    endDate: partial.endDate ?? null,
    location: partial.location ?? null,
    registrationStart,
    registrationEnd,
    status,
    regulationUrl: partial.regulationUrl ?? null,
    bannerUrl: partial.bannerUrl ?? null,
    isPublic,
    deletedAt,
    published: false,
  };
  record.published = isEventPubliclyEligible(record);
  events.set(record.id, record);
  return record;
}

/** Normaliza video_urls do banco: null → []; só strings não vazias. */
export function normalizeVideoUrls(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
}

export function seedCategoryForTest(
  partial: Partial<PublicCategoryRecord> & {
    id: string;
    eventId: string;
    name: string;
  },
): PublicCategoryRecord {
  const teamSize =
    partial.teamSize ??
    (partial.format === 'dupla' || partial.format === 'equipe' ? 2 : 1);
  const capacity = partial.capacity === undefined ? 100 : partial.capacity;
  const record: PublicCategoryRecord = {
    id: partial.id,
    eventId: partial.eventId,
    slug: partial.slug ?? '',
    name: partial.name,
    shortDescription: partial.shortDescription ?? null,
    description: partial.description ?? null,
    format: partial.format ?? 'individual',
    gender: partial.gender ?? null,
    ageMin: partial.ageMin ?? null,
    ageMax: partial.ageMax ?? null,
    capacity,
    occupiedSlots: partial.occupiedSlots ?? 0,
    availableSlots: null,
    teamSize,
    priceCents: partial.priceCents ?? 0,
    priceBatchId: partial.priceBatchId ?? null,
    registrationOpen: partial.registrationOpen ?? true,
    soldOut: partial.soldOut ?? false,
    notes: partial.notes ?? null,
    videoUrls: normalizeVideoUrls(partial.videoUrls),
    orderIndex: partial.orderIndex ?? 0,
    isActive: partial.isActive ?? true,
    deletedAt: partial.deletedAt ?? null,
  };
  categories.set(record.id, record);
  return record;
}

export function seedPriceBatchForTest(
  partial: Partial<PublicPriceBatchRecord> & { id: string; eventId: string; name: string },
): PublicPriceBatchRecord {
  const record: PublicPriceBatchRecord = {
    id: partial.id,
    eventId: partial.eventId,
    name: partial.name,
    startsAt: partial.startsAt ?? null,
    endsAt: partial.endsAt ?? null,
    pricePerAthlete: partial.pricePerAthlete ?? null,
    pricePerTeam: partial.pricePerTeam ?? null,
    slots: partial.slots ?? null,
    categoryIds: partial.categoryIds ?? null,
    isActive: partial.isActive ?? true,
    orderIndex: partial.orderIndex ?? 0,
    deletedAt: partial.deletedAt ?? null,
    createdAt: partial.createdAt ?? new Date().toISOString(),
  };
  priceBatches.set(record.id, record);
  return record;
}

function isPublicStatus(status: string): boolean {
  return (PUBLIC_EVENT_STATUSES as readonly string[]).includes(status);
}

export function isEventPubliclyEligible(event: PublicEventRecord, now = new Date()): boolean {
  if (!event.isPublic) return false;
  if (event.deletedAt) return false;
  if (!isPublicStatus(String(event.status))) return false;
  const t = now.getTime();
  if (event.registrationStart && Date.parse(event.registrationStart) > t) return false;
  if (event.registrationEnd && Date.parse(event.registrationEnd) < t) return false;
  return true;
}

function mapEvent(row: Record<string, unknown>): PublicEventRecord {
  const status = String(row.status ?? 'draft');
  const isPublic = Boolean(row.is_public);
  const deletedAt = (row.deleted_at as string) ?? null;
  const venue = (row.venue_name as string) ?? null;
  const city = (row.city as string) ?? null;
  const state = (row.state as string) ?? null;
  const locationParts = [venue, city, state].filter(Boolean);
  const record: PublicEventRecord = {
    id: String(row.id),
    slug: String(row.slug ?? ''),
    name: String(row.name ?? ''),
    description: (row.description as string) ?? null,
    startDate: (row.starts_at as string) ?? null,
    endDate: (row.ends_at as string) ?? null,
    location: locationParts.length > 0 ? locationParts.join(' — ') : venue,
    registrationStart: (row.registration_opens_at as string) ?? null,
    registrationEnd: (row.registration_closes_at as string) ?? null,
    status,
    regulationUrl: (row.regulation_url as string) ?? (row.regulation as string) ?? null,
    bannerUrl: (row.cover_url as string) ?? null,
    isPublic,
    deletedAt,
    published: false,
  };
  record.published = isEventPubliclyEligible(record);
  return record;
}

function mapPriceBatch(row: Record<string, unknown>): PublicPriceBatchRecord {
  const rawIds = row.category_ids;
  let categoryIds: string[] | null = null;
  if (Array.isArray(rawIds)) {
    categoryIds = rawIds.map(String);
  }
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    name: String(row.name ?? ''),
    startsAt: (row.starts_at as string) ?? null,
    endsAt: (row.ends_at as string) ?? null,
    pricePerAthlete: row.price_per_athlete != null ? Number(row.price_per_athlete) : null,
    pricePerTeam: row.price_per_team != null ? Number(row.price_per_team) : null,
    slots: row.slots != null ? Number(row.slots) : null,
    categoryIds,
    isActive: Boolean(row.is_active),
    orderIndex: Number(row.order_index ?? 0),
    deletedAt: (row.deleted_at as string) ?? null,
    createdAt: (row.created_at as string) ?? null,
  };
}

function resolveTeamSize(format: string, teamSizeRaw: number | null | undefined): number {
  if (teamSizeRaw != null && Number.isFinite(teamSizeRaw) && teamSizeRaw > 0) {
    return Math.trunc(teamSizeRaw);
  }
  const normalized = format.toLowerCase();
  if (normalized === 'dupla' || normalized === 'double') return 2;
  if (normalized === 'equipe' || normalized === 'team') return 2;
  return 1;
}

/**
 * Preço em centavos a partir do lote.
 * Prioridade: price_per_team; senão price_per_athlete × team_size.
 * Conversão via toCents (Math.round) para evitar float.
 */
export function calculatePriceCentsFromBatch(
  batch: PublicPriceBatchRecord,
  teamSize: number,
): number {
  if (batch.pricePerTeam != null && Number.isFinite(batch.pricePerTeam)) {
    return toCents(Number(batch.pricePerTeam));
  }
  if (batch.pricePerAthlete != null && Number.isFinite(batch.pricePerAthlete)) {
    return toCents(Number(batch.pricePerAthlete)) * teamSize;
  }
  return 0;
}

export function isPriceBatchEligibleForCategory(
  batch: PublicPriceBatchRecord,
  categoryId: string,
  eventId: string,
  now = new Date(),
): boolean {
  if (batch.eventId !== eventId) return false;
  if (!batch.isActive) return false;
  if (batch.deletedAt) return false;
  const t = now.getTime();
  if (batch.startsAt && Date.parse(batch.startsAt) > t) return false;
  if (batch.endsAt && Date.parse(batch.endsAt) < t) return false;
  const ids = batch.categoryIds;
  // null ou vazio → vale para todas as categorias do evento
  if (ids == null || ids.length === 0) return true;
  return ids.includes(categoryId);
}

/**
 * Seleciona lote vigente.
 * Ordenação: order_index ASC, depois created_at DESC (determinístico).
 */
export function selectCurrentPriceBatch(
  batches: PublicPriceBatchRecord[],
  categoryId: string,
  eventId: string,
  now = new Date(),
): PublicPriceBatchRecord | null {
  const eligible = batches.filter((b) =>
    isPriceBatchEligibleForCategory(b, categoryId, eventId, now),
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const byOrder = a.orderIndex - b.orderIndex;
    if (byOrder !== 0) return byOrder;
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  });
  return eligible[0] ?? null;
}

export class CatalogRepository {
  isEventOpenForRegistration(event: PublicEventRecord, now = new Date()): boolean {
    return isEventPubliclyEligible(event, now);
  }

  async findPublishedEventBySlug(slug: string): Promise<PublicEventRecord | null> {
    const supabase = getSupabase();
    if (!supabase) {
      for (const event of events.values()) {
        if (event.slug === slug && isEventPubliclyEligible(event)) return event;
      }
      return null;
    }

    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('slug', slug)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw AppError.internal(error.message);
    if (!data) return null;
    const event = mapEvent(data as Record<string, unknown>);
    if (!isEventPubliclyEligible(event)) return null;
    return event;
  }

  async findEventById(eventId: string): Promise<PublicEventRecord | null> {
    const supabase = getSupabase();
    if (!supabase) return events.get(eventId) ?? null;
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('id', eventId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw AppError.internal(error.message);
    return data ? mapEvent(data as Record<string, unknown>) : null;
  }

  async listPriceBatchesByEventId(eventId: string): Promise<PublicPriceBatchRecord[]> {
    const supabase = getSupabase();
    if (!supabase) {
      return Array.from(priceBatches.values()).filter((b) => b.eventId === eventId);
    }

    const { data, error } = await supabase
      .from('price_batches')
      .select('*')
      .eq('event_id', eventId)
      .is('deleted_at', null);
    if (error) throw AppError.internal(error.message);
    return (data ?? []).map((row) => mapPriceBatch(row as Record<string, unknown>));
  }

  private async hydrateCategory(
    row: Record<string, unknown>,
    batches: PublicPriceBatchRecord[],
  ): Promise<PublicCategoryRecord> {
    const id = String(row.id);
    const eventId = String(row.event_id);
    const format = String(row.format ?? 'individual');
    const teamSize = resolveTeamSize(
      format,
      row.team_size != null ? Number(row.team_size) : null,
    );
    const capacity =
      row.slots == null || row.slots === ''
        ? null
        : Number(row.slots);
    const capacityNormalized =
      capacity != null && Number.isFinite(capacity) ? capacity : null;

    const isActive = row.is_active != null ? Boolean(row.is_active) : true;
    const deletedAt = (row.deleted_at as string) ?? null;
    const occupiedSlots = await paymentRepository.countOccupyingRegistrationsByCategoryId(id);

    const batch = selectCurrentPriceBatch(batches, id, eventId);
    const priceCents = batch ? calculatePriceCentsFromBatch(batch, teamSize) : 0;
    const hasValidBatch = batch != null && priceCents > 0;

    const soldOut =
      capacityNormalized != null &&
      capacityNormalized > 0 &&
      occupiedSlots >= capacityNormalized;

    const availableSlots =
      capacityNormalized == null
        ? null
        : Math.max(0, capacityNormalized - occupiedSlots);

    const registrationOpen =
      isActive && deletedAt == null && hasValidBatch && !soldOut;

    return {
      id,
      eventId,
      slug: String(row.slug ?? ''),
      name: String(row.name ?? ''),
      shortDescription: (row.short_description as string) ?? null,
      description: (row.description as string) ?? null,
      format,
      gender: (row.gender as string) ?? null,
      ageMin: row.min_age != null ? Number(row.min_age) : null,
      ageMax: row.max_age != null ? Number(row.max_age) : null,
      capacity: capacityNormalized,
      occupiedSlots,
      availableSlots,
      teamSize,
      priceCents,
      priceBatchId: batch?.id ?? null,
      registrationOpen,
      soldOut,
      notes: (row.notes as string) ?? null,
      videoUrls: normalizeVideoUrls(row.video_urls),
      orderIndex: Number(row.order_index ?? 0),
      isActive,
      deletedAt,
    };
  }

  private async hydrateMemoryCategory(
    base: PublicCategoryRecord,
    batches: PublicPriceBatchRecord[],
  ): Promise<PublicCategoryRecord> {
    const occupiedSlots = await paymentRepository.countOccupyingRegistrationsByCategoryId(
      base.id,
    );
    const batch = selectCurrentPriceBatch(batches, base.id, base.eventId);
    const resolvedCents = batch ? calculatePriceCentsFromBatch(batch, base.teamSize) : 0;
    const hasValidBatch = batch != null && resolvedCents > 0;
    const capacity = base.capacity;
    const soldOut =
      capacity != null && capacity > 0 && occupiedSlots >= capacity;
    const availableSlots =
      capacity == null ? null : Math.max(0, capacity - occupiedSlots);
    const registrationOpen =
      base.isActive && base.deletedAt == null && hasValidBatch && !soldOut;

    return {
      ...base,
      occupiedSlots,
      availableSlots,
      priceCents: resolvedCents,
      priceBatchId: batch?.id ?? null,
      registrationOpen,
      soldOut,
    };
  }

  async listCategoriesByEventId(eventId: string): Promise<PublicCategoryRecord[]> {
    const batches = await this.listPriceBatchesByEventId(eventId);
    const supabase = getSupabase();

    if (!supabase) {
      const list = Array.from(categories.values()).filter((c) => c.eventId === eventId);
      const out: PublicCategoryRecord[] = [];
      for (const c of list) {
        out.push(await this.hydrateMemoryCategory(c, batches));
      }
      return out;
    }

    const primary = await supabase
      .from('categories')
      .select('*')
      .eq('event_id', eventId)
      .is('deleted_at', null)
      .order('order_index', { ascending: true });

    let rows: Record<string, unknown>[] = [];
    if (primary.error) {
      const alt = await supabase
        .from('event_categories')
        .select('*')
        .eq('event_id', eventId)
        .is('deleted_at', null)
        .order('order_index', { ascending: true });
      if (alt.error) throw AppError.internal(primary.error.message);
      rows = (alt.data ?? []) as Record<string, unknown>[];
    } else {
      rows = (primary.data ?? []) as Record<string, unknown>[];
    }

    const out: PublicCategoryRecord[] = [];
    for (const row of rows) {
      out.push(await this.hydrateCategory(row, batches));
    }
    return out;
  }

  async findCategoryById(categoryId: string): Promise<PublicCategoryRecord | null> {
    const supabase = getSupabase();
    if (!supabase) {
      const base = categories.get(categoryId);
      if (!base) return null;
      const batches = await this.listPriceBatchesByEventId(base.eventId);
      return this.hydrateMemoryCategory(base, batches);
    }

    const primary = await supabase
      .from('categories')
      .select('*')
      .eq('id', categoryId)
      .is('deleted_at', null)
      .maybeSingle();

    let row: Record<string, unknown> | null = null;
    if (!primary.error && primary.data) {
      row = primary.data as Record<string, unknown>;
    } else {
      const alt = await supabase
        .from('event_categories')
        .select('*')
        .eq('id', categoryId)
        .is('deleted_at', null)
        .maybeSingle();
      if (alt.error) {
        if (primary.error) throw AppError.internal(primary.error.message);
        throw AppError.internal(alt.error.message);
      }
      row = (alt.data as Record<string, unknown>) ?? null;
    }
    if (!row) return null;
    const batches = await this.listPriceBatchesByEventId(String(row.event_id));
    return this.hydrateCategory(row, batches);
  }

  /**
   * Categoria pública por slug dentro do evento.
   * Exige ativa + deleted_at null; preço/ocupação via mesma hidratação da lista.
   */
  async findActiveCategoryByEventAndSlug(
    eventId: string,
    categorySlug: string,
  ): Promise<PublicCategoryRecord | null> {
    const batches = await this.listPriceBatchesByEventId(eventId);
    const supabase = getSupabase();

    if (!supabase) {
      const base = Array.from(categories.values()).find(
        (c) =>
          c.eventId === eventId &&
          c.slug === categorySlug &&
          c.isActive &&
          c.deletedAt == null,
      );
      if (!base) return null;
      return this.hydrateMemoryCategory(base, batches);
    }

    const primary = await supabase
      .from('categories')
      .select('*')
      .eq('event_id', eventId)
      .eq('slug', categorySlug)
      .eq('is_active', true)
      .is('deleted_at', null)
      .maybeSingle();

    let row: Record<string, unknown> | null = null;
    if (!primary.error && primary.data) {
      row = primary.data as Record<string, unknown>;
    } else {
      const alt = await supabase
        .from('event_categories')
        .select('*')
        .eq('event_id', eventId)
        .eq('slug', categorySlug)
        .eq('is_active', true)
        .is('deleted_at', null)
        .maybeSingle();
      if (alt.error) {
        if (primary.error) throw AppError.internal(primary.error.message);
        throw AppError.internal(alt.error.message);
      }
      row = (alt.data as Record<string, unknown>) ?? null;
    }
    if (!row) return null;
    return this.hydrateCategory(row, batches);
  }

  /**
   * Compatibilidade: não atualiza categories (coluna occupied_slots não existe).
   * Apenas reconsulta a categoria com ocupação calculada.
   */
  async incrementOccupiedSlots(categoryId: string, _by = 1): Promise<PublicCategoryRecord> {
    const category = await this.findCategoryById(categoryId);
    if (!category) throw AppError.notFound('Categoria não encontrada');
    if (category.soldOut) {
      throw AppError.conflict('Categoria esgotada', 'CATEGORY_SOLD_OUT');
    }
    return category;
  }
}

export const catalogRepository = new CatalogRepository();

export function newCatalogId(): string {
  return randomUUID();
}
