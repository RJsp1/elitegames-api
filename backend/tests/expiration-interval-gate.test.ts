import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { paymentExpirationService } from '../src/services/payment/payment-expiration.service.js';
import {
  maybeRunExpirationAfterReconciliation,
  resetReconciliationWorkerState,
  getExpirationWorkerState,
} from '../src/scripts/start-reconciliation-worker.js';

describe('gate de intervalo da expiração no worker', () => {
  beforeEach(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'test';
    process.env.PAYMENT_EXPIRATION_ENABLED = 'true';
    process.env.PAYMENT_EXPIRATION_INTERVAL_MS = '60000';
    process.env.PAYMENT_RECONCILIATION_INTERVAL_MS = '10000';
    resetEnvCache();
    loadEnv();
    resetReconciliationWorkerState();
    paymentExpirationService.resetCycleLock();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetReconciliationWorkerState();
    paymentExpirationService.resetCycleLock();
  });

  it('em 6 ciclos de 10s, expira só no primeiro e após completar 60s', async () => {
    const runSpy = vi.spyOn(paymentExpirationService, 'runCycle').mockResolvedValue({
      operation: 'payment_expiration_cycle',
      provider: 'mock',
      durationMs: 1,
      total: 0,
      expired: 0,
      confirmedBeforeExpire: 0,
      cancelled: 0,
      skipped: 0,
      errors: 0,
      queried: 0,
      averageQueryMs: 0,
      minQueryMs: 0,
      maxQueryMs: 0,
      batchSize: 50,
      intervalMs: 60_000,
    });

    const t0 = 1_000_000;
    // 6 ciclos de reconciliação a cada 10s: t0, +10, +20, +30, +40, +50
    const reconTimes = [0, 10, 20, 30, 40, 50].map((s) => t0 + s * 1000);

    const outcomes: boolean[] = [];
    for (const now of reconTimes) {
      outcomes.push(await maybeRunExpirationAfterReconciliation(now));
    }

    expect(outcomes).toEqual([true, false, false, false, false, false]);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // No 7º ciclo (+60s) a expiração volta a rodar
    const ranAgain = await maybeRunExpirationAfterReconciliation(t0 + 60_000);
    expect(ranAgain).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it('não roda simultaneamente duas vezes', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runSpy = vi.spyOn(paymentExpirationService, 'runCycle').mockImplementation(async () => {
      await barrier;
      return {
        operation: 'payment_expiration_cycle',
        provider: 'mock',
        durationMs: 1,
        total: 0,
        expired: 0,
        confirmedBeforeExpire: 0,
        cancelled: 0,
        skipped: 0,
        errors: 0,
        queried: 0,
        averageQueryMs: 0,
        minQueryMs: 0,
        maxQueryMs: 0,
        batchSize: 50,
        intervalMs: 60_000,
      };
    });

    const first = maybeRunExpirationAfterReconciliation(1_000_000);
    // Enquanto a primeira ainda roda
    await Promise.resolve();
    expect(getExpirationWorkerState().expirationRunning).toBe(true);

    const second = await maybeRunExpirationAfterReconciliation(1_000_000);
    expect(second).toBe(false);

    release();
    expect(await first).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(getExpirationWorkerState().expirationRunning).toBe(false);
  });

  it('falha libera o lock e permite ciclo futuro', async () => {
    const runSpy = vi
      .spyOn(paymentExpirationService, 'runCycle')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        operation: 'payment_expiration_cycle',
        provider: 'mock',
        durationMs: 1,
        total: 0,
        expired: 0,
        confirmedBeforeExpire: 0,
        cancelled: 0,
        skipped: 0,
        errors: 0,
        queried: 0,
        averageQueryMs: 0,
        minQueryMs: 0,
        maxQueryMs: 0,
        batchSize: 50,
        intervalMs: 60_000,
      });

    const t0 = 2_000_000;
    expect(await maybeRunExpirationAfterReconciliation(t0)).toBe(false);
    expect(getExpirationWorkerState().expirationRunning).toBe(false);

    // Intervalo ainda não passou → não reexecuta
    expect(await maybeRunExpirationAfterReconciliation(t0 + 10_000)).toBe(false);

    // Após intervalo, pode executar de novo
    expect(await maybeRunExpirationAfterReconciliation(t0 + 60_000)).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it('disabled não executa', async () => {
    process.env.PAYMENT_EXPIRATION_ENABLED = 'false';
    resetEnvCache();
    loadEnv();

    const runSpy = vi.spyOn(paymentExpirationService, 'runCycle');

    expect(await maybeRunExpirationAfterReconciliation(Date.now())).toBe(false);
    expect(runSpy).not.toHaveBeenCalled();
  });
});
