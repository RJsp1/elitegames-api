import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { webhookRateLimit } from '../middleware/rate-limit.middleware.js';
import { webhookSecurityMiddleware } from '../middleware/webhook-security.middleware.js';
import { webhookController } from '../controllers/webhook.controller.js';
import { asaasWebhookAuthMiddleware } from '../middleware/asaas-webhook-auth.middleware.js';
import { cardPaymentController } from '../controllers/card-payment.controller.js';

const router = Router();

router.post(
  '/sicredi/pix',
  webhookRateLimit,
  webhookSecurityMiddleware,
  asyncHandler(async (req, res) => webhookController.handleSicrediPix(req, res)),
);

router.post(
  '/asaas',
  webhookRateLimit,
  asaasWebhookAuthMiddleware,
  asyncHandler(async (req, res) => cardPaymentController.handleAsaasWebhook(req, res)),
);

export default router;
