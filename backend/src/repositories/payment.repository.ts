import { randomUUID } from 'node:crypto';
import { getSupabase } from '../config/supabase.js';
import type {
  AthleteRecord,
  PaymentChargeRecord,
  PaymentEventRecord,
  PaymentProviderRecord,
  PaymentRecord,
  PaymentStatusV2,
  RegistrationAthleteLink,
  RegistrationRecord,
  RegistrationStatus,
  ReservationRecord,
  ReservationStatus,
} from '../types/payment.types.js';
import { nowIso } from '../utils/date.js';
import { AppError } from '../utils/app-error.js';
import { logger } from '../utils/logger.js';

/** Stores em memória para mock/testes sem Supabase. */
const providers = new Map<string, PaymentProviderRecord>();
const registrations = new Map<string, RegistrationRecord>();
const payments = new Map<string, PaymentRecord>();
const charges = new Map<string, PaymentChargeRecord>();
const events = new Map<string, PaymentEventRecord>();
const reservations = new Map<string, ReservationRecord>();
const athletes = new Map<string, AthleteRecord>();
const registrationAthletes = new Map<string, RegistrationAthleteLink>();
const txidToPaymentId = new Map<string, string>();
const externalEventIndex = new Map<string, string>();

export type ExpireRegistrationMode = 'draft' | 'pending_payment';

let expireRegistrationMode: ExpireRegistrationMode = 'draft';

export function setExpireRegistrationMode(mode: ExpireRegistrationMode): void {
  expireRegistrationMode = mode;
}

export function clearPaymentMemoryStore(): void {
  providers.clear();
  registrations.clear();
  payments.clear();
  charges.clear();
  events.clear();
  reservations.clear();
  athletes.clear();
  registrationAthletes.clear();
  txidToPaymentId.clear();
  externalEventIndex.clear();
  seedMockProvider();
}

function seedMockProvider(): void {
  if (providers.size > 0) return;
  const mock: PaymentProviderRecord = {
    id: randomUUID(),
    name: 'Mock Pix',
    code: 'mock',
    environment: 'development',
    isActive: true,
    isDefault: true,
    supportsDynamicCharge: true,
    supportsWebhook: true,
    defaultExpirationSeconds: 1800,
  };
  const sicredi: PaymentProviderRecord = {
    id: randomUUID(),
    name: 'Sicredi Pix',
    code: 'sicredi',
    environment: 'production',
    isActive: true,
    isDefault: false,
    supportsDynamicCharge: true,
    supportsWebhook: true,
    defaultExpirationSeconds: 1800,
  };
  providers.set(mock.id, mock);
  providers.set(sicredi.id, sicredi);
}

seedMockProvider();

/** Seed helpers para testes. */
export function seedRegistrationForTest(
  partial: Partial<RegistrationRecord> & { id: string; totalPrice: number },
): RegistrationRecord {
  const now = nowIso();
  const record: RegistrationRecord = {
    id: partial.id,
    eventId: partial.eventId ?? null,
    categoryId: partial.categoryId ?? null,
    teamId: partial.teamId ?? null,
    registrationNumber: partial.registrationNumber ?? `INS-${partial.id.slice(0, 8)}`,
    format: partial.format ?? 'individual',
    totalPrice: partial.totalPrice,
    status: partial.status ?? 'draft',
    reservationId: partial.reservationId ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
  registrations.set(record.id, record);
  return record;
}

export function seedReservationForTest(
  partial: Partial<ReservationRecord> & { id: string; registrationId: string },
): ReservationRecord {
  const now = nowIso();
  const record: ReservationRecord = {
    id: partial.id,
    registrationId: partial.registrationId,
    categoryId: partial.categoryId ?? null,
    paymentId: partial.paymentId ?? null,
    quantity: partial.quantity ?? 1,
    status: partial.status ?? 'active',
    reservedAt: partial.reservedAt ?? now,
    expiresAt: partial.expiresAt ?? null,
    confirmedAt: partial.confirmedAt ?? null,
    releasedAt: partial.releasedAt ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
  reservations.set(record.id, record);
  const reg = registrations.get(partial.registrationId);
  if (reg) {
    registrations.set(reg.id, { ...reg, reservationId: record.id, updatedAt: now });
  }
  return record;
}

export function seedAthleteForTest(
  partial: Partial<AthleteRecord> & { id: string; fullName: string; cpf: string },
): AthleteRecord {
  const record: AthleteRecord = {
    id: partial.id,
    fullName: partial.fullName,
    cpf: partial.cpf,
  };
  athletes.set(record.id, record);
  return record;
}

export function seedRegistrationAthleteForTest(
  partial: Partial<RegistrationAthleteLink> & {
    id: string;
    registrationId: string;
    athleteId: string;
  },
): RegistrationAthleteLink {
  const record: RegistrationAthleteLink = {
    id: partial.id,
    registrationId: partial.registrationId,
    athleteId: partial.athleteId,
    role: partial.role ?? null,
  };
  registrationAthletes.set(record.id, record);
  return record;
}

function mapProvider(row: Record<string, unknown>): PaymentProviderRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    code: String(row.code),
    environment: (row.environment as string) ?? null,
    isActive: Boolean(row.is_active),
    isDefault: Boolean(row.is_default),
    supportsDynamicCharge: Boolean(row.supports_dynamic_charge),
    supportsWebhook: Boolean(row.supports_webhook),
    defaultExpirationSeconds:
      row.default_expiration_seconds != null ? Number(row.default_expiration_seconds) : null,
  };
}

