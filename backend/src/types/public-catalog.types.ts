export type EventPublicationStatus =
  | 'draft'
  | 'published'
  | 'registration_open'
  | 'open'
  | 'closed'
  | 'cancelled'
  | 'archived'
  | string;

export interface PublicEventRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  registrationStart: string | null;
  registrationEnd: string | null;
  status: EventPublicationStatus;
  regulationUrl: string | null;
  bannerUrl: string | null;
  /** true quando elegível às regras de evento público (status + is_public + janela). */
  published: boolean;
  isPublic: boolean;
  deletedAt: string | null;
}

export interface PublicPriceBatchRecord {
  id: string;
  eventId: string;
  name: string;
  startsAt: string | null;
  endsAt: string | null;
  pricePerAthlete: number | null;
  pricePerTeam: number | null;
  slots: number | null;
  categoryIds: string[] | null;
  isActive: boolean;
  orderIndex: number;
  deletedAt: string | null;
  createdAt: string | null;
}

/**
 * Override por categoria no lote (`public.price_batch_categories`).
 * Colunas reais: batch_id, category_id, price_per_athlete, price_per_team,
 * is_active, slots, id, created_at, updated_at — sem deleted_at.
 */
export interface PublicPriceBatchCategoryOverride {
  id: string;
  batchId: string;
  categoryId: string;
  pricePerAthlete: number;
  pricePerTeam: number | null;
  isActive: boolean;
  slots: number | null;
}

export interface PublicCategoryRecord {
  id: string;
  eventId: string;
  /** Slug público para navegação (/categorias/:slug). */
  slug: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  format: 'individual' | 'dupla' | 'equipe' | string;
  gender: string | null;
  ageMin: number | null;
  ageMax: number | null;
  /** null = capacidade ilimitada (slots null no schema). */
  capacity: number | null;
  occupiedSlots: number;
  availableSlots: number | null;
  teamSize: number;
  priceCents: number;
  priceBatchId: string | null;
  registrationOpen: boolean;
  soldOut: boolean;
  notes: string | null;
  /** Sempre array (nunca null) após hidratação. */
  videoUrls: string[];
  orderIndex: number;
  isActive: boolean;
  deletedAt: string | null;
}

/** DTO público estável da categoria (lista e detalhe). */
export interface PublicCategoryDto {
  categoryId: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  format: string;
  teamSize: number;
  gender: string | null;
  ageRange: string | null;
  capacity: number | null;
  occupiedSlots: number;
  availableSlots: number | null;
  currentPrice: string;
  priceBatchId: string | null;
  registrationOpen: boolean;
  soldOut: boolean;
  notes: string | null;
  videoUrls: string[];
}

export interface RegistrationAccessTokenRecord {
  id: string;
  registrationId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface PublicIdempotencyRecord {
  id: string;
  scope: string;
  requestId: string;
  resourceType: string;
  resourceId: string;
  responseSnapshot: Record<string, unknown> | null;
  createdAt: string;
}

/** Status de registrations que efetivamente ocupam vaga. */
export const OCCUPYING_REGISTRATION_STATUSES = [
  'pending_payment',
  'paid',
  'confirmed',
] as const;

export const PUBLIC_EVENT_STATUSES = ['published', 'registration_open', 'open'] as const;
