import type { Request, Response } from 'express';
import { paymentIdParamSchema } from '../schemas/payment.schema.js';
import { paymentService } from '../services/payment/payment.service.js';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

export class ReconciliationController {
  async reconcileOne(req: Request, res: Response): Promise<void> {
    const { paymentId } = paymentIdParamSchema.parse(req.params);
    const env = getEnv();

    if (env.isSicredi) {
      const { sicrediReconciliationService } = await import(
        '../services/sicredi/sicredi-reconciliation.service.js'
      );
      const result = await sicrediReconciliationService.reconcilePayment(paymentId);
      res.status(200).json(result);
      return;
    }

    const payment = await paymentService.reconcilePayment(paymentId);
    res.status(200).json(payment);
  }

  async reconcileBatch(_req: Request, res: Response): Promise<void> {
    const env = getEnv();
    if (!env.isSicredi) {
      throw AppError.badRequest('Conciliação em lote requer PAYMENT_PROVIDER=sicredi');
    }

    const { sicrediReconciliationService } = await import(
      '../services/sicredi/sicredi-reconciliation.service.js'
    );
    const results = await sicrediReconciliationService.reconcilePending();
    res.status(200).json({ results });
  }
}

export const reconciliationController = new ReconciliationController();