function mapRegistration(row: Record<string, unknown>): RegistrationRecord {
  return {
    id: String(row.id),
    eventId: (row.event_id as string) ?? null,
    categoryId: (row.category_id as string) ?? null,
    teamId: (row.team_id as string) ?? null,
    registrationNumber: String(row.registration_number),
    format: (row.format as string) ?? null,
    totalPrice: Number(row.total_price),
    status: row.status as RegistrationStatus,
    reservationId: (row.reservation_id as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPayment(row: Record<string, unknown>): PaymentRecord {
  return {
    id: String(row.id),
    registrationId: (row.registration_id as string) ?? null,
    teamId: (row.team_id as string) ?? null,
    athleteId: (row.athlete_id as string) ?? null,
    providerId: String(row.provider_id),
    amount: Number(row.amount),
    discountAmount: Number(row.discount_amount ?? 0),
    feeAmount: Number(row.fee_amount ?? 0),
    totalAmount: Number(row.total_amount),
    currency: String(row.currency ?? 'BRL'),
    paymentMethod: String(row.payment_method ?? 'pix'),
    status: row.status as PaymentStatusV2,
    externalReference: (row.external_reference as string) ?? null,
    providerChargeId: (row.provider_charge_id as string) ?? null,
    txid: (row.txid as string) ?? null,
    endToEndId: (row.end_to_end_id as string) ?? null,
    expiresAt: (row.expires_at as string) ?? null,
    paidAt: (row.paid_at as string) ?? null,
    pricingSnapshot: (row.pricing_snapshot as Record<string, unknown>) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapCharge(row: Record<string, unknown>): PaymentChargeRecord {
  return {
    id: String(row.id),
    paymentId: String(row.payment_id),
    providerId: String(row.provider_id),
    txid: String(row.txid),
    providerChargeId: (row.provider_charge_id as string) ?? null,
    pixCopyPaste: (row.pix_copy_paste as string) ?? null,
    qrCodeData: (row.qr_code_data as string) ?? null,
    qrCodeImageUrl: (row.qr_code_image_url as string) ?? null,
    amount: Number(row.amount),
    status: row.status as PaymentStatusV2,
    expiresAt: (row.expires_at as string) ?? null,
    rawRequest: (row.raw_request as Record<string, unknown>) ?? null,
    rawResponse: (row.raw_response as Record<string, unknown>) ?? null,
    isCurrent: Boolean(row.is_current),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEvent(row: Record<string, unknown>): PaymentEventRecord {
  return {
    id: String(row.id),
    paymentId: (row.payment_id as string) ?? null,
    providerId: (row.provider_id as string) ?? null,
    eventType: String(row.event_type),
    externalEventId: (row.external_event_id as string) ?? null,
    payload: row.payload,
    signatureValid: row.signature_valid == null ? null : Boolean(row.signature_valid),
    processed: Boolean(row.processed),
    processingError: (row.processing_error as string) ?? null,
    receivedAt: String(row.received_at),
    processedAt: (row.processed_at as string) ?? null,
  };
}

export class PaymentRepository {
  async findRegistrationById(registrationId: string): Promise<RegistrationRecord | null> {
    const supabase = getSupabase();
    if (!supabase) return registrations.get(registrationId) ?? null;

    const { data, error } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .maybeSingle();
    if (error) throw AppError.internal(error.message);
    return data ? mapRegistration(data as Record<string, unknown>) : null;
  }

  /**
   * Resolve vínculo registration_athletes → athletes.
   * Prefere role = athlete_a; em individual sem athlete_a usa o primeiro vínculo.
   */
  async findPrimaryAthleteForRegistration(
    registrationId: string,
    format?: string | null,
  ): Promise<AthleteRecord> {
    const supabase = getSupabase();

    if (!supabase) {
      const links = Array.from(registrationAthletes.values()).filter(
        (l) => l.registrationId === registrationId,
      );
      if (links.length === 0) {
        throw AppError.unprocessable(
          'Nenhum atleta vinculado à inscrição',
          'ATHLETE_NOT_LINKED',
        );
      }
      const preferred =
        links.find((l) => (l.role ?? '').toLowerCase() === 'athlete_a') ??
        ((format ?? '').toLowerCase() === 'individual' ? links[0] : undefined) ??
        links.find((l) => (l.role ?? '').toLowerCase() === 'athlete_a') ??
        links[0];
      if (!preferred) {
        throw AppError.unprocessable(
          'Nenhum atleta vinculado à inscrição',
          'ATHLETE_NOT_LINKED',
        );
      }
      const athlete = athletes.get(preferred.athleteId);
      if (!athlete) {
        throw AppError.unprocessable(
          'Atleta vinculado não encontrado',
          'ATHLETE_NOT_LINKED',
        );
      }
      return athlete;
    }

    const { data: links, error: linkError } = await supabase
      .from('registration_athletes')
      .select('id, registration_id, athlete_id, role')
      .eq('registration_id', registrationId);

    if (linkError) throw AppError.internal(linkError.message);
    if (!links || links.length === 0) {
      throw AppError.unprocessable(
        'Nenhum atleta vinculado à inscrição',
        'ATHLETE_NOT_LINKED',
      );
    }

    const mapped = links.map((row) => ({
      id: String(row.id),
      registrationId: String(row.registration_id),
      athleteId: String(row.athlete_id),
      role: (row.role as string) ?? null,
    }));

    const preferred =
      mapped.find((l) => (l.role ?? '').toLowerCase() === 'athlete_a') ??
      ((format ?? '').toLowerCase() === 'individual' ? mapped[0] : undefined) ??
      mapped[0];

    if (!preferred) {
      throw AppError.unprocessable(
        'Nenhum atleta vinculado à inscrição',
        'ATHLETE_NOT_LINKED',
      );
    }

    const { data: athleteRow, error: athleteError } = await supabase
      .from('athletes')
      .select('id, full_name, cpf')
      .eq('id', preferred.athleteId)
      .maybeSingle();

    if (athleteError) throw AppError.internal(athleteError.message);
    if (!athleteRow) {
      throw AppError.unprocessable(
        'Atleta vinculado não encontrado',
        'ATHLETE_NOT_LINKED',
      );
    }

    return {
      id: String(athleteRow.id),
      fullName: String(athleteRow.full_name ?? ''),
      cpf: String(athleteRow.cpf ?? ''),
    };
  }

  async findProviderByCode(code: string): Promise<PaymentProviderRecord | null> {
    const supabase = getSupabase();
    if (!supabase) {
      for (const p of providers.values()) {
        if (p.code === code && p.isActive) return p;
      }
      return null;
    }

    const { data, error } = await supabase
      .from('payment_providers')
      .select('*')
      .eq('code', code)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw AppError.internal(error.message);
    return data ? mapProvider(data as Record<string, unknown>) : null;
  }

  async createPayment(data: {
    registrationId: string;
    providerId: string;
    amount: number;
    totalAmount: number;
    discountAmount?: number;
    feeAmount?: number;
    currency?: string;
    paymentMethod?: string;
    status?: PaymentStatusV2;
    externalReference?: string | null;
    pricingSnapshot?: Record<string, unknown> | null;
    teamId?: string | null;
    athleteId?: string | null;
  }): Promise<PaymentRecord> {
    const now = nowIso();
    const record: PaymentRecord = {
      id: randomUUID(),
      registrationId: data.registrationId,
      teamId: data.teamId ?? null,
      athleteId: data.athleteId ?? null,
      providerId: data.providerId,
      amount: data.amount,
      discountAmount: data.discountAmount ?? 0,
      feeAmount: data.feeAmount ?? 0,
      totalAmount: data.totalAmount,
      currency: data.currency ?? 'BRL',
      paymentMethod: data.paymentMethod ?? 'pix',
      status: data.status ?? 'pending',
      externalReference: data.externalReference ?? null,
      providerChargeId: null,
      txid: null,
      endToEndId: null,
      expiresAt: null,
      paidAt: null,
      pricingSnapshot: data.pricingSnapshot ?? null,
      createdAt: now,
      updatedAt: now,
    };

    const supabase = getSupabase();
    if (!supabase) {
      payments.set(record.id, record);
      return record;
    }

    const { data: row, error } = await supabase
      .from('payments')
      .insert({
        id: record.id,
        registration_id: record.registrationId,
        team_id: record.teamId,
        athlete_id: record.athleteId,
        provider_id: record.providerId,
        amount: record.amount,
        discount_amount: record.discountAmount,
        fee_amount: record.feeAmount,
        total_amount: record.totalAmount,
        currency: record.currency,
        payment_method: record.paymentMethod,
        status: record.status,
        external_reference: record.externalReference,
        pricing_snapshot: record.pricingSnapshot,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .select()
      .single();

    if (error) throw AppError.internal(`Falha ao criar payment: ${error.message}`);
    return mapPayment(row as Record<string, unknown>);
  }

  async createPaymentCharge(data: {
    paymentId: string;
    providerId: string;
    txid: string;
    providerChargeId?: string | null;
    pixCopyPaste?: string | null;
    qrCodeData?: string | null;
    qrCodeImageUrl?: string | null;
    amount: number;
    status?: PaymentStatusV2;
    expiresAt?: string | null;
    rawRequest?: Record<string, unknown> | null;
    rawResponse?: Record<string, unknown> | null;
    isCurrent?: boolean;
  }): Promise<PaymentChargeRecord> {
    const now = nowIso();
    const record: PaymentChargeRecord = {
      id: randomUUID(),
      paymentId: data.paymentId,
      providerId: data.providerId,
      txid: data.txid,
      providerChargeId: data.providerChargeId ?? null,
      pixCopyPaste: data.pixCopyPaste ?? null,
      qrCodeData: data.qrCodeData ?? null,
      qrCodeImageUrl: data.qrCodeImageUrl ?? null,
      amount: data.amount,
      status: data.status ?? 'active',
      expiresAt: data.expiresAt ?? null,
      rawRequest: data.rawRequest ?? null,
      rawResponse: data.rawResponse ?? null,
      isCurrent: data.isCurrent ?? true,
      createdAt: now,
      updatedAt: now,
    };

    const supabase = getSupabase();
    if (!supabase) {
      if (record.isCurrent) {
        for (const [id, c] of charges) {
          if (c.paymentId === record.paymentId && c.isCurrent) {
            charges.set(id, { ...c, isCurrent: false, updatedAt: now });
          }
        }
      }
      charges.set(record.id, record);
      return record;
    }

    if (record.isCurrent) {
      await supabase
        .from('payment_charges')
        .update({ is_current: false, updated_at: now })
        .eq('payment_id', record.paymentId)
        .eq('is_current', true);
    }

    const { data: row, error } = await supabase
      .from('payment_charges')
      .insert({
        id: record.id,
        payment_id: record.paymentId,
        provider_id: record.providerId,
        txid: record.txid,
        provider_charge_id: record.providerChargeId,
        pix_copy_paste: record.pixCopyPaste,
        qr_code_data: record.qrCodeData,
        qr_code_image_url: record.qrCodeImageUrl,
        amount: record.amount,
        status: record.status,
        expires_at: record.expiresAt,
        raw_request: record.rawRequest,
        raw_response: record.rawResponse,
        is_current: record.isCurrent,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .select()
      .single();

    if (error) throw AppError.internal(`Falha ao criar payment_charge: ${error.message}`);
    return mapCharge(row as Record<string, unknown>);
  }

  async findPaymentById(paymentId: string): Promise<PaymentRecord | null> {
    const supabase = getSupabase();
    if (!supabase) return payments.get(paymentId) ?? null;

    const { data, error } = await supabase.from('payments').select('*').eq('id', paymentId).maybeSingle();
    if (error) throw AppError.internal(error.message);
    return data ? mapPayment(data as Record<string, unknown>) : null;
  }

  async findPaymentByTxid(txid: string): Promise<PaymentRecord | null> {
    const supabase = getSupabase();
    if (!supabase) {
      const id = txidToPaymentId.get(txid);
      if (id) return payments.get(id) ?? null;
      for (const p of payments.values()) {
        if (p.txid === txid) return p;
      }
      return null;
    }

    const { data, error } = await supabase.from('payments').select('*').eq('txid', txid).maybeSingle();
    if (error) throw AppError.internal(error.message);
    return data ? mapPayment(data as Record<string, unknown>) : null;
  }

  async findCurrentChargeByPaymentId(paymentId: string): Promise<PaymentChargeRecord | null> {
    const supabase = getSupabase();
    if (!supabase) {
      for (const c of charges.values()) {
        if (c.paymentId === paymentId && c.isCurrent) return c;
      }
      return null;
    }

    const { data, error } = await supabase
      .from('payment_charges')
      .select('*')
      .eq('payment_id', paymentId)
      .eq('is_current', true)
      .maybeSingle();
    if (error) throw AppError.internal(error.message);
    return data ? mapCharge(data as Record<string, unknown>) : null;
  }

  async updatePaymentStatus(
    paymentId: string,
    status: PaymentStatusV2,
    data?: {
      txid?: string | null;
      providerChargeId?: string | null;
      endToEndId?: string | null;
      expiresAt?: string | null;
      paidAt?: string | null;
      pricingSnapshot?: Record<string, unknown> | null;
    },
  ): Promise<PaymentRecord> {
    const now = nowIso();
    const supabase = getSupabase();

    if (!supabase) {
      const existing = payments.get(paymentId);
      if (!existing) throw AppError.notFound('Pagamento não encontrado');
      const updated: PaymentRecord = {
        ...existing,
        status,
        updatedAt: now,
        ...(data?.txid !== undefined ? { txid: data.txid } : {}),
        ...(data?.providerChargeId !== undefined
          ? { providerChargeId: data.providerChargeId }
          : {}),
        ...(data?.endToEndId !== undefined ? { endToEndId: data.endToEndId } : {}),
        ...(data?.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
        ...(data?.paidAt !== undefined ? { paidAt: data.paidAt } : {}),
        ...(data?.pricingSnapshot !== undefined
          ? { pricingSnapshot: data.pricingSnapshot }
          : {}),
      };
      payments.set(paymentId, updated);
      if (updated.txid) txidToPaymentId.set(updated.txid, paymentId);
      return updated;
    }

    const payload: Record<string, unknown> = { status, updated_at: now };
    if (data?.txid !== undefined) payload.txid = data.txid;
    if (data?.providerChargeId !== undefined) payload.provider_charge_id = data.providerChargeId;
    if (data?.endToEndId !== undefined) payload.end_to_end_id = data.endToEndId;
    if (data?.expiresAt !== undefined) payload.expires_at = data.expiresAt;
    if (data?.paidAt !== undefined) payload.paid_at = data.paidAt;
    if (data?.pricingSnapshot !== undefined) payload.pricing_snapshot = data.pricingSnapshot;

    const { data: row, error } = await supabase
      .from('payments')
      .update(payload)
      .eq('id', paymentId)
      .select()
      .single();
    if (error) throw AppError.internal(error.message);
    return mapPayment(row as Record<string, unknown>);
  }

  async updateChargeStatus(
    chargeId: string,
    status: PaymentStatusV2,
    data?: {
      rawResponse?: Record<string, unknown> | null;
      expiresAt?: string | null;
      isCurrent?: boolean;
    },
  ): Promise<PaymentChargeRecord> {
    const now = nowIso();
    const supabase = getSupabase();

    if (!supabase) {
      const existing = charges.get(chargeId);
      if (!existing) throw AppError.notFound('Cobrança não encontrada');
      const updated: PaymentChargeRecord = {
        ...existing,
        status,
        updatedAt: now,
        ...(data?.rawResponse !== undefined ? { rawResponse: data.rawResponse } : {}),
        ...(data?.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
        ...(data?.isCurrent !== undefined ? { isCurrent: data.isCurrent } : {}),
      };
      charges.set(chargeId, updated);
      return updated;
    }

    const payload: Record<string, unknown> = { status, updated_at: now };
    if (data?.rawResponse !== undefined) payload.raw_response = data.rawResponse;
    if (data?.expiresAt !== undefined) payload.expires_at = data.expiresAt;
    if (data?.isCurrent !== undefined) payload.is_current = data.isCurrent;

    const { data: row, error } = await supabase
      .from('payment_charges')
      .update(payload)
      .eq('id', chargeId)
      .select()
      .single();
    if (error) throw AppError.internal(error.message);
    return mapCharge(row as Record<string, unknown>);
  }

  async listChargesByPaymentId(paymentId: string): Promise<PaymentChargeRecord[]> {
    const supabase = getSupabase();
    if (!supabase) {
      return Array.from(charges.values())
        .filter((c) => c.paymentId === paymentId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    const { data, error } = await supabase
      .from('payment_charges')
      .select('*')
      .eq('payment_id', paymentId)
      .order('created_at', { ascending: false });
    if (error) throw AppError.internal(error.message);
    return (data ?? []).map((row) => mapCharge(row as Record<string, unknown>));
  }

  async listPaymentsByRegistrationId(registrationId: string): Promise<PaymentRecord[]> {
    const supabase = getSupabase();
    if (!supabase) {
      return Array.from(payments.values())
        .filter((p) => p.registrationId === registrationId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('registration_id', registrationId)
      .order('created_at', { ascending: false });
    if (error) throw AppError.internal(error.message);
    return (data ?? []).map((row) => mapPayment(row as Record<string, unknown>));
  }

  async createPaymentEvent(data: {
    paymentId?: string | null;
    providerId?: string | null;
    eventType: string;
    externalEventId?: string | null;
    payload: unknown;
    signatureValid?: boolean | null;
    processed?: boolean;
    processingError?: string | null;
    receivedAt?: string;
    processedAt?: string | null;
  }): Promise<PaymentEventRecord> {
    if (data.externalEventId) {
      const existing = await this.findPaymentEventByExternalId(data.externalEventId);
      if (existing) {
        throw AppError.conflict('Evento duplicado', 'DUPLICATE_EVENT', {
          eventId: existing.id,
        });
      }
    }

    const now = nowIso();
    const record: PaymentEventRecord = {
      id: randomUUID(),
      paymentId: data.paymentId ?? null,
      providerId: data.providerId ?? null,
      eventType: data.eventType,
      externalEventId: data.externalEventId ?? null,
      payload: data.payload,
      signatureValid: data.signatureValid ?? null,
      processed: data.processed ?? false,
      processingError: data.processingError ?? null,
      receivedAt: data.receivedAt ?? now,
      processedAt: data.processedAt ?? null,
    };

    const supabase = getSupabase();
    if (!supabase) {
      events.set(record.id, record);
      if (record.externalEventId) externalEventIndex.set(record.externalEventId, record.id);
      return record;
    }

    const { data: row, error } = await supabase
      .from('payment_events')
      .insert({
        id: record.id,
        payment_id: record.paymentId,
        provider_id: record.providerId,
        event_type: record.eventType,
        external_event_id: record.externalEventId,
        payload: record.payload,
        signature_valid: record.signatureValid,
        processed: record.processed,
        processing_error: record.processingError,
        received_at: record.receivedAt,
        processed_at: record.processedAt,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw AppError.conflict('Evento duplicado', 'DUPLICATE_EVENT');
      }
      throw AppError.internal(error.message);
    }
    return mapEvent(row as Record<string, unknown>);
  }

  async findPaymentEventByExternalId(externalEventId: string): Promise<PaymentEventRecord | null> {
    const supabase = getSupabase();
    if (!supabase) {
      const id = externalEventIndex.get(externalEventId);
      return id ? (events.get(id) ?? null) : null;
    }

    const { data, error } = await supabase
      .from('payment_events')
      .select('*')
      .eq('external_event_id', externalEventId)
      .maybeSingle();
    if (error) throw AppError.internal(error.message);
    return data ? mapEvent(data as Record<string, unknown>) : null;
  }

  async findPaymentEventById(id: string): Promise<PaymentEventRecord | null> {
    const supabase = getSupabase();
    if (!supabase) return events.get(id) ?? null;

    const { data, error } = await supabase.from('payment_events').select('*').eq('id', id).maybeSingle();
    if (error) throw AppError.internal(error.message);
    return data ? mapEvent(data as Record<string, unknown>) : null;
  }

  async listPaymentEvents(limit = 50): Promise<PaymentEventRecord[]> {
    const supabase = getSupabase();
    if (!supabase) {
      return Array.from(events.values())
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, limit);
    }

    const { data, error } = await supabase
      .from('payment_events')
      .select('*')
      .order('received_at', { ascending: false })
      .limit(limit);
    if (error) throw AppError.internal(error.message);
    return (data ?? []).map((row) => mapEvent(row as Record<string, unknown>));
  }

  async markPaymentEventProcessed(eventId: string): Promise<void> {
    const now = nowIso();
    const supabase = getSupabase();
    if (!supabase) {
      const existing = events.get(eventId);
      if (existing) {
        events.set(eventId, {
          ...existing,
          processed: true,
          processedAt: now,
          processingError: null,
        });
      }
      return;
    }

    const { error } = await supabase
      .from('payment_events')
      .update({ processed: true, processed_at: now, processing_error: null })
      .eq('id', eventId);
    if (error) throw AppError.internal(error.message);
  }

  async markPaymentEventFailed(eventId: string, errorMessage: string): Promise<void> {
    const now = nowIso();
    const supabase = getSupabase();
    if (!supabase) {
      const existing = events.get(eventId);
      if (existing) {
        events.set(eventId, {
          ...existing,
          processed: false,
          processingError: errorMessage,
          processedAt: now,
        });
      }
      return;
    }

    const { error } = await supabase
      .from('payment_events')
      .update({
        processed: false,
        processing_error: errorMessage,
        processed_at: now,
      })
      .eq('id', eventId);
    if (error) throw AppError.internal(error.message);
  }

  async updateRegistrationStatus(
    registrationId: string,
    status: RegistrationStatus,
  ): Promise<RegistrationRecord> {
    const now = nowIso();
    const supabase = getSupabase();
    if (!supabase) {
      const existing = registrations.get(registrationId);
      if (!existing) throw AppError.notFound('Inscrição não encontrada');
      const updated = { ...existing, status, updatedAt: now };
      registrations.set(registrationId, updated);
      return updated;
    }

    const { data, error } = await supabase
      .from('registrations')
      .update({ status, updated_at: now })
      .eq('id', registrationId)
      .select()
      .single();
    if (error) throw AppError.internal(error.message);
    return mapRegistration(data as Record<string, unknown>);
  }

  async confirmRegistration(registrationId: string): Promise<RegistrationRecord> {
    // Financeiro: liquidação → paid (não confirmed).
    return this.updateRegistrationStatus(registrationId, 'paid');
  }

  async linkActiveReservationPayment(
    registrationId: string,
    paymentId: string,
  ): Promise<ReservationRecord | null> {
    const now = nowIso();
    const supabase = getSupabase();

    if (!supabase) {
      for (const [id, r] of reservations) {
        if (r.registrationId === registrationId && r.status === 'active') {
          const updated = { ...r, paymentId, updatedAt: now };
          reservations.set(id, updated);
          return updated;
        }
      }
      const reg = registrations.get(registrationId);
      if (reg?.reservationId) {
        const r = reservations.get(reg.reservationId);
        if (r && r.status === 'active') {
          const updated = { ...r, paymentId, updatedAt: now };
          reservations.set(r.id, updated);
          return updated;
        }
      }
      return null;
    }

    const { data, error } = await supabase
      .from('registration_reservations')
      .update({ payment_id: paymentId, updated_at: now })
      .eq('registration_id', registrationId)
      .eq('status', 'active')
      .select()
      .maybeSingle();

    if (error) {
      logger.warn('Falha ao vincular reservation', { message: error.message });
      return null;
    }
    if (!data) return null;

    return {
      id: String(data.id),
      registrationId: String(data.registration_id),
      categoryId: (data.category_id as string) ?? null,
      paymentId: (data.payment_id as string) ?? null,
      quantity: Number(data.quantity ?? 1),
      status: data.status as ReservationStatus,
      reservedAt: (data.reserved_at as string) ?? null,
      expiresAt: (data.expires_at as string) ?? null,
      confirmedAt: (data.confirmed_at as string) ?? null,
      releasedAt: (data.released_at as string) ?? null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    };
  }

  async confirmReservation(
    paymentId: string,
    registrationId: string,
  ): Promise<ReservationRecord | null> {
    const now = nowIso();
    const supabase = getSupabase();

    if (!supabase) {
      for (const [id, r] of reservations) {
        if (
          r.registrationId === registrationId &&
          (r.paymentId === paymentId || r.status === 'active')
        ) {
          const updated: ReservationRecord = {
            ...r,
            paymentId,
            status: 'confirmed',
            confirmedAt: now,
            updatedAt: now,
          };
          reservations.set(id, updated);
          return updated;
        }
      }
      return null;
    }

    const { data, error } = await supabase
      .from('registration_reservations')
      .update({
        status: 'confirmed',
        payment_id: paymentId,
        confirmed_at: now,
        updated_at: now,
      })
      .eq('registration_id', registrationId)
      .or(`payment_id.eq.${paymentId},status.eq.active`)
      .select()
      .maybeSingle();

    if (error) throw AppError.internal(error.message);
    if (!data) return null;

    return {
      id: String(data.id),
      registrationId: String(data.registration_id),
      categoryId: (data.category_id as string) ?? null,
      paymentId: (data.payment_id as string) ?? null,
      quantity: Number(data.quantity ?? 1),
      status: data.status as ReservationStatus,
      reservedAt: (data.reserved_at as string) ?? null,
      expiresAt: (data.expires_at as string) ?? null,
      confirmedAt: (data.confirmed_at as string) ?? null,
      releasedAt: (data.released_at as string) ?? null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    };
  }

  async expireReservation(
    paymentId: string,
    registrationId: string,
  ): Promise<ReservationRecord | null> {
    const now = nowIso();
    const supabase = getSupabase();

    if (!supabase) {
      for (const [id, r] of reservations) {
        if (r.paymentId === paymentId || r.registrationId === registrationId) {
          if (r.status === 'active') {
            const updated: ReservationRecord = {
              ...r,
              status: 'released',
              releasedAt: now,
              updatedAt: now,
            };
            reservations.set(id, updated);
            return updated;
          }
        }
      }
      return null;
    }

    const { data, error } = await supabase
      .from('registration_reservations')
      .update({
        status: 'released',
        released_at: now,
        updated_at: now,
      })
      .eq('payment_id', paymentId)
      .eq('status', 'active')
      .select()
      .maybeSingle();

    if (error) throw AppError.internal(error.message);
    if (!data) return null;

    return {
      id: String(data.id),
      registrationId: String(data.registration_id),
      categoryId: (data.category_id as string) ?? null,
      paymentId: (data.payment_id as string) ?? null,
      quantity: Number(data.quantity ?? 1),
      status: data.status as ReservationStatus,
      reservedAt: (data.reserved_at as string) ?? null,
      expiresAt: (data.expires_at as string) ?? null,
      confirmedAt: (data.confirmed_at as string) ?? null,
      releasedAt: (data.released_at as string) ?? null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    };
  }

  /**
   * Confirma pagamento liquidado de forma sequencial atômica o quanto possível.
   * (RPC dedicada pode ser adicionada depois sem alterar o contrato desta API.)
   */
  async confirmPaidAtomically(input: {
    paymentId: string;
    chargeId: string;
    registrationId: string;
    endToEndId: string;
    paidAt: string;
    eventId: string;
    chargeRawResponse?: Record<string, unknown>;
  }): Promise<void> {
    await this.updatePaymentStatus(input.paymentId, 'paid', {
      endToEndId: input.endToEndId,
      paidAt: input.paidAt,
    });
    await this.updateChargeStatus(input.chargeId, 'paid', {
      rawResponse: input.chargeRawResponse ?? null,
    });
    await this.confirmRegistration(input.registrationId);
    await this.confirmReservation(input.paymentId, input.registrationId);
    await this.markPaymentEventProcessed(input.eventId);
  }

  async listPayments(limit = 50): Promise<PaymentRecord[]> {
    const supabase = getSupabase();
    if (!supabase) {
      return Array.from(payments.values())
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    }

    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw AppError.internal(error.message);
    return (data ?? []).map((row) => mapPayment(row as Record<string, unknown>));
  }

  /**
   * Pagamentos Sicredi elegíveis à conciliação por polling:
   * pending/active, com txid, provider sicredi ativo.
   */
  async listReconcilableSicrediPayments(limit = 50): Promise<PaymentRecord[]> {
    const sicredi = await this.findProviderByCode('sicredi');
    if (!sicredi) return [];

    const supabase = getSupabase();
    if (!supabase) {
      return Array.from(payments.values())
        .filter(
          (p) =>
            p.providerId === sicredi.id &&
            (p.status === 'pending' || p.status === 'active') &&
            typeof p.txid === 'string' &&
            p.txid.trim().length > 0,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
    }

    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('provider_id', sicredi.id)
      .in('status', ['pending', 'active'])
      .not('txid', 'is', null)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw AppError.internal(error.message);

    return (data ?? [])
      .map((row) => mapPayment(row as Record<string, unknown>))
      .filter((p) => typeof p.txid === 'string' && p.txid.trim().length > 0);
  }

  async findExpiredActivePayments(reference = new Date()): Promise<PaymentRecord[]> {
    const iso = reference.toISOString();
    const supabase = getSupabase();
    if (!supabase) {
      return Array.from(payments.values()).filter(
        (p) =>
          (p.status === 'pending' || p.status === 'active') &&
          p.expiresAt != null &&
          p.expiresAt <= iso,
      );
    }

    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .in('status', ['pending', 'active'])
      .lte('expires_at', iso);
    if (error) throw AppError.internal(error.message);
    return (data ?? []).map((row) => mapPayment(row as Record<string, unknown>));
  }

  /**
   * Cobranças elegíveis à expiração local:
   * status active/pending, expires_at preenchido e vencido, payment ainda não paid.
   */
  async findExpiredEligibleCharges(
    limit = 50,
    reference = new Date(),
  ): Promise<Array<{ charge: PaymentChargeRecord; payment: PaymentRecord }>> {
    const iso = reference.toISOString();
    const supabase = getSupabase();

    if (!supabase) {
      const pairs: Array<{ charge: PaymentChargeRecord; payment: PaymentRecord }> = [];
      for (const charge of charges.values()) {
        if (charge.status !== 'pending' && charge.status !== 'active') continue;
        if (!charge.expiresAt || charge.expiresAt > iso) continue;
        const payment = payments.get(charge.paymentId);
        if (!payment) continue;
        if (payment.status === 'paid') continue;
        pairs.push({ charge, payment });
      }
      return pairs
        .sort((a, b) => (a.charge.expiresAt ?? '').localeCompare(b.charge.expiresAt ?? ''))
        .slice(0, limit);
    }

    const { data, error } = await supabase
      .from('payment_charges')
      .select('*')
      .in('status', ['pending', 'active'])
      .not('expires_at', 'is', null)
      .lte('expires_at', iso)
      .order('expires_at', { ascending: true })
      .limit(Math.max(limit * 3, limit));

    if (error) throw AppError.internal(error.message);

    const out: Array<{ charge: PaymentChargeRecord; payment: PaymentRecord }> = [];
    for (const row of data ?? []) {
      const charge = mapCharge(row as Record<string, unknown>);
      const payment = await this.findPaymentById(charge.paymentId);
      if (!payment || payment.status === 'paid') continue;
      out.push({ charge, payment });
      if (out.length >= limit) break;
    }
    return out;
  }

  async expirePaymentBundle(payment: PaymentRecord): Promise<void> {
    const charge = await this.findCurrentChargeByPaymentId(payment.id);
    if (payment.status !== 'paid' && payment.status !== 'expired') {
      await this.updatePaymentStatus(payment.id, 'expired');
    }
    if (charge && charge.status !== 'paid' && charge.status !== 'expired') {
      await this.updateChargeStatus(charge.id, 'expired', { isCurrent: false });
    } else if (charge && charge.status === 'expired' && charge.isCurrent) {
      await this.updateChargeStatus(charge.id, 'expired', { isCurrent: false });
    }
    if (payment.registrationId) {
      const registration = await this.findRegistrationById(payment.registrationId);
      if (registration?.status === 'pending_payment') {
        await this.expireReservation(payment.id, payment.registrationId);
        await this.updateRegistrationStatus(payment.registrationId, expireRegistrationMode);
      }
    }
  }

  getExpireRegistrationMode(): ExpireRegistrationMode {
    return expireRegistrationMode;
  }
}

export const paymentRepository = new PaymentRepository();
