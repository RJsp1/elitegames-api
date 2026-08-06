import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import {
  publicRateLimit,
  publicWriteRateLimit,
} from '../middleware/rate-limit.middleware.js';
import {
  optionalSupabaseAuthMiddleware,
  registrationAccessMiddleware,
} from '../middleware/registration-access.middleware.js';
import { publicRegistrationController } from '../controllers/public-registration.controller.js';

const router = Router();

router.get(
  '/events/:slug',
  publicRateLimit,
  asyncHandler(async (req, res) => publicRegistrationController.getEvent(req, res)),
);

router.get(
  '/events/:slug/categories',
  publicRateLimit,
  asyncHandler(async (req, res) => publicRegistrationController.listCategories(req, res)),
);

router.post(
  '/registrations',
  publicWriteRateLimit,
  optionalSupabaseAuthMiddleware,
  asyncHandler(async (req, res) => publicRegistrationController.createRegistration(req, res)),
);

router.post(
  '/registrations/:registrationId/payment',
  publicWriteRateLimit,
  registrationAccessMiddleware,
  asyncHandler(async (req, res) => publicRegistrationController.createPayment(req, res)),
);

router.get(
  '/registrations/:registrationId/receipt',
  publicRateLimit,
  registrationAccessMiddleware,
  asyncHandler(async (req, res) => publicRegistrationController.getReceipt(req, res)),
);

router.get(
  '/payments/:paymentId/status',
  publicRateLimit,
  registrationAccessMiddleware,
  asyncHandler(async (req, res) => publicRegistrationController.getPaymentStatus(req, res)),
);

router.post(
  '/payments/:paymentId/reissue',
  publicWriteRateLimit,
  registrationAccessMiddleware,
  asyncHandler(async (req, res) => publicRegistrationController.reissuePayment(req, res)),
);

export default router;
