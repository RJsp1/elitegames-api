import { describe, it, expect, afterEach } from 'vitest';
import {
  scheduleNext,
  getReconciliationWorkerTimer,
  resetReconciliationWorkerState,
} from '../src/scripts/start-reconciliation-worker.js';

describe('reconciliation worker keep-alive', () => {
  afterEach(() => {
    resetReconciliationWorkerState();
  });

  it('mantém timer com ref ativo enquanto aguarda o próximo ciclo', () => {
    scheduleNext(60_000);

    const timer = getReconciliationWorkerTimer();
    expect(timer).not.toBeNull();
    // Sem unref: o handle mantém o event loop vivo (evita exit + restart do PM2).
    expect(timer!.hasRef()).toBe(true);
  });
});
