import type { Request, Response } from 'express';
import { getEnv } from '../config/env.js';
import {
  evaluateReconciliationHealth,
  readReconciliationHeartbeat,
} from '../utils/reconciliation-heartbeat.js';

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

  reconciliation(_req: Request, res: Response): void {
    const env = getEnv();
    const heartbeat = readReconciliationHeartbeat();
    const health = evaluateReconciliationHealth(heartbeat);

    const httpStatus = health.status === 'down' ? 503 : 200;
    res.status(httpStatus).json({
      status: health.status,
      enabled: health.enabled || env.PAYMENT_RECONCILIATION_ENABLED,
      isRunning: health.isRunning,
      lastSuccessfulCycleAt: health.lastSuccessfulCycleAt,
      lastCycleFinishedAt: health.lastCycleFinishedAt,
      lastCycleDurationMs: health.lastCycleDurationMs,
      lastCycleTotal: health.lastCycleTotal,
      lastCycleErrors: health.lastCycleErrors,
      consecutiveFailures: health.consecutiveFailures,
      intervalMs: health.intervalMs || env.PAYMENT_RECONCILIATION_INTERVAL_MS,
      nextRunAt: health.nextRunAt,
      staleMs: health.staleMs,
      timestamp: new Date().toISOString(),
    });
  }
}

export const healthController = new HealthController();
