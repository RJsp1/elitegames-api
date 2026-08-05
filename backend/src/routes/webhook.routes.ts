import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { webhookRateLimit } from '../middleware/rate-limit.middleware.js';
import { webhookSecurityMiddleware } from '../middleware/webhook-security.middleware.js';
import { webhookController } from '../controllers/webhook.controller.js';

const router = Router();

router.post(
  '/sicredi/pix',
  webhookRateLimit,
  webhookSecurityMiddleware,
  asyncHandler(async (req, res) => webhookController.handleSicrediPix(req, res)),
);

export default router;
