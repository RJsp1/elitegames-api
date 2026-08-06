import { getEnv } from '../../config/env.js';
import { paymentRepository } from '../../repositories/payment.repository.js';
import { financialAuditService } from '../audit/financial-audit.service.js';
import type {
  CreatePaymentInput,
  PaymentChargeRecord,
  PaymentRecord,
  PaymentResponse,
  PaymentStatusV2,
  ResolvedDebtor,
} from '../../types/payment.types.js';
import { AppError } from '../../utils/app-error.js';
import { addSeconds, isExpired, nowIso } from '../../utils/date.js';
import { generateTxid } from '../../utils/txid.js';
import { logger } from '../../utils/logger.js';
import { assertValidCpf, maskCpfDisplay } from '../../utils/cpf.js';
import { getPaymentProvider } from './payment-provider.factory.js';
import { qrCodeService } from '../qr-code.service.js';
import { centsToPixAmount } from '../../utils/money.js';
import { redactSensitiveData } from '../../utils/redact-sensitive-data.js';

const BLOCKED_REGISTRATION_STATUSES = new Set(['cancelled', 'refunded', 'confirmed']);

function formatAmount(value: number): string {
  return Number(value).toFixed(2);
}

function resolveProviderCode(): 'mock' | 'sicredi' {
  return getEnv().PAYMENT_PROVIDER === 'sicredi' ? 'sicredi' : 'mock';
}

async function toResponse(
  payment: PaymentRecord,
  charge?: PaymentChargeRecord | null,
): Promise<PaymentResponse> {
  const current =
    charge ?? (await paymentRepository.findCurrentChargeByPaymentId(payment.id));
  const registration = payment.registrationId
    ? await paymentRepository.findRegistrationById(payment.registrationId)
    : null;
  const provider = await paymentRepository.findProviderByCode(resolveProviderCode());

  return {
    paymentId: payment.id,
    chargeId: current?.id ?? null,
    txid: payment.txid ?? current?.txid ?? null,
    status: payment.status,
    amount: formatAmount(payment.totalAmount),
    amountNumeric: Number(payment.totalAmount),
    pixCopiaECola: current?.pixCopyPaste ?? null,
    qrCodeDataUrl: current?.qrCodeData ?? current?.qrCodeImageUrl ?? null,
    expiresAt: payment.expiresAt ?? current?.expiresAt ?? null,
    registrationId: payment.registrationId,
    registrationNumber: registration?.registrationNumber ?? null,
    provider: provider?.code ?? resolveProviderCode(),
  };
}

