import { Router, type Request, type Response, type NextFunction } from 'express';
import healthRoutes from './health.routes.js';
import paymentRoutes, { devPaymentRouter } from './payment.routes.js';
import webhookRoutes from './webhook.routes.js';
import reconciliationRoutes from './reconciliation.routes.js';
import adminRoutes from './admin.routes.js';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/api/v1/payments', paymentRoutes);
router.use('/api/v1/webhooks', webhookRoutes);
router.use('/api/v1/reconciliation', reconciliationRoutes);
router.use('/api/v1/admin', adminRoutes);

function blockDevInProduction(_req: Request, _res: Response, next: NextFunction): void {
  const env = getEnv();
  if (env.isProduction || env.NODE_ENV === 'production') {
    next(AppError.forbidden('Rota de desenvolvimento bloqueada em produção', 'DEV_ONLY'));
    return;
  }
  next();
}

router.use('/api/v1/dev/payments', blockDevInProduction, devPaymentRouter);

export default router;
