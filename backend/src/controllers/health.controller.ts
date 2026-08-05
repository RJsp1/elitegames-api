import type { Request, Response } from 'express';
import { getEnv } from '../config/env.js';

export class HealthController {
  check(_req: Request, res: Response): void {
    const env = getEnv();
    res.status(200).json({
      status: 'ok',
      service: 'elite-games-api',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
      paymentProvider: env.PAYMENT_PROVIDER,
    });
  }
}

export const healthController = new HealthController();
