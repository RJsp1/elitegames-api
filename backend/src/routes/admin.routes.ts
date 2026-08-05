import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { adminMiddleware } from '../middleware/admin.middleware.js';
import { adminPaymentController } from '../controllers/admin-payment.controller.js';

const router = Router();

router.use(adminMiddleware);

router.get(
  '/payments',
  asyncHandler(async (req, res) => adminPaymentController.listPayments(req, res)),
);

router.get(
  '/payment-events',
  asyncHandler(async (req, res) => adminPaymentController.listEvents(req, res)),
);

router.post(
  '/payment-events/:id/reprocess',
  asyncHandler(async (req, res) => adminPaymentController.reprocessEvent(req, res)),
);

export default router;
