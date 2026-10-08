import { z } from 'zod';
import { ASAAS_PROVIDER_CODE } from '../../config/asaas.js';
import { paymentRepository } from '../../repositories/payment.repository.js';
import type { PaymentRecord } from '../../types/payment.types.js';
import { AppError } from '../../utils/app-error.js';
import { nowIso } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import { redactSensitiveData } from '../../utils/redact-sensitive-data.js';
import { financialAuditService } from '../audit/financial-audit.service.js';
import type { AsaasPayment } from './asaas-client.js';
import { CARD_PAYMENT_METHOD, cardPaymentService } from './card-payment.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const asaasWebhookSchema = z
  .object({
    id: z.string().min(1),
    event: z.string().min(1),
    payment: z
      .object({
        id: z.string().min(1),
        status: z.string().optional(),
        billingType: z.string().optional(),
        value: z.number().optional(),
        externalReference: z.string().nullish(),
        installment: z.string().nullish(),
        confirmedDate: z.string().nullish(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AsaasWebhookBody = z.infer<typeof asaasWebhookSchema>;

export type AsaasWebhookOutcome = 'processed' | 'duplicated' | 'ignored' | 'not_found';

async function findLocalPayment(asaasPayment: NonNullable<AsaasWebhookBody['payment']>) {
  const ref = asaasPayment.externalReference ?? '';
  if (UUID_RE.test(ref)) {
    const byRef = await paymentRepository.findPaymentById(ref);
    if (byRef) return byRef;
  }
  return paymentRepository.findPaymentByProviderChargeId(asaasPayment.id);
}

export class AsaasWebhookService {
  async handle(body: AsaasWebhookBody): Promise<AsaasWebhookOutcome> {
    const asaasPayment = body.payment;
    if (!body.event.startsWith('PAYMENT_') || !asaasPayment) return 'ignored';
    if (asaasPayment.billingType && asaasPayment.billingType !== 'CREDIT_CARD') return 'ignored';

    // Entrega "pelo menos uma vez": evento já processado é ignorado; não processado é retomado.
    const existing = await paymentRepository.findPaymentEventByExternalId(body.id);
    if (existing?.processed) return 'duplicated';

    const provider = await paymentRepository.findProviderByCode(ASAAS_PROVIDER_CODE);
    if (!provider) {
      throw AppError.serviceUnavailable("Provedor 'asaas' não configurado", 'PROVIDER_NOT_FOUND');
    }

    const local = await findLocalPayment(asaasPayment);
    const payment = local && local.paymentMethod === CARD_PAYMENT_METHOD ? local : null;

    let event = existing;
    if (!event) {
      try {
        event = await paymentRepository.createPaymentEvent({
          paymentId: payment?.id ?? null,
          providerId: provider.id,
          eventType: `asaas_${body.event.toLowerCase()}`,
          externalEventId: body.id,
          payload: redactSensitiveData(body),
          signatureValid: true,
          processed: false,
          receivedAt: nowIso(),
        });
      } catch (err) {
        if (err instanceof AppError && err.code === 'DUPLICATE_EVENT') return 'duplicated';
        throw err;
      }
    }

    if (!payment) {
      await paymentRepository.markPaymentEventFailed(event.id, 'PAYMENT_NOT_FOUND');
      return 'not_found';
    }

    try {
      await this.apply(body.event, payment, asaasPayment as AsaasPayment, provider.id, event.id);
      await paymentRepository.markPaymentEventProcessed(event.id).catch(() => undefined);
      return 'processed';
    } catch (err) {
      const message = err instanceof Error ? err.message : 'erro desconhecido';
      await paymentRepository.markPaymentEventFailed(event.id, message).catch(() => undefined);
      // Falhas de negócio não melhoram com reenvio; erros de infraestrutura sobem (500 → Asaas reenvia).
      if (message === 'VALUE_MISMATCH' || message === 'REGISTRATION_MISSING') return 'ignored';
      throw err;
    }
  }

  private async apply(
    eventName: string,
    payment: PaymentRecord,
    asaasPayment: AsaasPayment,
    providerId: string,
    eventId: string,
  ): Promise<void> {
    switch (eventName) {
      case 'PAYMENT_CONFIRMED':
      case 'PAYMENT_RECEIVED': {
        if (payment.status === 'paid' || payment.status === 'refunded') return;
        if (!payment.registrationId) throw new Error('REGISTRATION_MISSING');

        // Parcelado: cada parcela é uma cobrança com valor próprio; só confere valor à vista.
        if (
          !asaasPayment.installment &&
          typeof asaasPayment.value === 'number' &&
          Math.abs(asaasPayment.value - Number(payment.totalAmount)) > 0.01
        ) {
          await paymentRepository.updatePaymentStatus(payment.id, 'under_review');
          await financialAuditService.paymentStatusChanged({
            paymentId: payment.id,
            previousStatus: payment.status,
            newStatus: 'under_review',
            reason: 'webhook_asaas',
          });
          throw new Error('VALUE_MISMATCH');
        }

        const charge =
          (await paymentRepository.findCurrentChargeByPaymentId(payment.id)) ??
          (await paymentRepository.createPaymentCharge({
            paymentId: payment.id,
            providerId,
            txid: asaasPayment.id,
            providerChargeId: asaasPayment.id,
            amount: Number(payment.totalAmount),
            status: 'paid',
            expiresAt: null,
            rawResponse: (redactSensitiveData(asaasPayment) as Record<string, unknown>) ?? null,
            isCurrent: true,
          }));

        await cardPaymentService.confirmPaid({
          paymentId: payment.id,
          chargeId: charge.id,
          registrationId: payment.registrationId,
          asaasPayment,
          providerId,
          externalEventId: `webhook:${asaasPayment.id}`,
          reason: 'webhook_asaas',
          eventId,
          previousStatus: payment.status,
        });
        return;
      }

      case 'PAYMENT_AWAITING_RISK_ANALYSIS': {
        if (payment.status !== 'pending') return;
        await paymentRepository.updatePaymentStatus(payment.id, 'under_review');
        await financialAuditService.paymentStatusChanged({
          paymentId: payment.id,
          previousStatus: payment.status,
          newStatus: 'under_review',
          reason: 'webhook_asaas',
        });
        return;
      }

      case 'PAYMENT_REPROVED_BY_RISK_ANALYSIS':
      case 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED': {
        if (payment.status === 'paid' || payment.status === 'failed') return;
        await paymentRepository.updatePaymentStatus(payment.id, 'failed');
        const charge = await paymentRepository.findCurrentChargeByPaymentId(payment.id);
        if (charge && charge.status !== 'paid') {
          await paymentRepository.updateChargeStatus(charge.id, 'failed');
        }
        await financialAuditService.paymentStatusChanged({
          paymentId: payment.id,
          previousStatus: payment.status,
          newStatus: 'failed',
          reason: 'webhook_asaas',
        });
        return;
      }

      case 'PAYMENT_REFUNDED': {
        if (payment.status !== 'paid') return;
        await paymentRepository.updatePaymentStatus(payment.id, 'refunded');
        await financialAuditService.paymentStatusChanged({
          paymentId: payment.id,
          previousStatus: payment.status,
          newStatus: 'refunded',
          reason: 'webhook_asaas',
        });
        return;
      }

      case 'PAYMENT_CHARGEBACK_REQUESTED':
      case 'PAYMENT_CHARGEBACK_DISPUTE':
        logger.warn('Chargeback solicitado em pagamento com cartão', {
          paymentId: payment.id,
          registrationId: payment.registrationId,
          event: eventName,
        });
        return;

      default:
        return;
    }
  }
}

export const asaasWebhookService = new AsaasWebhookService();
