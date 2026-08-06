import { catalogRepository } from '../../repositories/catalog.repository.js';
import { paymentRepository } from '../../repositories/payment.repository.js';
import { registrationAccessTokenRepository } from '../../repositories/registration-access-token.repository.js';
import { assertValidCpf, maskCpfDisplay } from '../../utils/cpf.js';
import { AppError } from '../../utils/app-error.js';
import { centsToPixAmount } from '../../utils/money.js';
import { addSeconds } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import type { CreatePublicRegistrationBody } from '../../schemas/public-registration.schema.js';
import type { PublicCategoryRecord, PublicEventRecord } from '../../types/public-catalog.types.js';

function moneyFromCents(cents: number): string {
  return centsToPixAmount(cents);
}

function expectedAthleteCount(format: string): number {
  const normalized = format.toLowerCase();
  if (normalized === 'dupla' || normalized === 'double') return 2;
  if (normalized === 'equipe' || normalized === 'team') return 2;
  return 1;
}

function ageRangeLabel(category: PublicCategoryRecord): string | null {
  if (category.ageMin == null && category.ageMax == null) return null;
  if (category.ageMin != null && category.ageMax != null) {
    return `${category.ageMin}-${category.ageMax}`;
  }
  if (category.ageMin != null) return `${category.ageMin}+`;
  return `até ${category.ageMax}`;
}

export class PublicRegistrationService {
  async getPublishedEventBySlug(slug: string): Promise<Record<string, unknown>> {
    const event = await catalogRepository.findPublishedEventBySlug(slug);
    if (!event) throw AppError.notFound('Evento não encontrado', 'EVENT_NOT_FOUND');
    return this.toPublicEvent(event);
  }

  async listCategoriesBySlug(slug: string): Promise<Record<string, unknown>[]> {
    const event = await catalogRepository.findPublishedEventBySlug(slug);
    if (!event) throw AppError.notFound('Evento não encontrado', 'EVENT_NOT_FOUND');
    const categories = await catalogRepository.listCategoriesByEventId(event.id);
    const windowOpen = catalogRepository.isEventOpenForRegistration(event);

    return categories.map((category) => ({
      categoryId: category.id,
      name: category.name,
      description: category.description,
      format: category.format,
      gender: category.gender,
      ageRange: ageRangeLabel(category),
      capacity: category.capacity,
      occupiedSlots: category.occupiedSlots,
      availableSlots: category.availableSlots,
      currentPrice: moneyFromCents(category.priceCents),
      priceBatchId: category.priceBatchId,
      registrationOpen: windowOpen && category.registrationOpen,
      soldOut: category.soldOut,
    }));
  }

