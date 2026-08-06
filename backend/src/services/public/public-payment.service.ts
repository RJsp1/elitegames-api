import { paymentRepository } from '../../repositories/payment.repository.js';
import { paymentService } from '../payment/payment.service.js';
import { isExpired } from '../../utils/date.js';
import { AppError } from '../../utils/app-error.js';
import { maskEndToEndId, maskTxid } from '../../utils/redact-sensitive-data.js';
import { registrationAccessTokenRepository } from '../../repositories/registration-access-token.repository.js';

export class PublicPaymentService {
  async createPaymentForRegistration(
    registrationId: string,
    opts?: { requestId?: string },
  ): Promise<Record<string, unknown>> {
    if (opts?.requestId) {
      const existing = await registrationAccessTokenRepository.findIdempotent(
        'public_payment_create',
        opts.requestId,
      );
      if (existing?.responseSnapshot) return existing.responseSnapshot;
    }

    const registration = await paymentRepository.findRegistrationById(registrationId);
    if (!registration) throw AppError.notFound('Inscrição não encontrada');

    const result = await paymentService.createPayment({ registrationId });

    const response = {
      paymentId: result.paymentId,
      chargeId: result.chargeId,
      registrationId: result.registrationId,
      registrationNumber: result.registrationNumber,
      status: result.status,
      amount: result.amount,
      expiresAt: result.expiresAt,
      pixCopiaECola: result.pixCopiaECola,
      qrCodeDataUrl: result.qrCodeDataUrl,
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

    const result = await paymentService.reissuePixPayment({
      registrationId: tokenRegistrationId,
      paymentId,
      reason: 'public_reissue',
    });

    const response = {
      paymentId: result.paymentId,
      chargeId: result.chargeId,
      registrationId: result.registrationId,
      registrationNumber: result.registrationNumber,
      status: result.status,
      amount: result.amount,
      expiresAt: result.expiresAt,
      pixCopiaECola: result.pixCopiaECola,
      qrCodeDataUrl: result.qrCodeDataUrl,
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
