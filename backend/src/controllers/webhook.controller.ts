import type { Request, Response } from 'express';
import { sicrediWebhookSchema } from '../schemas/webhook.schema.js';
import { paymentRepository } from '../repositories/payment.repository.js';
import { financialAuditService } from '../services/audit/financial-audit.service.js';
import { amountsEqual, pixAmountToCents, toCents } from '../utils/money.js';
import { nowIso } from '../utils/date.js';
import { logger } from '../utils/logger.js';
import { redactSensitiveData } from '../utils/redact-sensitive-data.js';
import { AppError } from '../utils/app-error.js';
import type { WebhookProcessResult } from '../types/webhook.types.js';

function formatAmount(value: number): string {
  return Number(value).toFixed(2);
}

export class WebhookController {
  async handleSicrediPix(req: Request, res: Response): Promise<void> {
    const payload = sicrediWebhookSchema.parse(req.body);

    const result: WebhookProcessResult = {
      received: payload.pix.length,
      processed: 0,
      duplicated: 0,
      ignored: 0,
      errors: [],
    };

    const provider = await paymentRepository.findProviderByCode('sicredi');
    const providerId = provider?.id ?? null;
    const signatureHeader = req.header('X-Webhook-Signature-Valid');
    const signatureValid =
      signatureHeader === 'true' ? true : signatureHeader === 'false' ? false : null;

    for (const item of payload.pix) {
      let eventId: string | null = null;
      try {
        const existing = await paymentRepository.findPaymentEventByExternalId(item.endToEndId);
        if (existing) {
          result.duplicated += 1;
          continue;
        }

        const payment = item.txid
          ? await paymentRepository.findPaymentByTxid(item.txid)
          : null;

        let event;
        try {
          event = await paymentRepository.createPaymentEvent({
            paymentId: payment?.id ?? null,
            providerId,
            eventType: 'pix_received',
            externalEventId: item.endToEndId,
            payload: redactSensitiveData(item),
            signatureValid,
            processed: false,
            receivedAt: nowIso(),
          });
        } catch (err) {
          if (err instanceof AppError && err.code === 'DUPLICATE_EVENT') {
            result.duplicated += 1;
            continue;
          }
          throw err;
        }
        eventId = event.id;

        if (!item.txid) {
          result.ignored += 1;
          await paymentRepository.markPaymentEventFailed(event.id, 'TXID_MISSING');
          continue;
        }

        if (!payment) {
          result.ignored += 1;
          await paymentRepository.markPaymentEventFailed(event.id, 'PAYMENT_NOT_FOUND');
          continue;
        }

        if (payment.endToEndId === item.endToEndId || payment.status === 'paid') {
          result.duplicated += 1;
          await paymentRepository.markPaymentEventProcessed(event.id);
          continue;
        }

        const expected = formatAmount(payment.totalAmount);
        if (!amountsEqual(item.valor, expected)) {
          result.errors.push({
            endToEndId: item.endToEndId,
            txid: item.txid,
            message: 'VALUE_MISMATCH',
          });
          const previousStatus = payment.status;
          await paymentRepository.updatePaymentStatus(payment.id, 'under_review');
          await financialAuditService.paymentAmountMismatch({
            paymentId: payment.id,
            expectedCents: toCents(Number(payment.totalAmount)),
            receivedCents: pixAmountToCents(item.valor),
            txid: item.txid,
            reason: 'webhook_sicredi',
          });
          await financialAuditService.paymentStatusChanged({
            paymentId: payment.id,
            previousStatus,
            newStatus: 'under_review',
            reason: 'webhook_sicredi',
          });
          await paymentRepository.markPaymentEventFailed(event.id, 'VALUE_MISMATCH');
          continue;
        }

        const charge = await paymentRepository.findCurrentChargeByPaymentId(payment.id);
        if (!charge) {
          result.errors.push({
            endToEndId: item.endToEndId,
            txid: item.txid,
            message: 'CHARGE_NOT_FOUND',
          });
          await paymentRepository.markPaymentEventFailed(event.id, 'CHARGE_NOT_FOUND');
          continue;
        }

        if (!payment.registrationId) {
          result.errors.push({
            endToEndId: item.endToEndId,
            txid: item.txid,
            message: 'REGISTRATION_MISSING',
          });
          await paymentRepository.markPaymentEventFailed(event.id, 'REGISTRATION_MISSING');
          continue;
        }

        const previousStatus = payment.status;
        const previousChargeStatus = charge.status;
        const registration = await paymentRepository.findRegistrationById(payment.registrationId);
        const registrationPreviousStatus = registration?.status ?? 'pending_payment';
        const paidAt = item.horario || nowIso();

        await paymentRepository.confirmPaidAtomically({
          paymentId: payment.id,
          chargeId: charge.id,
          registrationId: payment.registrationId,
          endToEndId: item.endToEndId,
          paidAt,
          eventId: event.id,
          chargeRawResponse: (redactSensitiveData(item) as Record<string, unknown>) ?? undefined,
        });

        await financialAuditService.paymentStatusChanged({
          paymentId: payment.id,
          previousStatus,
          newStatus: 'paid',
          paidAt,
          endToEndId: item.endToEndId,
          reason: 'webhook_sicredi',
        });
        await financialAuditService.paymentReconciled({
          paymentId: payment.id,
          previousPaymentStatus: previousStatus,
          previousChargeStatus,
          paidAt,
          endToEndId: item.endToEndId,
          amountReceived: item.valor,
          reason: 'webhook_sicredi',
        });
        await financialAuditService.registrationStatusChanged({
          registrationId: payment.registrationId,
          previousStatus: registrationPreviousStatus,
          newStatus: 'paid',
          paymentId: payment.id,
          reason: 'webhook_sicredi',
        });

        result.processed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'erro desconhecido';
        result.errors.push({
          endToEndId: item.endToEndId,
          txid: item.txid,
          message,
        });
        if (eventId) {
          await paymentRepository.markPaymentEventFailed(eventId, message).catch(() => undefined);
        }
        logger.error('Erro ao processar item do webhook', {
          endToEndId: item.endToEndId,
          message,
        });
      }
    }

    logger.info('Webhook Sicredi processado', {
      requestId: req.requestId,
      ...result,
    });

    res.status(200).json({ ok: true, ...result });
  }
}

export const webhookController = new WebhookController();
