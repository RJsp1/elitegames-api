import { paymentRepository } from '../../repositories/payment.repository.js';
import { paymentService } from '../payment/payment.service.js';
import { isExpired } from '../../utils/date.js';
import { AppError } from '../../utils/app-error.js';
import { maskEndToEndId, maskTxid } from '../../utils/redact-sensitive-data.js';
import { registrationAccessTokenRepository } from '../../repositories/registration-access-token.repository.js';
import { toPublicRegistrationNumber } from './public-registration.service.js';
import type { PaymentChargeRecord, PaymentRecord } from '../../types/payment.types.js';

function paymentPublicPayload(
  payment: PaymentRecord,
  charge: PaymentChargeRecord | null,
  registrationNumber: string | null,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    paymentId: payment.id,
    chargeId: charge?.id ?? null,
    registrationId: payment.registrationId,
    registrationNumber,
    status: payment.status,
    amount: Number(payment.totalAmount).toFixed(2),
    expiresAt: payment.expiresAt ?? charge?.expiresAt ?? null,
    pixCopiaECola: charge?.pixCopyPaste ?? null,
    qrCodeDataUrl: charge?.qrCodeData ?? charge?.qrCodeImageUrl ?? null,
    ...extras,
  };
}

export class PublicPaymentService {
  async createPaymentForRegistration(
    registrationId: string,
    opts?: { requestId?: string },
  ): Promise<Record<string, unknown>> {
    const registration = await paymentRepository.findRegistrationById(registrationId);
    if (!registration) throw AppError.notFound('Inscrição não encontrada');

    const expectedAmount = Number(registration.totalPrice).toFixed(2);

    if (opts?.requestId) {
      const existing = await registrationAccessTokenRepository.findIdempotent(
        'public_payment_create',
        opts.requestId,
      );
      const snap = existing?.responseSnapshot as Record<string, unknown> | undefined;
      // Ignora snapshot se o preço da inscrição mudou (ex.: cupom aplicado/removido).
      if (snap && String(snap.amount ?? '') === expectedAmount) {
        return snap;
      }
    }

    const registrationNumber = toPublicRegistrationNumber(registration.registrationNumber);

    if (registration.status === 'paid' || registration.status === 'confirmed') {
      const payments = await paymentRepository.listPaymentsByRegistrationId(registrationId);
      const paid = payments.find((p) => p.status === 'paid');
      const charge = paid
        ? await paymentRepository.findCurrentChargeByPaymentId(paid.id)
        : null;
      return {
        paymentId: paid?.id ?? null,
        chargeId: charge?.id ?? null,
        registrationId,
        registrationNumber,
        status: 'paid',
        amount: Number(paid?.totalAmount ?? registration.totalPrice).toFixed(2),
        expiresAt: paid?.expiresAt ?? null,
        pixCopiaECola: charge?.pixCopyPaste ?? null,
        qrCodeDataUrl: charge?.qrCodeData ?? charge?.qrCodeImageUrl ?? null,
        outcome: 'ALREADY_PAID',
        registrationStatus: registration.status,
        paidAt: paid?.paidAt ?? null,
      };
    }

    const existingPayments = await paymentRepository.listPaymentsByRegistrationId(registrationId);
    if (existingPayments.some((p) => p.status === 'paid')) {
      throw AppError.conflict(
        'Você já possui uma inscrição confirmada nesta categoria.',
        'REGISTRATION_ALREADY_PAID',
        {
          outcome: 'ALREADY_PAID',
          registrationId,
          registrationNumber,
          status: registration.status,
        },
      );
    }

    // Case B: cobrança ACTIVE não expirada → reutilizar só se o valor bater com a inscrição.
    const openCharge = await paymentService.findOpenCurrentChargeForRegistration(registrationId);
    if (openCharge) {
      const payment = existingPayments.find((p) => p.id === openCharge.paymentId);
      if (payment) {
        const chargeAmount = Number(payment.totalAmount).toFixed(2);
        if (chargeAmount === expectedAmount) {
          const response = paymentPublicPayload(payment, openCharge, registrationNumber, {
            outcome: 'REUSED_ACTIVE_CHARGE',
          });
          if (opts?.requestId) {
            await registrationAccessTokenRepository.saveIdempotent({
              scope: 'public_payment_create',
              requestId: opts.requestId,
              resourceType: 'payment',
              resourceId: payment.id,
              responseSnapshot: response,
            });
          }
          return response;
        }
        // Valor desatualizado (cupom mudou) → invalida e cria nova cobrança.
        await paymentRepository.expirePaymentBundle(payment);
      }
    }

    // Case C: sem charge aberta (expirou/cancelou) → nova cobrança na MESMA registration.
    // createPayment já recusa ACTIVE; aqui só chega se não houver open charge.
    try {
      const result = await paymentService.createPayment({ registrationId });

      const response = {
        paymentId: result.paymentId,
        chargeId: result.chargeId,
        registrationId: result.registrationId,
        registrationNumber: result.registrationNumber
          ? toPublicRegistrationNumber(result.registrationNumber)
          : registrationNumber,
        status: result.status,
        amount: result.amount,
        expiresAt: result.expiresAt,
        pixCopiaECola: result.pixCopiaECola,
        qrCodeDataUrl: result.qrCodeDataUrl,
        outcome: 'NEW_PAYMENT' as const,
      };

      if (opts?.requestId) {
        await registrationAccessTokenRepository.saveIdempotent({
          scope: 'public_payment_create',
          requestId: opts.requestId,
          resourceType: 'payment',
          resourceId: result.paymentId,
          responseSnapshot: response,
        });
      }

      return response;
    } catch (err) {
      // Corrida: outro request criou charge ativa entre o check e o create.
      if (err instanceof AppError && err.code === 'ACTIVE_CHARGE_EXISTS') {
        const charge = await paymentService.findOpenCurrentChargeForRegistration(registrationId);
        if (charge) {
          const payments = await paymentRepository.listPaymentsByRegistrationId(registrationId);
          const payment = payments.find((p) => p.id === charge.paymentId);
          if (payment) {
            return paymentPublicPayload(payment, charge, registrationNumber, {
              outcome: 'REUSED_ACTIVE_CHARGE',
            });
          }
        }
      }
      throw err;
    }
  }

