import { ASAAS_PROVIDER_CODE, getAsaasConfig } from '../../config/asaas.js';
import { paymentRepository } from '../../repositories/payment.repository.js';
import type { CreateCardPaymentBody } from '../../schemas/card-payment.schema.js';
import type { PaymentRecord, PaymentStatusV2 } from '../../types/payment.types.js';
import { AppError } from '../../utils/app-error.js';
import { nowIso } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import { maskCpf, redactSensitiveData } from '../../utils/redact-sensitive-data.js';
import { financialAuditService } from '../audit/financial-audit.service.js';
import { toPublicRegistrationNumber } from '../public/public-registration.service.js';
import {
  asaasClient,
  AsaasDeclinedError,
  AsaasUnavailableError,
  type AsaasPayment,
} from './asaas-client.js';
import {
  ACCEPTED_CARD_BRANDS,
  brandInstallmentLimit,
  detectAcceptedBrand,
  expectedCvvLength,
  isCardExpired,
  passesLuhn,
  type AcceptedCardBrand,
} from './card-brand.js';
import { listInstallmentOptions, maxInstallmentsFor, quoteCard, type CardQuote } from './card-pricing.js';

export const CARD_PAYMENT_METHOD = 'credit_card';

const CARD_ELIGIBLE_REGISTRATION = new Set(['draft', 'pending_payment']);
const cardLocks = new Set<string>();

/** Status de cobrança do Asaas → status local. */
export function mapAsaasStatus(status: string | undefined): PaymentStatusV2 {
  switch (status) {
    case 'CONFIRMED':
    case 'RECEIVED':
    case 'RECEIVED_IN_CASH':
      return 'paid';
    case 'PENDING':
    case 'AWAITING_RISK_ANALYSIS':
      return 'under_review';
    case 'REFUNDED':
    case 'REFUND_REQUESTED':
    case 'REFUND_IN_PROGRESS':
      return 'refunded';
    default:
      return 'failed';
  }
}

function saoPauloToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function pricingConfig() {
  const cfg = getAsaasConfig();
  return {
    feeFixed: cfg.feeFixed,
    feeTiers: cfg.feeTiers,
    maxInstallments: cfg.maxInstallments,
    minInstallmentValue: cfg.minInstallmentValue,
  };
}

function publicPayload(input: {
  payment: PaymentRecord;
  registrationNumber: string | null;
  quote: CardQuote;
  brand: AcceptedCardBrand;
  last4: string;
  message?: string;
}): Record<string, unknown> {
  return {
    paymentId: input.payment.id,
    registrationId: input.payment.registrationId,
    registrationNumber: input.registrationNumber,
    paymentMethod: CARD_PAYMENT_METHOD,
    status: input.payment.status,
    amount: input.quote.netAmount.toFixed(2),
    feeAmount: input.quote.feeAmount.toFixed(2),
    totalAmount: input.quote.totalAmount.toFixed(2),
    installments: input.quote.installments,
    installmentValue: input.quote.installmentValue.toFixed(2),
    cardBrand: input.brand,
    cardLast4: input.last4,
    paidAt: input.payment.paidAt,
    message: input.message ?? null,
  };
}

export class CardPaymentService {
  getPublicConfig(): Record<string, unknown> {
    const cfg = getAsaasConfig();
    return {
      enabled: cfg.enabled,
      sandbox: cfg.isSandbox,
      brands: ACCEPTED_CARD_BRANDS,
      maxInstallments: cfg.maxInstallments,
      minInstallmentValue: cfg.minInstallmentValue,
      feeFixed: cfg.feeFixed,
      feeTiers: cfg.feeTiers,
    };
  }

  async getQuoteForRegistration(registrationId: string): Promise<Record<string, unknown>> {
    const registration = await paymentRepository.findRegistrationById(registrationId);
    if (!registration) throw AppError.notFound('Inscrição não encontrada');
    const net = Number(registration.totalPrice);
    return {
      registrationId,
      amount: net.toFixed(2),
      options: listInstallmentOptions(net, pricingConfig()),
    };
  }

