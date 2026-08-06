import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from './logger.js';

export interface ReconciliationHeartbeat {
  startedAt: string;
  lastCycleStartedAt: string | null;
  lastCycleFinishedAt: string | null;
  lastSuccessfulCycleAt: string | null;
  lastCycleDurationMs: number | null;
  lastCycleTotal: number;
  lastCycleErrors: number;
  consecutiveFailures: number;
  isRunning: boolean;
  nextRunAt: string | null;
  intervalMs: number;
  enabled: boolean;
}

export type ReconciliationHealthStatus = 'ok' | 'degraded' | 'down';

export interface ReconciliationHealthResponse {
  status: ReconciliationHealthStatus;
  enabled: boolean;
  isRunning: boolean;
  lastSuccessfulCycleAt: string | null;
  lastCycleFinishedAt: string | null;
  lastCycleDurationMs: number | null;
  lastCycleTotal: number;
  lastCycleErrors: number;
  consecutiveFailures: number;
  intervalMs: number;
  nextRunAt: string | null;
  staleMs: number | null;
}

const DEFAULT_RELATIVE_PATH = 'runtime/reconciliation-health.json';

export function getReconciliationHeartbeatPath(
  overridePath = process.env.RECONCILIATION_HEARTBEAT_PATH,
): string {
  return resolve(process.cwd(), overridePath || DEFAULT_RELATIVE_PATH);
}

function emptyHeartbeat(partial?: Partial<ReconciliationHeartbeat>): ReconciliationHeartbeat {
  return {
    startedAt: new Date().toISOString(),
    lastCycleStartedAt: null,
    lastCycleFinishedAt: null,
    lastSuccessfulCycleAt: null,
    lastCycleDurationMs: null,
    lastCycleTotal: 0,
    lastCycleErrors: 0,
    consecutiveFailures: 0,
    isRunning: false,
    nextRunAt: null,
    intervalMs: 10_000,
    enabled: true,
    ...partial,
  };
}

/** Escrita atômica: tmp + rename. Falha nunca propaga. */
export function writeReconciliationHeartbeat(
  patch: Partial<ReconciliationHeartbeat>,
  filePath = getReconciliationHeartbeatPath(),
): boolean {
  try {
    const current = readReconciliationHeartbeat(filePath) ?? emptyHeartbeat();
    const next: ReconciliationHeartbeat = { ...current, ...patch };
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, filePath);
    return true;
  } catch (error) {
    logger.warn('Falha ao gravar heartbeat de reconciliação', {
      message: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      operation: 'health',
    });
    return false;
  }
}

export function readReconciliationHeartbeat(
  filePath = getReconciliationHeartbeatPath(),
): ReconciliationHeartbeat | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ReconciliationHeartbeat;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function evaluateReconciliationHealth(
  heartbeat: ReconciliationHeartbeat | null,
  now = Date.now(),
): ReconciliationHealthResponse {
  if (!heartbeat) {
    return {
      status: 'down',
      enabled: false,
      isRunning: false,
      lastSuccessfulCycleAt: null,
      lastCycleFinishedAt: null,
      lastCycleDurationMs: null,
      lastCycleTotal: 0,
      lastCycleErrors: 0,
      consecutiveFailures: 0,
      intervalMs: 10_000,
      nextRunAt: null,
      staleMs: null,
    };
  }

  const intervalMs = Math.max(1_000, Number(heartbeat.intervalMs) || 10_000);
  const referenceIso = heartbeat.lastCycleFinishedAt ?? heartbeat.startedAt;
  const referenceMs = Date.parse(referenceIso);
  const staleMs = Number.isFinite(referenceMs) ? Math.max(0, now - referenceMs) : null;
  const staleLimit = intervalMs * 3;

  let status: ReconciliationHealthStatus = 'ok';
  if (!heartbeat.enabled) {
    status = 'down';
  } else if (staleMs != null && staleMs > staleLimit) {
    status = 'down';
  } else if (
    heartbeat.consecutiveFailures > 0 ||
    (staleMs != null && staleMs > intervalMs * 1.5)
  ) {
    status = 'degraded';
  }

  return {
    status,
    enabled: Boolean(heartbeat.enabled),
    isRunning: Boolean(heartbeat.isRunning),
    lastSuccessfulCycleAt: heartbeat.lastSuccessfulCycleAt,
    lastCycleFinishedAt: heartbeat.lastCycleFinishedAt,
    lastCycleDurationMs: heartbeat.lastCycleDurationMs,
    lastCycleTotal: heartbeat.lastCycleTotal ?? 0,
    lastCycleErrors: heartbeat.lastCycleErrors ?? 0,
    consecutiveFailures: heartbeat.consecutiveFailures ?? 0,
    intervalMs,
    nextRunAt: heartbeat.nextRunAt,
    staleMs,
  };
}