export class PaymentService {
  /**
   * Resolve pagador a partir de registration_athletes → athletes.
   * Preferência: role athlete_a.
   */
  async resolveDebtorForRegistration(registrationId: string): Promise<ResolvedDebtor> {
    const registration = await paymentRepository.findRegistrationById(registrationId);
    if (!registration) {
      throw AppError.notFound('Inscrição não encontrada', 'REGISTRATION_NOT_FOUND');
    }

    const athlete = await paymentRepository.findPrimaryAthleteForRegistration(
      registration.id,
      registration.format,
    );

    const fullName = athlete.fullName?.trim();
    if (!fullName) {
      throw AppError.unprocessable('Atleta sem full_name', 'ATHLETE_NAME_REQUIRED');
    }
    if (!athlete.cpf?.trim()) {
      throw AppError.unprocessable('Atleta sem CPF', 'ATHLETE_CPF_REQUIRED');
    }

    const cpfDigits = assertValidCpf(athlete.cpf);

    return {
      athleteId: athlete.id,
      fullName,
      cpfDigits,
    };
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentResponse> {
    const env = getEnv();

    const registration = await paymentRepository.findRegistrationById(input.registrationId);
    if (!registration) {
      throw AppError.notFound('Inscrição não encontrada', 'REGISTRATION_NOT_FOUND');
    }

    if (BLOCKED_REGISTRATION_STATUSES.has(registration.status)) {
      throw AppError.badRequest(
        `Inscrição não pode ser cobrada no status '${registration.status}'`,
        'REGISTRATION_STATUS_BLOCKED',
      );
    }

    const amount = Number(registration.totalPrice);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw AppError.unprocessable(
        'registrations.total_price inválido para cobrança',
        'INVALID_TOTAL_PRICE',
      );
    }

    const debtor = await this.resolveDebtorForRegistration(registration.id);

    logger.info('Pagador resolvido para cobrança', {
      registrationId: registration.id,
      athleteId: debtor.athleteId,
      pagador: debtor.fullName,
      cpfMascarado: maskCpfDisplay(debtor.cpfDigits),
    });

    const providerCode = resolveProviderCode();
    const providerRow = await paymentRepository.findProviderByCode(providerCode);
    if (!providerRow) {
      throw AppError.serviceUnavailable(
        `Provedor '${providerCode}' não encontrado ou inativo em payment_providers`,
        'PROVIDER_NOT_FOUND',
      );
    }

    const expirationSeconds =
      providerRow.defaultExpirationSeconds ?? env.PIX_CHARGE_EXPIRATION_SECONDS;

    const payment = await paymentRepository.createPayment({
      registrationId: registration.id,
      providerId: providerRow.id,
      amount,
      totalAmount: amount,
      discountAmount: 0,
      feeAmount: 0,
      currency: 'BRL',
      paymentMethod: 'pix',
      status: 'pending',
      externalReference: registration.registrationNumber,
      teamId: registration.teamId,
      athleteId: debtor.athleteId,
      pricingSnapshot: {
        total_price: amount,
        format: registration.format,
        registration_number: registration.registrationNumber,
        priced_at: nowIso(),
        debtor_name: debtor.fullName,
        debtor_cpf_masked: maskCpfDisplay(debtor.cpfDigits),
      },
    });

    await financialAuditService.paymentCreated({
      paymentId: payment.id,
      status: payment.status,
      amount,
      provider: providerCode,
      registrationId: registration.id,
    });

    try {
      const txid = generateTxid('EG');
      const pixProvider = await getPaymentProvider();
      const amountOriginal = formatAmount(amount);

      const chargeResult = await pixProvider.createCharge({
        txid,
        amountOriginal,
        expirationSeconds,
        debtorName: debtor.fullName,
        debtorCpf: debtor.cpfDigits,
        registrationNumber: registration.registrationNumber,
        categoryName: registration.format ?? 'inscricao',
        solicitacaoPagador: 'Inscrição Elite Games 2026',
      });

      const qrCodeDataUrl = await qrCodeService.toDataUrl(chargeResult.pixCopiaECola);
      const expiresAt =
        chargeResult.expiresAt || addSeconds(new Date(), expirationSeconds).toISOString();

      const updatedPayment = await paymentRepository.updatePaymentStatus(payment.id, 'active', {
        txid: chargeResult.txid,
        providerChargeId: chargeResult.providerChargeId ?? chargeResult.txid,
        expiresAt,
      });

      await financialAuditService.paymentStatusChanged({
        paymentId: payment.id,
        previousStatus: payment.status,
        newStatus: updatedPayment.status,
        reason: 'payment_create',
      });

      const charge = await paymentRepository.createPaymentCharge({
        paymentId: payment.id,
        providerId: providerRow.id,
        txid: chargeResult.txid,
        providerChargeId: chargeResult.providerChargeId ?? chargeResult.txid,
        pixCopyPaste: chargeResult.pixCopiaECola,
        qrCodeData: qrCodeDataUrl,
        qrCodeImageUrl: null,
        amount,
        status: 'active',
        expiresAt,
        rawRequest:
          (redactSensitiveData(
            chargeResult.rawRequest ?? {
              txid: chargeResult.txid,
              amount: amountOriginal,
              expirationSeconds,
              possuiDevedor: true,
            },
          ) as Record<string, unknown>) ?? null,
        rawResponse:
          (redactSensitiveData(chargeResult.raw ?? {}) as Record<string, unknown>) ?? null,
        isCurrent: true,
      });

      await financialAuditService.pixChargeCreated({
        chargeId: charge.id,
        paymentId: payment.id,
        txid: charge.txid,
        status: charge.status,
        amount: charge.amount,
        expiresAt: charge.expiresAt,
        isCurrent: charge.isCurrent,
      });

      const previousRegistrationStatus = registration.status;
      await paymentRepository.updateRegistrationStatus(registration.id, 'pending_payment');
      await paymentRepository.linkActiveReservationPayment(registration.id, payment.id);

      await financialAuditService.registrationStatusChanged({
        registrationId: registration.id,
        previousStatus: previousRegistrationStatus,
        newStatus: 'pending_payment',
        paymentId: payment.id,
        reason: 'payment_create',
      });

      logger.info('Pagamento criado', {
        paymentId: payment.id,
        txid: chargeResult.txid,
        amount,
        registrationId: registration.id,
      });

      return toResponse(updatedPayment, charge);
    } catch (err) {
      await paymentRepository.updatePaymentStatus(payment.id, 'failed').catch(() => undefined);
      throw err;
    }
  }

  async getPayment(paymentId: string): Promise<PaymentResponse> {
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) throw AppError.notFound('Pagamento não encontrado');

    if (
      (payment.status === 'pending' || payment.status === 'active') &&
      payment.expiresAt &&
      isExpired(payment.expiresAt)
    ) {
      await paymentRepository.expirePaymentBundle(payment);
      const expired = await paymentRepository.findPaymentById(paymentId);
      return toResponse(expired!);
    }

