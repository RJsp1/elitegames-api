import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticationMiddleware } from '../middleware/authentication.middleware.js';
import { reconciliationController } from '../controllers/reconciliation.controller.js';

const router = Router();

router.post(
  '/payments/:paymentId',
  authenticationMiddleware,
  asyncHandler(async (req, res) => reconciliationController.reconcileOne(req, res)),
);

router.post(
  '/batch',
  authenticationMiddleware,
  asyncHandler(async (req, res) => reconciliationController.reconcileBatch(req, res)),
);

export default router;
