import {
  catalogRepository,
  totalPriceFromCents,
} from '../../repositories/catalog.repository.js';
import {
  listAthletesMemoryForTest,
  listGuardiansMemoryForTest,
  listTeamsMemoryForTest,
  listWaiversMemoryForTest,
  paymentRepository,
} from '../../repositories/payment.repository.js';
import { registrationAccessTokenRepository } from '../../repositories/registration-access-token.repository.js';
import { assertValidCpf, maskCpfDisplay, normalizeCpfDigits } from '../../utils/cpf.js';
import { AppError } from '../../utils/app-error.js';
import { centsToPixAmount } from '../../utils/money.js';
import { addSeconds } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import type { CreatePublicRegistrationBody } from '../../schemas/public-registration.schema.js';
import { MAX_SIGNATURE_DATA_URL_LENGTH } from '../../schemas/public-registration.schema.js';
import type {
  PublicCategoryDto,
  PublicCategoryRecord,
  PublicEventRecord,
} from '../../types/public-catalog.types.js';

function moneyFromCents(cents: number): string {
  return centsToPixAmount(cents);
}

/** Contagem exigida: vem da categoria no banco (teamSize), não do frontend. */
export function expectedAthleteCountFromCategory(category: PublicCategoryRecord): number {
  const normalized = String(category.format ?? '').toLowerCase();
  if (normalized === 'individual' || normalized === 'solo') return 1;
  if (normalized === 'dupla' || normalized === 'double') return 2;
  if (normalized === 'equipe' || normalized === 'team') {
    return category.teamSize >= 2 ? category.teamSize : 2;
  }
  return category.teamSize > 0 ? category.teamSize : 1;
}

function ageRangeLabel(category: PublicCategoryRecord): string | null {
  if (category.ageMin == null && category.ageMax == null) return null;
  if (category.ageMin != null && category.ageMax != null) {
    return `${category.ageMin}-${category.ageMax}`;
  }
  if (category.ageMin != null) return `${category.ageMin}+`;
  return `até ${category.ageMax}`;
}

function toPublicCategory(
  category: PublicCategoryRecord,
  windowOpen: boolean,
): PublicCategoryDto {
  return {
    categoryId: category.id,
    slug: category.slug,
    name: category.name,
    shortDescription: category.shortDescription,
    description: category.description,
    format: category.format,
    teamSize: category.teamSize,
    gender: category.gender,
    ageRange: ageRangeLabel(category),
    capacity: category.capacity,
    occupiedSlots: category.occupiedSlots,
    availableSlots: category.availableSlots,
    currentPrice: moneyFromCents(category.priceCents),
    priceBatchId: category.priceBatchId,
    registrationOpen: windowOpen && category.registrationOpen,
    soldOut: category.soldOut,
    notes: category.notes,
    videoUrls: Array.isArray(category.videoUrls) ? category.videoUrls : [],
  };
}

function redactSignature(sig: string | null | undefined): string | null {
  if (!sig) return null;
  return `[data-url omitted length=${sig.length}]`;
}

export class PublicRegistrationService {
  async getPublishedEventBySlug(slug: string): Promise<Record<string, unknown>> {
    const event = await catalogRepository.findPublishedEventBySlug(slug);
    if (!event) throw AppError.notFound('Evento não encontrado', 'EVENT_NOT_FOUND');
    return this.toPublicEvent(event);
  }

  async listCategoriesBySlug(slug: string): Promise<PublicCategoryDto[]> {
    const event = await catalogRepository.findPublishedEventBySlug(slug);
    if (!event) throw AppError.notFound('Evento não encontrado', 'EVENT_NOT_FOUND');
    const categories = await catalogRepository.listCategoriesByEventId(event.id);
    const windowOpen = catalogRepository.isEventOpenForRegistration(event);
    return categories.map((category) => toPublicCategory(category, windowOpen));
  }