    return toResponse(payment);
  }

  async refreshPayment(paymentId: string): Promise<PaymentResponse> {
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) throw AppError.notFound('Pagamento não encontrado');
    if (payment.status === 'paid') return toResponse(payment);
    if (!payment.txid) throw AppError.badRequest('Pagamento sem txid');

    const provider = await getPaymentProvider();
    const remote = await provider.getCharge(payment.txid);
    const charge = await paymentRepository.findCurrentChargeByPaymentId(payment.id);

    const updated = await paymentRepository.updatePaymentStatus(payment.id, remote.status, {
      endToEndId: remote.endToEndId ?? payment.endToEndId,
      paidAt: remote.paidAt ?? (remote.status === 'paid' ? nowIso() : payment.paidAt),
    });

    if (charge) {
      await paymentRepository.updateChargeStatus(charge.id, remote.status, {
        rawResponse: (redactSensitiveData(remote.raw ?? {}) as Record<string, unknown>) ?? null,
      });
    }

    if (updated.status === 'paid' && payment.registrationId && charge) {
      const event = await paymentRepository.createPaymentEvent({
        paymentId: payment.id,
        providerId: payment.providerId,
        eventType: 'payment_refreshed_paid',
        externalEventId: remote.endToEndId
          ? `refresh:${remote.endToEndId}`
          : `refresh:${payment.id}:${Date.now()}`,
        payload: redactSensitiveData(remote.raw ?? remote),
        processed: false,
      });
      await paymentRepository.confirmPaidAtomically({
        paymentId: payment.id,
        chargeId: charge.id,
        registrationId: payment.registrationId,
        endToEndId: remote.endToEndId ?? `REFRESH${Date.now()}`,
        paidAt: remote.paidAt ?? nowIso(),
        eventId: event.id,
        chargeRawResponse:
          (redactSensitiveData(remote.raw ?? {}) as Record<string, unknown>) ?? undefined,
      });
    }

    const finalPayment = await paymentRepository.findPaymentById(paymentId);
    return toResponse(finalPayment!);
  }

  async reconcilePayment(paymentId: string): Promise<PaymentResponse> {
    return this.refreshPayment(paymentId);
  }

  async refundPayment(
    paymentId: string,
    amountCents?: number,
  ): Promise<{ payment: PaymentResponse; refund?: unknown }> {
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) throw AppError.notFound('Pagamento não encontrado');
    if (payment.status !== 'paid') {
      throw AppError.badRequest('Somente pagamentos paid podem ser estornados', 'INVALID_STATUS');
    }
    if (!payment.endToEndId) {
      throw AppError.badRequest('Pagamento sem endToEndId', 'MISSING_E2E');
    }

    const provider = await getPaymentProvider();
    if (!provider.refund) {
      throw AppError.serviceUnavailable('Estorno não suportado pelo provedor atual');
    }

    const refundAmount = amountCents
      ? centsToPixAmount(amountCents)
      : formatAmount(payment.totalAmount);

    const refundId = generateTxid('RF').slice(0, 26);
    const result = await provider.refund({
      endToEndId: payment.endToEndId,
      refundId,
      amountOriginal: refundAmount,
    });

    const nextStatus: PaymentStatusV2 =
      amountCents && amountCents < Math.round(Number(payment.totalAmount) * 100)
        ? 'partially_refunded'
        : 'refunded';

    const updated = await paymentRepository.updatePaymentStatus(payment.id, nextStatus);
    return { payment: await toResponse(updated), refund: result };
  }

  async simulatePaid(paymentId: string): Promise<PaymentResponse> {
    const env = getEnv();
    if (env.isProduction || env.NODE_ENV === 'production') {
      throw AppError.forbidden('Simulação bloqueada em produção', 'DEV_ONLY');
    }
    if (!env.isMock) {
      throw AppError.badRequest('Simulação disponível apenas com PAYMENT_PROVIDER=mock');
    }

    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) throw AppError.notFound('Pagamento não encontrado');
    if (!payment.txid) throw AppError.badRequest('Pagamento sem txid');
    if (!payment.registrationId) {
      throw AppError.badRequest('Pagamento sem registration_id');
    }

    const charge = await paymentRepository.findCurrentChargeByPaymentId(payment.id);
    if (!charge) throw AppError.notFound('Cobrança atual não encontrada');

    const provider = await getPaymentProvider();
    if (!provider.simulatePaid) {
      throw AppError.serviceUnavailable('Provedor não suporta simulação');
    }

    const remote = await provider.simulatePaid(payment.id, payment.txid);
    const endToEndId = remote.endToEndId ?? `E2EMOCK${Date.now()}`.slice(0, 32);
    const paidAt = remote.paidAt ?? nowIso();

    const event = await paymentRepository.createPaymentEvent({
      paymentId: payment.id,
      providerId: payment.providerId,
      eventType: 'pix_received',
      externalEventId: endToEndId,
      payload: {
        simulated: true,
        endToEndId,
        txid: payment.txid,
        valor: formatAmount(payment.totalAmount),
      },
      signatureValid: true,
      processed: false,
    });

    await paymentRepository.confirmPaidAtomically({
      paymentId: payment.id,
      chargeId: charge.id,
      registrationId: payment.registrationId,
      endToEndId,
      paidAt,
      eventId: event.id,
      chargeRawResponse: { simulated: true },
    });

    const finalPayment = await paymentRepository.findPaymentById(paymentId);
    return toResponse(finalPayment!);
  }

  async listPayments(limit = 50): Promise<PaymentResponse[]> {
    const list = await paymentRepository.listPayments(limit);
    const out: PaymentResponse[] = [];
    for (const p of list) {
      out.push(await toResponse(p));
    }
    return out;
  }
}

export const paymentService = new PaymentService();
