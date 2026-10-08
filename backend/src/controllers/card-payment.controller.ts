import type { Request, Response } from 'express';
import { createCardPaymentSchema } from '../schemas/card-payment.schema.js';
import { publicRegistrationIdParamSchema } from '../schemas/public-registration.schema.js';
import { assertRegistrationTokenMatches } from '../middleware/registration-access.middleware.js';
import { cardPaymentService } from '../services/asaas/card-payment.service.js';
import { asaasWebhookSchema, asaasWebhookService } from '../services/asaas/asaas-webhook.service.js';
import { logger } from '../utils/logger.js';

export class CardPaymentController {
  async getConfig(_req: Request, res: Response): Promise<void> {
    res.status(200).json(cardPaymentService.getPublicConfig());
  }

  async getQuote(req: Request, res: Response): Promise<void> {
    const { registrationId } = publicRegistrationIdParamSchema.parse(req.params);
    assertRegistrationTokenMatches(req);
    res.status(200).json(await cardPaymentService.getQuoteForRegistration(registrationId));
  }

  async createCardPayment(req: Request, res: Response): Promise<void> {
    const { registrationId } = publicRegistrationIdParamSchema.parse(req.params);
    assertRegistrationTokenMatches(req);
    const body = createCardPaymentSchema.parse(req.body);
    const result = await cardPaymentService.createCardPayment(registrationId, body);
    res.status(201).json(result);
  }

  async handleAsaasWebhook(req: Request, res: Response): Promise<void> {
    const parsed = asaasWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn('Webhook Asaas com payload inesperado', { requestId: req.requestId });
      res.status(200).json({ ok: true, outcome: 'ignored' });
      return;
    }
    const outcome = await asaasWebhookService.handle(parsed.data);
    logger.info('Webhook Asaas processado', {
      requestId: req.requestId,
      event: parsed.data.event,
      eventId: parsed.data.id,
      outcome,
    });
    res.status(200).json({ ok: true, outcome });
  }
}

export const cardPaymentController = new CardPaymentController();
