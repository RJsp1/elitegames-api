import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import {
  classifyPixError,
  compactMeta,
  paymentCorrelationId,
  buildPixLogMeta,
  pixLog,
} from '../src/utils/observability.js';
import {
  evaluateReconciliationHealth,
  writeReconciliationHeartbeat,
  readReconciliationHeartbeat,
} from '../src/utils/reconciliation-heartbeat.js';
import { summarizeReconciliationResults } from '../src/services/sicredi/sicredi-reconciliation.service.js';
import { AppError } from '../src/utils/app-error.js';
import { logger } from '../src/utils/logger.js';

describe('observabilidade Pix Sicredi', () => {
  let tempDir: string;
  let heartbeatPath: string;

  beforeEach(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'test';
    resetEnvCache();
    loadEnv();
    tempDir = mkdtempSync(join(tmpdir(), 'elite-health-'));
    heartbeatPath = join(tempDir, 'reconciliation-health.json');
    process.env.RECONCILIATION_HEARTBEAT_PATH = heartbeatPath;
  });

  afterEach(() => {
    delete process.env.RECONCILIATION_HEARTBEAT_PATH;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('correlationId usa payment.id e não inclui secrets', () => {
    const paymentId = '11111111-2222-3333-4444-555555555555';
    expect(paymentCorrelationId(paymentId)).toBe(paymentId);

    const meta = buildPixLogMeta({
      correlationId: paymentId,
      paymentId,
      txid: 'EGABCDEFGHIJKLMNOPQRSTUVWX',
      operation: 'payment_create',
      provider: 'sicredi',
      undefinedField: undefined,
    });

    expect(meta.correlationId).toBe(paymentId);
    expect(meta.txidMasked).toBe('EGAB…UVWX');
    expect(meta).not.toHaveProperty('txid');
    expect(meta).not.toHaveProperty('undefinedField');
    expect(JSON.stringify(meta)).not.toMatch(/client_secret|access_token|BEGIN PRIVATE/i);
  });

  it('compactMeta e durationMs no resumo com average/max/min', () => {
    expect(compactMeta({ a: 1, b: undefined, c: null })).toEqual({ a: 1 });

    const summary = summarizeReconciliationResults(
      [
        {
          paymentId: 'p1',
          txid: 't1',
          previousStatus: 'active',
          currentStatus: 'paid',
          matched: true,
          action: 'confirmed',
          queryDurationMs: 100,
        },
        {
          paymentId: 'p2',
          txid: 't2',
          previousStatus: 'active',
          currentStatus: 'active',
          matched: true,
          action: 'unchanged',
          queryDurationMs: 200,
        },
      ],
      500,
      {
        queried: 2,
        skipped: 1,
        tokenRefreshes: 1,
        queryDurationsMs: [100, 200],
        pollingIntervalMs: 10_000,
        batchSize: 50,
      },
    );

    expect(summary.durationMs).toBe(500);
    expect(summary.queried).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.tokenRefreshes).toBe(1);
    expect(summary.averageQueryMs).toBe(150);
    expect(summary.maxQueryMs).toBe(200);
    expect(summary.minQueryMs).toBe(100);
    expect(summary.pollingIntervalMs).toBe(10_000);
    expect(summary.batchSize).toBe(50);
    expect(summary.confirmed).toBe(1);
  });

  it('resumo com queried=0 usa 0 em average/min/max e schema estável', () => {
    const summary = summarizeReconciliationResults([], 12, {
      queried: 0,
      skipped: 0,
      tokenRefreshes: 0,
      queryDurationsMs: [],
      pollingIntervalMs: 10_000,
      batchSize: 50,
    });

    expect(summary).toEqual({
      total: 0,
      confirmed: 0,
      pending: 0,
      cancelled: 0,
      errors: 0,
      mismatches: 0,
      durationMs: 12,
      queried: 0,
      skipped: 0,
      tokenRefreshes: 0,
      averageQueryMs: 0,
      maxQueryMs: 0,
      minQueryMs: 0,
      pollingIntervalMs: 10_000,
      batchSize: 50,
    });
  });

  it('classifica erros HTTP e timeout', () => {
    expect(
      classifyPixError(AppError.serviceUnavailable('auth', 'SICREDI_AUTH_FAILED')),
    ).toBe('sicredi_auth_error');
    expect(classifyPixError({ code: 'ETIMEDOUT', message: 'timeout' })).toBe('sicredi_timeout');
    expect(classifyPixError(null, { httpStatus: 503 })).toBe('sicredi_http_error');
    expect(classifyPixError(null, { httpStatus: 401 })).toBe('sicredi_auth_error');
  });

  it('logs principais incluem correlationId e omitem dados sensíveis', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    pixLog('info', 'Pagamento criado', {
      correlationId: 'pay-1',
      paymentId: 'pay-1',
      txid: 'EGABCDEFGHIJKLMNOPQRSTUVWX',
      operation: 'payment_create',
      provider: 'sicredi',
      durationMs: 42,
      attempt: 1,
    });

    expect(infoSpy).toHaveBeenCalled();
    const meta = infoSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(meta.correlationId).toBe('pay-1');
    expect(meta.durationMs).toBe(42);
    expect(meta.txidMasked).toBeTruthy();
    expect(JSON.stringify(meta)).not.toContain('EGABCDEFGHIJKLMNOPQRSTUVWX');
  });

  it('heartbeat é escrito atomicamente e health ok quando recente', () => {
    const ok = writeReconciliationHeartbeat(
      {
        startedAt: new Date().toISOString(),
        lastCycleFinishedAt: new Date().toISOString(),
        lastSuccessfulCycleAt: new Date().toISOString(),
        lastCycleDurationMs: 180,
        lastCycleTotal: 0,
        lastCycleErrors: 0,
        consecutiveFailures: 0,
        isRunning: false,
        intervalMs: 10_000,
        enabled: true,
        nextRunAt: new Date(Date.now() + 10_000).toISOString(),
      },
      heartbeatPath,
    );
    expect(ok).toBe(true);
    expect(existsSync(heartbeatPath)).toBe(true);
    expect(readFileSync(heartbeatPath, 'utf8')).toContain('"enabled": true');

    const health = evaluateReconciliationHealth(readReconciliationHeartbeat(heartbeatPath));
    expect(health.status).toBe('ok');
    expect(health.lastCycleDurationMs).toBe(180);
  });

  it('health degraded/down quando heartbeat está stale', () => {
    const staleIso = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(
      heartbeatPath,
      JSON.stringify({
        startedAt: staleIso,
        lastCycleFinishedAt: staleIso,
        lastSuccessfulCycleAt: staleIso,
        lastCycleDurationMs: 10,
        lastCycleTotal: 1,
        lastCycleErrors: 0,
        consecutiveFailures: 0,
        isRunning: false,
        intervalMs: 10_000,
        enabled: true,
        nextRunAt: null,
      }),
      'utf8',
    );

    const health = evaluateReconciliationHealth(readReconciliationHeartbeat(heartbeatPath));
    expect(health.status).toBe('down');
    expect(health.staleMs).toBeGreaterThan(30_000);
  });

  it('falha na escrita do heartbeat não derruba o worker', () => {
    const invalidPath = join(tempDir, 'missing-dir-as-file');
    writeFileSync(invalidPath, 'not-a-dir', 'utf8');
    const ok = writeReconciliationHeartbeat(
      { enabled: true, intervalMs: 10000 },
      join(invalidPath, 'health.json'),
    );
    expect(ok).toBe(false);
  });

  it('GET /health/reconciliation retorna ok com heartbeat recente', async () => {
    writeReconciliationHeartbeat(
      {
        startedAt: new Date().toISOString(),
        lastCycleFinishedAt: new Date().toISOString(),
        lastSuccessfulCycleAt: new Date().toISOString(),
        lastCycleDurationMs: 120,
        lastCycleTotal: 2,
        lastCycleErrors: 0,
        consecutiveFailures: 0,
        isRunning: true,
        intervalMs: 10_000,
        enabled: true,
        nextRunAt: new Date(Date.now() + 10_000).toISOString(),
      },
      heartbeatPath,
    );

    const app = createApp();
    const res = await request(app).get('/health/reconciliation');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.lastCycleDurationMs).toBe(120);
    expect(JSON.stringify(res.body)).not.toMatch(/token|secret|cpf|chave|certificate/i);
  });
});