  async createCardPayment(
    registrationId: string,
    body: CreateCardPaymentBody,
  ): Promise<Record<string, unknown>> {
    const cfg = getAsaasConfig();
    if (!cfg.enabled) {
      throw AppError.serviceUnavailable(
        'Pagamento com cartão indisponível no momento.',
        'CARD_PAYMENTS_DISABLED',
      );
    }

    if (cardLocks.has(registrationId)) {
      throw AppError.conflict(
        'Já existe um pagamento com cartão em processamento para esta inscrição.',
        'CARD_PAYMENT_IN_PROGRESS',
      );
    }
    cardLocks.add(registrationId);
    try {
      return await this.processCardPayment(registrationId, body);
    } finally {
      cardLocks.delete(registrationId);
    }
  }

  private async processCardPayment(
    registrationId: string,
    body: CreateCardPaymentBody,
  ): Promise<Record<string, unknown>> {
    const registration = await paymentRepository.findRegistrationById(registrationId);
    if (!registration) throw AppError.notFound('Inscrição não encontrada');
    const registrationNumber = toPublicRegistrationNumber(registration.registrationNumber);

    const existingPayments = await paymentRepository.listPaymentsByRegistrationId(registrationId);
    if (registration.status === 'paid' || existingPayments.some((p) => p.status === 'paid')) {
      throw AppError.conflict(
        'Você já possui uma inscrição confirmada nesta categoria.',
        'REGISTRATION_ALREADY_PAID',
        { outcome: 'ALREADY_PAID', registrationId, registrationNumber },
      );
    }
    if (!CARD_ELIGIBLE_REGISTRATION.has(registration.status)) {
      throw AppError.badRequest(
        `Inscrição não pode ser cobrada no status '${registration.status}'`,
        'REGISTRATION_STATUS_BLOCKED',
      );
    }
    if (
      existingPayments.some(
        (p) => p.paymentMethod === CARD_PAYMENT_METHOD && p.status === 'under_review',
      )
    ) {
      throw AppError.conflict(
        'Já existe um pagamento com cartão em análise para esta inscrição. Aguarde a confirmação.',
        'CARD_PAYMENT_UNDER_REVIEW',
      );
    }

    const { card, holder } = body;
    const brand = detectAcceptedBrand(card.number);
    if (!brand) {
      throw AppError.badRequest(
        'Bandeira não aceita. Aceitamos Visa, Mastercard, Elo e American Express.',
        'CARD_BRAND_NOT_ACCEPTED',
      );
    }
    if (!passesLuhn(card.number)) {
      throw AppError.badRequest('Número do cartão inválido.', 'CARD_NUMBER_INVALID');
    }
    if (card.ccv.length !== expectedCvvLength(brand)) {
      throw AppError.badRequest(
        brand === 'AMEX' ? 'O CVV do American Express tem 4 dígitos.' : 'O CVV tem 3 dígitos.',
        'CARD_CVV_INVALID',
      );
    }
    const expiryMonth = Number(card.expiryMonth);
    const expiryYear = card.expiryYear.length === 2 ? 2000 + Number(card.expiryYear) : Number(card.expiryYear);
    if (isCardExpired(expiryMonth, expiryYear)) {
      throw AppError.badRequest('Cartão vencido.', 'CARD_EXPIRED');
    }

    const net = Number(registration.totalPrice);
    if (!Number.isFinite(net) || net <= 0) {
      throw AppError.unprocessable('Valor da inscrição inválido para cobrança', 'INVALID_TOTAL_PRICE');
    }

    const pricing = pricingConfig();
    const maxAllowed = maxInstallmentsFor(net, pricing, brandInstallmentLimit(brand));
    if (body.installments > maxAllowed) {
      throw AppError.badRequest(
        `Parcelamento máximo para este valor/bandeira: ${maxAllowed}x.`,
        'CARD_INSTALLMENTS_INVALID',
      );
    }

    const quote = quoteCard(net, body.installments, pricing);
    if (
      body.expectedTotalAmount !== undefined &&
      Math.abs(body.expectedTotalAmount - quote.totalAmount) > 0.009
    ) {
      throw AppError.conflict(
        `O valor foi atualizado para R$ ${quote.totalAmount.toFixed(2)}. Confira e tente novamente.`,
        'CARD_PRICE_CHANGED',
        { quote },
      );
    }

    const provider = await paymentRepository.findProviderByCode(ASAAS_PROVIDER_CODE);
    if (!provider) {
      throw AppError.serviceUnavailable(
        "Provedor 'asaas' não encontrado ou inativo em payment_providers",
        'PROVIDER_NOT_FOUND',
      );
    }

    const last4 = card.number.slice(-4);
    const payment = await paymentRepository.createPayment({
      registrationId: registration.id,
      providerId: provider.id,
      amount: quote.netAmount,
      totalAmount: quote.totalAmount,
      discountAmount: 0,
      feeAmount: quote.feeAmount,
      currency: 'BRL',
      paymentMethod: CARD_PAYMENT_METHOD,
      status: 'pending',
      externalReference: registration.registrationNumber,
      teamId: registration.teamId,
      pricingSnapshot: {
        total_price: quote.netAmount,
        fee_amount: quote.feeAmount,
        fee_percent: quote.feePercent,
        fee_fixed: quote.feeFixed,
        total_amount: quote.totalAmount,
        installments: quote.installments,
        installment_value: quote.installmentValue,
        card_brand: brand,
        card_last4: last4,
        holder_cpf_masked: maskCpf(holder.cpf),
        registration_number: registration.registrationNumber,
        priced_at: nowIso(),
        gateway: getAsaasConfig().isSandbox ? 'asaas_sandbox' : 'asaas',
      },
    });

    await financialAuditService.paymentCreated({
      paymentId: payment.id,
      status: payment.status,
      amount: quote.totalAmount,
      provider: ASAAS_PROVIDER_CODE,
      registrationId: registration.id,
    });

    if (registration.status !== 'pending_payment') {
      await paymentRepository.updateRegistrationStatus(registration.id, 'pending_payment');
      await financialAuditService.registrationStatusChanged({
        registrationId: registration.id,
        previousStatus: registration.status,
        newStatus: 'pending_payment',
        paymentId: payment.id,
        reason: 'card_create',
      });
    }
    await paymentRepository.linkActiveReservationPayment(registration.id, payment.id);

    let asaasPayment: AsaasPayment;
    try {
      const customerId = await asaasClient.findOrCreateCustomer({
        name: holder.name,
        cpfCnpj: holder.cpf,
        email: holder.email,
        mobilePhone: holder.phone,
        postalCode: holder.postalCode,
        addressNumber: holder.addressNumber,
        externalReference: registration.id,
      });

      asaasPayment = await this.chargeWithRecovery(payment.id, {
        customer: customerId,
        value: quote.totalAmount,
        installmentCount: quote.installments,
        dueDate: saoPauloToday(),
        description: `Inscrição ${registrationNumber ?? registration.registrationNumber} - Elite Games 2026`,
        externalReference: payment.id,
        creditCard: {
          holderName: card.holderName,
          number: card.number,
          expiryMonth: card.expiryMonth.padStart(2, '0'),
          expiryYear: String(expiryYear),
          ccv: card.ccv,
        },
        creditCardHolderInfo: {
          name: holder.name,
          email: holder.email,
          cpfCnpj: holder.cpf,
          postalCode: holder.postalCode,
          addressNumber: holder.addressNumber,
          phone: holder.phone,
          mobilePhone: holder.phone,
        },
        remoteIp: body.remoteIp,
      });
    } catch (err) {
      const reason =
        err instanceof AsaasDeclinedError
          ? 'declined'
          : err instanceof AsaasUnavailableError
            ? 'gateway_unavailable'
            : 'error';
      await paymentRepository
        .updatePaymentStatus(payment.id, 'failed', {
          pricingSnapshot: {
            ...(payment.pricingSnapshot ?? {}),
            failure_reason: reason,
            failure_code: err instanceof AsaasDeclinedError ? err.asaasCode : null,
            failed_at: nowIso(),
          },
        })
        .catch(() => undefined);
      await financialAuditService.paymentStatusChanged({
        paymentId: payment.id,
        previousStatus: 'pending',
        newStatus: 'failed',
        reason: 'card_create',
      });
      logger.warn('Pagamento com cartão não aprovado', {
        paymentId: payment.id,
        registrationId: registration.id,
        brand,
        installments: quote.installments,
        reason,
      });

      if (err instanceof AsaasDeclinedError) {
        throw AppError.unprocessable(
          'Pagamento não autorizado pela operadora do cartão. Verifique os dados ou tente outro cartão.',
          'CARD_DECLINED',
        );
      }
      if (err instanceof AsaasUnavailableError) {
        throw AppError.serviceUnavailable(
          'Não foi possível processar o cartão agora. Nenhuma cobrança foi feita; tente novamente em instantes.',
          'CARD_GATEWAY_UNAVAILABLE',
        );
      }
      throw err;
    }

    return this.applyChargeResult({
      payment,
      registrationNumber,
      asaasPayment,
      quote,
      brand,
      last4,
      providerId: provider.id,
    });
  }

