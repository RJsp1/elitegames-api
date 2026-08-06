import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { paymentExpirationService } from '../src/services/payment/payment-expiration.service.js';
import {
  maybeRunExpirationCycle,
  resetReconciliationWorkerState,
  getExpirationWorkerState,
} from '../src/scripts/start-reconciliation-worker.js';

const emptySummary = {
  operation: 'payment_expiration_cycle' as const,
  provider: 'mock' as const,
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

describe('maybeRunExpirationCycle', () => {
  beforeEach(() => {
    resetReconciliationWorkerState();
    paymentExpirationService.resetCycleLock();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetReconciliationWorkerState();
  });

  it('primeiro ciclo executa expiração', async () => {
    const runSpy = vi.spyOn(paymentExpirationService, 'runCycle').mockResolvedValue(emptySummary);
    vi.setSystemTime(1_000_000);

    await maybeRunExpirationCycle(true, 60_000);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(getExpirationWorkerState().lastExpirationRunAt).toBe(1_000_000);
  });

  it('ciclos antes de 60s não executam novamente', async () => {
    const runSpy = vi.spyOn(paymentExpirationService, 'runCycle').mockResolvedValue(emptySummary);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    await maybeRunExpirationCycle(true, 60_000);
    for (const offset of [10_000, 20_000, 30_000, 40_000, 50_000]) {
      vi.setSystemTime(1_000_000 + offset);
      await maybeRunExpirationCycle(true, 60_000);
    }

    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('após 60s executa', async () => {
    const runSpy = vi.spyOn(paymentExpirationService, 'runCycle').mockResolvedValue(emptySummary);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    await maybeRunExpirationCycle(true, 60_000);
    vi.setSystemTime(1_000_000 + 60_000);
    await maybeRunExpirationCycle(true, 60_000);

    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it('overlap não executa', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runSpy = vi.spyOn(paymentExpirationService, 'runCycle').mockImplementation(async () => {
      await barrier;
      return emptySummary;
    });

    vi.setSystemTime(2_000_000);
    const first = maybeRunExpirationCycle(true, 60_000);
    await Promise.resolve();
    expect(getExpirationWorkerState().expirationRunning).toBe(true);

    await maybeRunExpirationCycle(true, 60_000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(getExpirationWorkerState().expirationRunning).toBe(false);
  });

  it('erro libera o lock', async () => {
    vi.spyOn(paymentExpirationService, 'runCycle').mockRejectedValueOnce(new Error('boom'));
    vi.setSystemTime(3_000_000);

    await maybeRunExpirationCycle(true, 60_000);

    expect(getExpirationWorkerState().expirationRunning).toBe(false);
    expect(getExpirationWorkerState().lastExpirationRunAt).toBe(3_000_000);
  });

  it('reset limpa estado', async () => {
    vi.spyOn(paymentExpirationService, 'runCycle').mockResolvedValue(emptySummary);
    vi.setSystemTime(4_000_000);
    await maybeRunExpirationCycle(true, 60_000);

    expect(getExpirationWorkerState().lastExpirationRunAt).toBeGreaterThan(0);

    resetReconciliationWorkerState();
    expect(getExpirationWorkerState()).toEqual({
      lastExpirationRunAt: 0,
      expirationRunning: false,
    });
  });

  it('disabled não executa', async () => {
    const runSpy = vi.spyOn(paymentExpirationService, 'runCycle');
    await maybeRunExpirationCycle(false, 60_000);
    expect(runSpy).not.toHaveBeenCalled();
  });
});
