import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { healthController } from '../controllers/health.controller.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  healthController.check(req, res);
}));

router.get('/reconciliation', asyncHandler(async (req, res) => {
  healthController.reconciliation(req, res);
}));

export default router;
