import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { adminMiddleware } from '../middleware/admin.middleware.js';
import { adminRateLimit } from '../middleware/rate-limit.middleware.js';
import { adminPaymentController } from '../controllers/admin-payment.controller.js';

const router = Router();

router.use(adminMiddleware);
router.use(adminRateLimit);

router.get(
  '/payments/dashboard',
  asyncHandler(async (req, res) => adminPaymentController.dashboard(req, res)),
);

router.get(
  '/payments/metrics',
  asyncHandler(async (req, res) => adminPaymentController.metrics(req, res)),
);

router.get(
  '/payments',
  asyncHandler(async (req, res) => adminPaymentController.listPayments(req, res)),
);

router.get(
  '/payments/:paymentId',
  asyncHandler(async (req, res) => adminPaymentController.getPayment(req, res)),
);

router.get(
  '/payments/:paymentId/audit',
  asyncHandler(async (req, res) => adminPaymentController.listAudit(req, res)),
);

router.post(
  '/payments/:paymentId/reissue',
  asyncHandler(async (req, res) => adminPaymentController.reissue(req, res)),
);

router.post(
  '/payments/:paymentId/reconcile',
  asyncHandler(async (req, res) => adminPaymentController.reconcile(req, res)),
);

router.post(
  '/payments/:paymentId/expire',
  asyncHandler(async (req, res) => adminPaymentController.expire(req, res)),
);

router.post(
  '/payments/:paymentId/cancel',
  asyncHandler(async (req, res) => adminPaymentController.cancel(req, res)),
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