  /**
   * Em timeout/erro de rede o resultado é desconhecido: consulta a cobrança pela
   * referência externa antes de declarar falha, evitando cobrança duplicada no retry.
   */
  private async chargeWithRecovery(
    paymentId: string,
    input: Parameters<typeof asaasClient.createCardPayment>[0],
  ): Promise<AsaasPayment> {
    try {
      return await asaasClient.createCardPayment(input);
    } catch (err) {
      if (!(err instanceof AsaasUnavailableError)) throw err;
      try {
        const found = await asaasClient.findPaymentsByExternalReference(paymentId);
        const match = found.find((p) => p.externalReference === paymentId) ?? found[0];
        if (match) {
          logger.info('Cobrança Asaas recuperada após falha de comunicação', { paymentId });
          return match;
        }
      } catch {
        logger.error('Falha ao consultar cobrança Asaas após timeout', { paymentId });
      }
      throw err;
    }
  }

  private async applyChargeResult(input: {
    payment: PaymentRecord;
    registrationNumber: string | null;
    asaasPayment: AsaasPayment;
    quote: CardQuote;
    brand: AcceptedCardBrand;
    last4: string;
    providerId: string;
  }): Promise<Record<string, unknown>> {
    const { payment, asaasPayment, quote, brand, last4 } = input;
    const localStatus = mapAsaasStatus(asaasPayment.status);
    const rawResponse = (redactSensitiveData(asaasPayment) as Record<string, unknown>) ?? null;

    const returnedBrand = asaasPayment.creditCard?.creditCardBrand;
    if (returnedBrand && !ACCEPTED_CARD_BRANDS.includes(returnedBrand as AcceptedCardBrand)) {
      logger.warn('Asaas retornou bandeira fora da lista aceita', {
        paymentId: payment.id,
        returnedBrand,
      });
    }

    // Webhook pode ter chegado antes e já confirmado.
    const current = await paymentRepository.findPaymentById(payment.id);
    if (current?.status === 'paid') {
      return publicPayload({
        payment: current,
        registrationNumber: input.registrationNumber,
        quote,
        brand,
        last4,
      });
    }

    const pricingSnapshot = {
      ...(payment.pricingSnapshot ?? {}),
      asaas_payment_id: asaasPayment.id,
      asaas_installment_id: asaasPayment.installment ?? null,
      asaas_status: asaasPayment.status,
    };

    const existingCharge = await paymentRepository.findCurrentChargeByPaymentId(payment.id);
    const charge =
      existingCharge ??
      (await paymentRepository.createPaymentCharge({
        paymentId: payment.id,
        providerId: input.providerId,
        txid: asaasPayment.id,
        providerChargeId: asaasPayment.id,
        amount: quote.totalAmount,
        // Nunca 'active'/'pending': o fluxo PIX trata charge assim como PIX aberto.
        status: localStatus,
        expiresAt: null,
        rawRequest: {
          billingType: 'CREDIT_CARD',
          value: quote.totalAmount,
          installmentCount: quote.installments,
          externalReference: payment.id,
          brand,
        },
        rawResponse,
        isCurrent: true,
      }));

    if (localStatus === 'paid') {
      await paymentRepository.updatePaymentStatus(payment.id, 'pending', {
        providerChargeId: asaasPayment.id,
        pricingSnapshot,
      });
      await this.confirmPaid({
        paymentId: payment.id,
        chargeId: charge.id,
        registrationId: payment.registrationId!,
        asaasPayment,
        providerId: input.providerId,
        externalEventId: `card-create:${asaasPayment.id}`,
        reason: 'card_create',
      });
    } else {
      await paymentRepository.updatePaymentStatus(payment.id, localStatus, {
        providerChargeId: asaasPayment.id,
        pricingSnapshot,
      });
      await financialAuditService.paymentStatusChanged({
        paymentId: payment.id,
        previousStatus: 'pending',
        newStatus: localStatus,
        reason: 'card_create',
      });
    }

    const finalPayment = (await paymentRepository.findPaymentById(payment.id)) ?? payment;
    logger.info('Pagamento com cartão processado', {
      paymentId: payment.id,
      registrationId: payment.registrationId,
      provider: ASAAS_PROVIDER_CODE,
      operation: 'card_payment_create',
      asaasStatus: asaasPayment.status,
      statusLocal: finalPayment.status,
      brand,
      installments: quote.installments,
      totalAmount: quote.totalAmount,
    });

    if (finalPayment.status === 'failed') {
      throw AppError.unprocessable(
        'Pagamento não autorizado pela operadora do cartão. Verifique os dados ou tente outro cartão.',
        'CARD_DECLINED',
      );
    }

    return publicPayload({
      payment: finalPayment,
      registrationNumber: input.registrationNumber,
      quote,
      brand,
      last4,
      message:
        finalPayment.status === 'under_review'
          ? 'Pagamento em análise pela operadora. Você receberá a confirmação assim que for aprovado.'
          : undefined,
    });
  }