  async getCategoryBySlugs(
    eventSlug: string,
    categorySlug: string,
  ): Promise<PublicCategoryDto> {
    const event = await catalogRepository.findPublishedEventBySlug(eventSlug);
    if (!event) throw AppError.notFound('Evento não encontrado', 'EVENT_NOT_FOUND');

    const category = await catalogRepository.findActiveCategoryByEventAndSlug(
      event.id,
      categorySlug,
    );
    if (!category) {
      throw AppError.notFound('Categoria não encontrada', 'CATEGORY_NOT_FOUND');
    }

    const windowOpen = catalogRepository.isEventOpenForRegistration(event);
    return toPublicCategory(category, windowOpen);
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

    const expected = expectedAthleteCountFromCategory(category);
    if (body.athletes.length !== expected) {
      throw AppError.badRequest(
        `Formato '${category.format}' exige exatamente ${expected} atleta(s)`,
        'INVALID_ATHLETE_COUNT',
      );
    }

    for (const athlete of body.athletes) {
      assertValidCpf(athlete.cpf);
    }

    if (!category.priceBatchId || category.priceCents <= 0) {
      throw AppError.badRequest('Categoria sem lote de preço válido', 'PRICE_BATCH_UNAVAILABLE');
    }

    // Valida responsável = Atleta 1
    const first = body.athletes[0]!;
    const responsible = body.responsible;

    if (responsible?.isAthlete1 === true && responsible.cpf) {
      if (normalizeCpfDigits(responsible.cpf) !== normalizeCpfDigits(first.cpf)) {
        throw AppError.badRequest(
          'Responsável marcado como Atleta 1, mas CPF não corresponde',
          'RESPONSIBLE_MISMATCH',
        );
      }
    }

    const responsibleCpf =
      responsible?.cpf != null ? normalizeCpfDigits(responsible.cpf) : null;
    const isAthlete1Responsible =
      responsible == null ||
      responsible.isAthlete1 === true ||
      (responsible.isAthlete1 !== false &&
        responsibleCpf != null &&
        responsibleCpf === normalizeCpfDigits(first.cpf));

    const shouldCreateGuardian =
      responsible != null &&
      responsible.isAthlete1 !== true &&
      Boolean(responsible.fullName?.trim()) &&
      Boolean(responsible.phone?.trim()) &&
      Boolean(responsibleCpf) &&
      (responsible.isAthlete1 === false ||
        responsibleCpf !== normalizeCpfDigits(first.cpf));

    const signature = body.waiver?.signatureDataUrl ?? null;
    if (signature && signature.length > MAX_SIGNATURE_DATA_URL_LENGTH) {
      throw AppError.badRequest('Assinatura excede o tamanho máximo', 'SIGNATURE_TOO_LARGE');
    }

    const totalPrice = totalPriceFromCents(category.priceCents);
    const format = category.format;

    // Equipe/dupla: cria team quando houver teamName
    let teamId: string | null = null;
    const teamName = body.teamName?.trim();
    if (
      teamName &&
      (format === 'dupla' ||
        format === 'equipe' ||
        format === 'double' ||
        format === 'team')
    ) {
      const team = await paymentRepository.createTeam({
        eventId: event.id,
        categoryId: category.id,
        name: teamName,
      });
      teamId = team.id;
    }
    // individual: teamName ignorado

    await catalogRepository.incrementOccupiedSlots(category.id, 1);

    const registration = await paymentRepository.createRegistration({
      eventId: event.id,
      categoryId: category.id,
      format,
      totalPrice,
      teamId,
      status: 'draft',
    });

    const createdAthleteIds: string[] = [];
    let index = 0;
    for (const athleteInput of body.athletes) {
      const existing = await paymentRepository.findAthleteByCpf(athleteInput.cpf);
      let athleteId: string;
      if (existing) {
        await paymentRepository.updateAthlete(existing.id, {
          fullName: athleteInput.fullName,
          email: athleteInput.email,
          phone: athleteInput.phone,
          birthDate: athleteInput.birthDate,
          gender: athleteInput.gender,
          shirtSize: athleteInput.shirtSize ?? body.shirtSizes?.[index],
          emergencyName: athleteInput.emergencyName,
          emergencyPhone: athleteInput.emergencyPhone,
          medicalNotes: athleteInput.medicalNotes ?? body.medicalNotes,
        });
        athleteId = existing.id;
      } else {
        const created = await paymentRepository.createAthlete({
          fullName: athleteInput.fullName,
          cpf: athleteInput.cpf,
          email: athleteInput.email,
          phone: athleteInput.phone,
          birthDate: athleteInput.birthDate,
          gender: athleteInput.gender,
          shirtSize: athleteInput.shirtSize ?? body.shirtSizes?.[index],
          emergencyName: athleteInput.emergencyName,
          emergencyPhone: athleteInput.emergencyPhone,
          medicalNotes: athleteInput.medicalNotes ?? body.medicalNotes,
        });
        athleteId = created.id;
      }
      createdAthleteIds.push(athleteId);
      await paymentRepository.linkRegistrationAthlete({
        registrationId: registration.id,
        athleteId,
        role: athleteInput.role ?? (index === 0 ? 'athlete_a' : `athlete_${index + 1}`),
      });
      index += 1;
    }

    // Responsável externo → guardians (modelo real). isAthlete1 / omitido: sem guardian.
    if (shouldCreateGuardian) {
      assertValidCpf(responsibleCpf!);
      await paymentRepository.createGuardian({
        athleteId: createdAthleteIds[0]!,
        fullName: responsible!.fullName!,
        cpf: responsibleCpf!,
        phone: responsible!.phone!,
        email: responsible!.email,
        relationship: 'responsável',
      });
    }

    // Waiver (flags + signature_url no modelo Lovable atual)
    const waiver = body.waiver;
    await paymentRepository.createWaiver({
      registrationId: registration.id,
      athleteId: createdAthleteIds[0] ?? null,
      regulationAccepted: body.termsAccepted === true || waiver?.regulationAccepted === true,
      lgpdAccepted: body.privacyAccepted === true || waiver?.privacyAccepted === true,
      imageUseAccepted: waiver?.imageUseAccepted === true,
      fitnessAccepted: waiver?.fitnessAccepted === true,
      signatureUrl: signature,
    });

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
      registrationAccessToken: rawToken,
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
      teamId,
      hasGuardian: shouldCreateGuardian,
      hasWaiver: true,
      signature: redactSignature(signature),
      amount: response.amount,
      reservationId: reservation.id,
      isAthlete1Responsible,
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

/** Exposto só para testes de memória (sem I/O externo). */
export const __testPublicRegistrationMemory = {
  listAthletes: listAthletesMemoryForTest,
  listGuardians: listGuardiansMemoryForTest,
  listTeams: listTeamsMemoryForTest,
  listWaivers: listWaiversMemoryForTest,
};