  async createRegistration(
    body: CreatePublicRegistrationBody,
    opts?: { requestId?: string; supabaseUserId?: string | null },
  ): Promise<Record<string, unknown>> {
    const requestId = opts?.requestId ?? body.requestId;
    if (requestId) {
      const existing = await registrationAccessTokenRepository.findIdempotent(
        'public_registration_create',
        requestId,
      );
      if (existing?.responseSnapshot) {
        return existing.responseSnapshot;
      }
    }

    const event = await catalogRepository.findEventById(body.eventId);
    if (!event || !catalogRepository.isEventOpenForRegistration(event)) {
      if (!event || !event.isPublic || event.deletedAt) {
        throw AppError.notFound('Evento não encontrado ou indisponível', 'EVENT_NOT_FOUND');
      }
      throw AppError.badRequest(
        'Período de inscrição encerrado ou não iniciado',
        'REGISTRATION_CLOSED',
      );
    }

    const category = await catalogRepository.findCategoryById(body.categoryId);
    if (!category || category.eventId !== event.id) {
      throw AppError.notFound('Categoria não encontrada', 'CATEGORY_NOT_FOUND');
    }
    if (category.soldOut) {
      throw AppError.conflict('Categoria esgotada', 'CATEGORY_SOLD_OUT');
    }
    if (!category.registrationOpen) {
      throw AppError.badRequest('Categoria fechada para inscrição', 'CATEGORY_CLOSED');
    }

    const expected = expectedAthleteCount(category.format);
    if (body.athletes.length !== expected && category.format !== 'equipe') {
      throw AppError.badRequest(
        `Formato '${category.format}' exige ${expected} atleta(s)`,
        'INVALID_ATHLETE_COUNT',
      );
    }
    if (category.format === 'equipe' && body.athletes.length < 2) {
      throw AppError.badRequest('Equipe exige ao menos 2 atletas', 'INVALID_ATHLETE_COUNT');
    }

    for (const athlete of body.athletes) {
      assertValidCpf(athlete.cpf);
    }

    if (!category.priceBatchId || category.priceCents <= 0) {
      throw AppError.badRequest('Categoria sem lote de preço válido', 'PRICE_BATCH_UNAVAILABLE');
    }

    const totalPrice = Number((category.priceCents / 100).toFixed(2));

    // Ocupação é derivada de registrations; não há UPDATE em categories.
    await catalogRepository.incrementOccupiedSlots(category.id, 1);

    const registration = await paymentRepository.createRegistration({
      eventId: event.id,
      categoryId: category.id,
      format: category.format,
      totalPrice,
      status: 'draft',
    });

    let index = 0;
    for (const athleteInput of body.athletes) {
      const existing = await paymentRepository.findAthleteByCpf(athleteInput.cpf);
      const athlete =
        existing ??
        (await paymentRepository.createAthlete({
          fullName: athleteInput.fullName,
          cpf: athleteInput.cpf,
        }));
      await paymentRepository.linkRegistrationAthlete({
        registrationId: registration.id,
        athleteId: athlete.id,
        role: athleteInput.role ?? (index === 0 ? 'athlete_a' : `athlete_${index + 1}`),
      });
      index += 1;
    }

    const reservation = await paymentRepository.createReservation({
      registrationId: registration.id,
      categoryId: category.id,
      quantity: 1,
      expiresAt: addSeconds(new Date(), 30 * 60).toISOString(),
      status: 'active',
    });

    const { rawToken } = await registrationAccessTokenRepository.issueToken(registration.id);

    const response = {
      registrationId: registration.id,
      registrationNumber: registration.registrationNumber,
      status: 'draft',
      amount: totalPrice.toFixed(2),
      paymentRequired: true,
      accessToken: rawToken,
      reservationId: reservation.id,
      supabaseUserId: opts?.supabaseUserId ?? null,
    };

    if (requestId) {
      await registrationAccessTokenRepository.saveIdempotent({
        scope: 'public_registration_create',
        requestId,
        resourceType: 'registration',
        resourceId: registration.id,
        responseSnapshot: response,
      });
    }

    logger.info('Inscrição pública criada', {
      registrationId: registration.id,
      eventId: event.id,
      categoryId: category.id,
      athleteCount: body.athletes.length,
      amount: response.amount,
      operation: 'public_registration_create',
    });

    return response;
  }

  async getReceipt(registrationId: string): Promise<Record<string, unknown>> {
    const registration = await paymentRepository.findRegistrationById(registrationId);
    if (!registration) throw AppError.notFound('Inscrição não encontrada');
    if (registration.status !== 'paid' && registration.status !== 'confirmed') {
      throw AppError.badRequest('Comprovante disponível apenas para inscrição paga', 'RECEIPT_UNAVAILABLE');
    }

    const payments = await paymentRepository.listPaymentsByRegistrationId(registrationId);
    const paid = payments.find((p) => p.status === 'paid');
    const athletes = await paymentRepository.listAthletesForRegistration(registrationId);
    const event = registration.eventId
      ? await catalogRepository.findEventById(registration.eventId)
      : null;
    const category = registration.categoryId
      ? await catalogRepository.findCategoryById(registration.categoryId)
      : null;

    return {
      registrationNumber: registration.registrationNumber,
      status: registration.status,
      amount: Number(registration.totalPrice).toFixed(2),
      paidAt: paid?.paidAt ?? null,
      confirmationCodeMasked: paid?.endToEndId
        ? `${paid.endToEndId.slice(0, 4)}…${paid.endToEndId.slice(-4)}`
        : null,
      event: event
        ? {
            id: event.id,
            name: event.name,
            slug: event.slug,
            location: event.location,
          }
        : null,
      category: category
        ? {
            id: category.id,
            name: category.name,
            format: category.format,
          }
        : null,
      athletes: athletes.map((a) => ({
        fullName: a.fullName,
        cpfMasked: maskCpfDisplay(a.cpf),
        role: a.role,
      })),
    };
  }

  private toPublicEvent(event: PublicEventRecord): Record<string, unknown> {
    return {
      id: event.id,
      slug: event.slug,
      name: event.name,
      description: event.description,
      startDate: event.startDate,
      endDate: event.endDate,
      location: event.location,
      registrationStart: event.registrationStart,
      registrationEnd: event.registrationEnd,
      status: event.status,
      regulationUrl: event.regulationUrl,
      bannerUrl: event.bannerUrl,
    };
  }
}

export const publicRegistrationService = new PublicRegistrationService();