  /** Mesma confirmação atômica usada pelo PIX (payment, charge, inscrição e vaga). */
  async confirmPaid(input: {
    paymentId: string;
    chargeId: string;
    registrationId: string;
    asaasPayment: AsaasPayment;
    providerId: string;
    externalEventId: string;
    reason: 'card_create' | 'webhook_asaas';
    eventId?: string;
    previousStatus?: string;
  }): Promise<void> {
    const registration = await paymentRepository.findRegistrationById(input.registrationId);
    const paidAt = nowIso();

    let eventId = input.eventId;
    if (!eventId) {
      const event = await paymentRepository.createPaymentEvent({
        paymentId: input.paymentId,
        providerId: input.providerId,
        eventType: 'card_confirmed',
        externalEventId: input.externalEventId,
        payload: redactSensitiveData(input.asaasPayment),
        signatureValid: true,
        processed: false,
        receivedAt: nowIso(),
      });
      eventId = event.id;
    }

    await paymentRepository.confirmPaidAtomically({
      paymentId: input.paymentId,
      chargeId: input.chargeId,
      registrationId: input.registrationId,
      endToEndId: input.asaasPayment.id,
      paidAt,
      eventId,
      chargeRawResponse: (redactSensitiveData(input.asaasPayment) as Record<string, unknown>) ?? undefined,
    });

    await financialAuditService.paymentStatusChanged({
      paymentId: input.paymentId,
      previousStatus: input.previousStatus ?? 'pending',
      newStatus: 'paid',
      paidAt,
      endToEndId: input.asaasPayment.id,
      reason: input.reason,
    });
    await financialAuditService.registrationStatusChanged({
      registrationId: input.registrationId,
      previousStatus: registration?.status ?? 'pending_payment',
      newStatus: 'paid',
      paymentId: input.paymentId,
      reason: input.reason,
    });
  }
}

export const cardPaymentService = new CardPaymentService();