  async getPaymentStatus(
    paymentId: string,
    tokenRegistrationId: string,
  ): Promise<Record<string, unknown>> {
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) throw AppError.notFound('Pagamento não encontrado');
    if (payment.registrationId !== tokenRegistrationId) {
      throw AppError.forbidden('Token não autoriza este pagamento', 'PAYMENT_FORBIDDEN');
    }

    const registration = payment.registrationId
      ? await paymentRepository.findRegistrationById(payment.registrationId)
      : null;

    const canReissue =
      payment.status !== 'paid' &&
      ['expired', 'cancelled', 'failed'].includes(payment.status) &&
      registration != null &&
      ['draft', 'pending_payment'].includes(registration.status);

    return {
      paymentId: payment.id,
      registrationId: payment.registrationId,
      status: payment.status,
      amount: Number(payment.totalAmount).toFixed(2),
      expiresAt: payment.expiresAt,
      paidAt: payment.paidAt,
      canReissue,
      registrationStatus: registration?.status ?? null,
      txidMasked: payment.txid ? maskTxid(payment.txid) : null,
      endToEndIdMasked: payment.endToEndId ? maskEndToEndId(payment.endToEndId) : null,
      isExpired:
        (payment.status === 'active' || payment.status === 'pending') &&
        payment.expiresAt != null &&
        isExpired(payment.expiresAt),
    };
  }

  async reissuePayment(
    paymentId: string,
    tokenRegistrationId: string,
    opts?: { requestId?: string },
  ): Promise<Record<string, unknown>> {
    if (opts?.requestId) {
      const existing = await registrationAccessTokenRepository.findIdempotent(
        'public_payment_reissue',
        opts.requestId,
      );
      if (existing?.responseSnapshot) return existing.responseSnapshot;
    }

    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) throw AppError.notFound('Pagamento não encontrado');
    if (payment.registrationId !== tokenRegistrationId) {
      throw AppError.forbidden('Token não autoriza este pagamento', 'PAYMENT_FORBIDDEN');
    }
    if (payment.status === 'paid') {
      throw AppError.badRequest('Pagamento pago não pode ser reemitido', 'PAYMENT_ALREADY_PAID');
    }

    // Se já existe charge ativa na inscrição, reutilizar em vez de reemitir.
    const openCharge = await paymentService.findOpenCurrentChargeForRegistration(
      tokenRegistrationId,
    );
    if (openCharge) {
      const payments = await paymentRepository.listPaymentsByRegistrationId(tokenRegistrationId);
      const activePayment = payments.find((p) => p.id === openCharge.paymentId);
      const registration = await paymentRepository.findRegistrationById(tokenRegistrationId);
      if (activePayment && registration) {
        return paymentPublicPayload(
          activePayment,
          openCharge,
          toPublicRegistrationNumber(registration.registrationNumber),
          { outcome: 'REUSED_ACTIVE_CHARGE' },
        );
      }
    }

    const result = await paymentService.reissuePixPayment({
      registrationId: tokenRegistrationId,
      paymentId,
      reason: 'public_reissue',
    });

    const response = {
      paymentId: result.paymentId,
      chargeId: result.chargeId,
      registrationId: result.registrationId,
      registrationNumber: result.registrationNumber
        ? toPublicRegistrationNumber(result.registrationNumber)
        : null,
      status: result.status,
      amount: result.amount,
      expiresAt: result.expiresAt,
      pixCopiaECola: result.pixCopiaECola,
      qrCodeDataUrl: result.qrCodeDataUrl,
      outcome: 'REISSUED_PAYMENT' as const,
    };

    if (opts?.requestId) {
      await registrationAccessTokenRepository.saveIdempotent({
        scope: 'public_payment_reissue',
        requestId: opts.requestId,
        resourceType: 'payment',
        resourceId: result.paymentId,
        responseSnapshot: response,
      });
    }

    return response;
  }
}

export const publicPaymentService = new PublicPaymentService();
