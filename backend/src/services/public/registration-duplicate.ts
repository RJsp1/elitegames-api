import type { RegistrationRecord, RegistrationStatus } from '../../types/payment.types.js';
import { normalizeCpfDigits } from '../../utils/cpf.js';

/** Statuses that block creating another registration for the same event+category+athlete. */
export const BLOCKING_REGISTRATION_STATUSES: ReadonlySet<RegistrationStatus> = new Set([
  'draft',
  'pending_payment',
  'paid',
  'confirmed',
]);

export const PAID_REGISTRATION_STATUSES: ReadonlySet<RegistrationStatus> = new Set([
  'paid',
  'confirmed',
]);

export const REUSABLE_REGISTRATION_STATUSES: ReadonlySet<RegistrationStatus> = new Set([
  'draft',
  'pending_payment',
]);

export type RegistrationCreateOutcome =
  | 'NEW_REGISTRATION'
  | 'REUSED_PENDING_REGISTRATION'
  | 'ALREADY_PAID';

/** Lock key: event + category + sorted CPFs (covers individual and team members). */
export function buildDuplicateLockKey(
  eventId: string,
  categoryId: string,
  athleteCpfs: string[],
): string {
  const cpfs = [...new Set(athleteCpfs.map((c) => normalizeCpfDigits(c)).filter(Boolean))].sort();
  return `reg-dup:${eventId}:${categoryId}:${cpfs.join(',')}`;
}

/**
 * Prefer paid/confirmed; else oldest reusable (draft/pending_payment).
 * Cancelled / refunded / waitlist are ignored (Case D).
 */
export function pickBlockingRegistration(
  rows: RegistrationRecord[],
): { kind: 'paid'; registration: RegistrationRecord } | { kind: 'reusable'; registration: RegistrationRecord } | null {
  const paid = rows
    .filter((r) => PAID_REGISTRATION_STATUSES.has(r.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (paid[0]) return { kind: 'paid', registration: paid[0] };

  const reusable = rows
    .filter((r) => REUSABLE_REGISTRATION_STATUSES.has(r.status))
    .sort((a, b) => {
      // pending_payment before draft
      if (a.status !== b.status) {
        if (a.status === 'pending_payment') return -1;
        if (b.status === 'pending_payment') return 1;
      }
      return a.createdAt.localeCompare(b.createdAt);
    });
  if (reusable[0]) return { kind: 'reusable', registration: reusable[0] };
  return null;
}

/** In-process mutex for concurrent creates with same identity (single Node instance). */
const createLocks = new Set<string>();

export async function withRegistrationCreateLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  while (createLocks.has(lockKey)) {
    if (Date.now() - started > 15_000) {
      throw new Error('REGISTRATION_CREATE_LOCK_TIMEOUT');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  createLocks.add(lockKey);
  try {
    return await fn();
  } finally {
    createLocks.delete(lockKey);
  }
}

export function clearRegistrationCreateLocksForTest(): void {
  createLocks.clear();
}
