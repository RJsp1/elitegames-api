import { describe, it, expect, afterEach, vi } from 'vitest';

describe('reconciliation worker entrypoint / keep-alive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('importar o módulo de lógica não inicia o worker automaticamente', async () => {
    const mod = await import('../src/scripts/start-reconciliation-worker.js');

    expect(mod.getReconciliationWorkerTimer()).toBeNull();
    expect(typeof mod.runReconciliationWorker).toBe('function');
    expect(typeof mod.scheduleNext).toBe('function');
    expect(typeof mod.resetReconciliationWorkerState).toBe('function');
  });

  it('importar o entrypoint chama runReconciliationWorker (sem Sicredi real)', async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../src/scripts/start-reconciliation-worker.js', async (importOriginal) => {
      const actual = await importOriginal<
        typeof import('../src/scripts/start-reconciliation-worker.js')
      >();
      return {
        ...actual,
        runReconciliationWorker: runMock,
      };
    });

    await import('../src/scripts/start-reconciliation-worker-entrypoint.js');

    await vi.waitFor(() => {
      expect(runMock).toHaveBeenCalledTimes(1);
    });
  });

  it('mantém timer com ref ativo enquanto aguarda o próximo ciclo', async () => {
    const mod = await import('../src/scripts/start-reconciliation-worker.js');
    mod.resetReconciliationWorkerState();
    mod.scheduleNext(60_000);

    const timer = mod.getReconciliationWorkerTimer();
    expect(timer).not.toBeNull();
    expect(timer!.hasRef()).toBe(true);

    mod.resetReconciliationWorkerState();
    expect(mod.getReconciliationWorkerTimer()).toBeNull();
  });
});
