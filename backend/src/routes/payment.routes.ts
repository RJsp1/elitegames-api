import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticationMiddleware } from '../middleware/authentication.middleware.js';
import { paymentRateLimit } from '../middleware/rate-limit.middleware.js';
import { paymentController } from '../controllers/payment.controller.js';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

const router = Router();

router.post(
  '/',
  paymentRateLimit,
  authenticationMiddleware,
  asyncHandler(async (req, res) => paymentController.create(req, res)),
);

router.get(
  '/:paymentId',
  authenticationMiddleware,
  asyncHandler(async (req, res) => paymentController.getById(req, res)),
);

router.post(
  '/:paymentId/refresh',
  authenticationMiddleware,
  asyncHandler(async (req, res) => paymentController.refresh(req, res)),
);

router.post(
  '/:paymentId/reconcile',
  authenticationMiddleware,
  asyncHandler(async (req, res) => paymentController.reconcile(req, res)),
);

router.post(
  '/:paymentId/refund',
  authenticationMiddleware,
  asyncHandler(async (req, res) => paymentController.refund(req, res)),
);

router.post(
  '/:paymentId/reissue',
  paymentRateLimit,
  authenticationMiddleware,
  asyncHandler(async (req, res) => paymentController.reissue(req, res)),
);

export const devPaymentRouter = Router();

devPaymentRouter.post(
  '/:paymentId/simulate-paid',
  asyncHandler(async (req, res) => {
    const env = getEnv();
    if (env.isProduction || env.NODE_ENV === 'production') {
      throw AppError.forbidden('Rota de desenvolvimento bloqueada em produção', 'DEV_ONLY');
    }
    await paymentController.simulatePaid(req, res);
  }),
);

export default router;
