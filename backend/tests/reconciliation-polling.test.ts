import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import {
  clearPaymentMemoryStore,
  paymentRepository,
  seedRegistrationForTest,
} from '../src/repositories/payment.repository.js';
import { clearAuditLogMemoryStore } from '../src/repositories/audit-log.repository.js';
import {
  classifySicrediCobStatus,
  sicrediReconciliationService,
  summarizeReconciliationResults,
} from '../src/services/sicredi/sicredi-reconciliation.service.js';
import type { ProviderChargeStatus } from '../src/types/payment.types.js';
import * as auditMod from '../src/repositories/audit-log.repository.js';
import { sanitizeAuditError } from '../src/repositories/audit-log.repository.js';

function remoteCob(partial: Partial<ProviderChargeStatus> & { sicrediStatus: string }): ProviderChargeStatus {
  return {
    txid: partial.txid ?? 'EGABCDEFGHIJKLMNOPQRSTUVWX',
    status: partial.status ?? 'paid',
    sicrediStatus: partial.sicrediStatus,
    amountOriginal: partial.amountOriginal ?? '199.90',
    receivedAmount: partial.receivedAmount ?? partial.amountOriginal ?? '199.90',
    endToEndId: partial.endToEndId ?? 'E2ERECON1234567890123456789012',
    paidAt: partial.paidAt ?? new Date().toISOString(),
    raw: partial.raw ?? { status: partial.sicrediStatus },
  };
}

describe('classifySicrediCobStatus', () => {
  it('mapeia status conhecidos', () => {
    expect(classifySicrediCobStatus('CONCLUIDA')).toBe('paid');
    expect(classifySicrediCobStatus('ATIVA')).toBe('active');
    expect(classifySicrediCobStatus('REMOVIDA_PELO_USUARIO_RECEBEDOR')).toBe('cancelled');
    expect(classifySicrediCobStatus('REMOVIDA_PELO_PSP')).toBe('cancelled');
    expect(classifySicrediCobStatus('ALGO_NOVO')).toBe('unknown');
  });
});

describe('Sicredi reconciliation polling', () => {
  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'test';
    process.env.PAYMENT_RECONCILIATION_ENABLED = 'true';
    process.env.PAYMENT_RECONCILIATION_BATCH_SIZE = '50';
    process.env.PAYMENT_RECONCILIATION_CONCURRENCY = '5';
    resetEnvCache();
    loadEnv();
  });

  beforeEach(() => {
    clearPaymentMemoryStore();
    clearAuditLogMemoryStore();
    sicrediReconciliationService.resetCycleLock();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sicrediReconciliationService.resetCycleLock();
  });

  async function seedActiveSicrediPayment(opts?: {
    amount?: number;
    status?: 'pending' | 'active';
    txid?: string;
  }) {
    const regId = randomUUID();
    const amount = opts?.amount ?? 199.9;
    seedRegistrationForTest({
      id: regId,
      totalPrice: amount,
      status: 'pending_payment',
    });

    const sicredi = await paymentRepository.findProviderByCode('sicredi');
    expect(sicredi).not.toBeNull();

    const txid = opts?.txid ?? `EG${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const payment = await paymentRepository.createPayment({
      registrationId: regId,
      providerId: sicredi!.id,
      amount,
      totalAmount: amount,
      status: opts?.status ?? 'active',
    });
    await paymentRepository.updatePaymentStatus(payment.id, opts?.status ?? 'active', {
      txid,
      providerChargeId: txid,
    });
    await paymentRepository.createPaymentCharge({
      paymentId: payment.id,
      providerId: sicredi!.id,
      txid,
      amount,
      status: opts?.status ?? 'active',
      isCurrent: true,
    });

    return { paymentId: payment.id, regId, txid, amount };
  }

  it('CONCLUIDA confirma pagamento, charge e registration paid', async () => {
    const seeded = await seedActiveSicrediPayment();
    const auditSpy = vi.spyOn(auditMod.auditLogRepository, 'write');

    vi.spyOn(
      await import('../src/services/sicredi/sicredi-charge.service.js').then(
        (m) => m.sicrediChargeService,
      ),
      'getCharge',
    ).mockResolvedValue(
      remoteCob({
        txid: seeded.txid,
        sicrediStatus: 'CONCLUIDA',
        status: 'paid',
        amountOriginal: '199.90',
        receivedAmount: '199.90',
      }),
    );

    const result = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    expect(result.action).toBe('confirmed');
    expect(result.currentStatus).toBe('paid');

    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]?.[0]).toMatchObject({
      action: 'PAYMENT_RECONCILED',
      entityType: 'payment',
      entityId: seeded.paymentId,
    });

    const summary = summarizeReconciliationResults([result], 420);
    expect(summary).toEqual({
      total: 1,
      confirmed: 1,
      pending: 0,
      cancelled: 0,
      errors: 0,
      mismatches: 0,
      durationMs: 420,
    });

    const payment = await paymentRepository.findPaymentById(seeded.paymentId);
    expect(payment?.status).toBe('paid');
    expect(payment?.paidAt).toBeTruthy();
    expect(payment?.endToEndId).toBeTruthy();

    const charge = await paymentRepository.findCurrentChargeByPaymentId(seeded.paymentId);
    expect(charge?.status).toBe('paid');

    const registration = await paymentRepository.findRegistrationById(seeded.regId);
    expect(registration?.status).toBe('paid');

    const stillQueued = await paymentRepository.listReconcilableSicrediPayments(50);
    expect(stillQueued.find((p) => p.id === seeded.paymentId)).toBeUndefined();
  });

  it('ATIVA permanece unchanged e não tenta auditoria PAYMENT_RECONCILED', async () => {
    const seeded = await seedActiveSicrediPayment({ status: 'pending' });
    const auditSpy = vi.spyOn(auditMod.auditLogRepository, 'write');

    vi.spyOn(
      (await import('../src/services/sicredi/sicredi-charge.service.js')).sicrediChargeService,
      'getCharge',
    ).mockResolvedValue(
      remoteCob({
        txid: seeded.txid,
        sicrediStatus: 'ATIVA',
        status: 'active',
        amountOriginal: '199.90',
      }),
    );

    const result = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    expect(result.action).toBe('unchanged');
    expect(result.currentStatus).toBe('pending');
    expect(auditSpy).not.toHaveBeenCalled();

    const payment = await paymentRepository.findPaymentById(seeded.paymentId);
    expect(payment?.status).toBe('pending');
    const registration = await paymentRepository.findRegistrationById(seeded.regId);
    expect(registration?.status).toBe('pending_payment');
  });

  it('divergência de valor não confirma', async () => {
    const seeded = await seedActiveSicrediPayment({ amount: 199.9 });

    vi.spyOn(
      (await import('../src/services/sicredi/sicredi-charge.service.js')).sicrediChargeService,
      'getCharge',
    ).mockResolvedValue(
      remoteCob({
        txid: seeded.txid,
        sicrediStatus: 'CONCLUIDA',
        status: 'paid',
        amountOriginal: '150.00',
        receivedAmount: '150.00',
      }),
    );

    const result = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    expect(result.action).toBe('amount_mismatch');

    const payment = await paymentRepository.findPaymentById(seeded.paymentId);
    expect(payment?.status).toBe('active');
    const registration = await paymentRepository.findRegistrationById(seeded.regId);
    expect(registration?.status).toBe('pending_payment');
  });

  it('idempotência: segundo ciclo em paid não quebra', async () => {
    const seeded = await seedActiveSicrediPayment();
    const getCharge = vi
      .spyOn(
        (await import('../src/services/sicredi/sicredi-charge.service.js')).sicrediChargeService,
        'getCharge',
      )
      .mockResolvedValue(
        remoteCob({
          txid: seeded.txid,
          sicrediStatus: 'CONCLUIDA',
          status: 'paid',
          amountOriginal: '199.90',
          receivedAmount: '199.90',
          endToEndId: 'E2EIDEMPOTENT123456789012345678',
        }),
      );

    const first = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    expect(first.action).toBe('confirmed');

    const second = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    expect(second.action).toBe('idempotent');
    expect(second.currentStatus).toBe('paid');

    // Segunda passagem não precisa consultar Sicredi (early return).
    expect(getCharge).toHaveBeenCalledTimes(1);

    const registration = await paymentRepository.findRegistrationById(seeded.regId);
    expect(registration?.status).toBe('paid');
  });

  it('erro em uma cobrança não para o lote', async () => {
    const ok = await seedActiveSicrediPayment({ amount: 199.9 });
    const bad = await seedActiveSicrediPayment({ amount: 199.9 });

    vi.spyOn(
      (await import('../src/services/sicredi/sicredi-charge.service.js')).sicrediChargeService,
      'getCharge',
    ).mockImplementation(async (txid: string) => {
      if (txid === bad.txid) {
        throw new Error('falha simulada Sicredi');
      }
      return remoteCob({
        txid,
        sicrediStatus: 'CONCLUIDA',
        status: 'paid',
        amountOriginal: '199.90',
        receivedAmount: '199.90',
      });
    });

    const results = await sicrediReconciliationService.reconcilePending(50, 5);
    expect(results).toHaveLength(2);

    const okResult = results.find((r) => r.paymentId === ok.paymentId);
    const badResult = results.find((r) => r.paymentId === bad.paymentId);
    expect(okResult?.action).toBe('confirmed');
    expect(badResult?.action).toBe('error');

    const okPayment = await paymentRepository.findPaymentById(ok.paymentId);
    const badPayment = await paymentRepository.findPaymentById(bad.paymentId);
    expect(okPayment?.status).toBe('paid');
    expect(badPayment?.status).toBe('active');
  });

  it('ciclo sobreposto é bloqueado', async () => {
    const seeded = await seedActiveSicrediPayment();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.spyOn(
      (await import('../src/services/sicredi/sicredi-charge.service.js')).sicrediChargeService,
      'getCharge',
    ).mockImplementation(async () => {
      await gate;
      return remoteCob({
        txid: seeded.txid,
        sicrediStatus: 'ATIVA',
        status: 'active',
        amountOriginal: '199.90',
      });
    });

    const firstPromise = sicrediReconciliationService.runCycle({ limit: 50, concurrency: 1 });
    // Aguarda o ciclo adquirir a trava
    await new Promise((r) => setTimeout(r, 20));
    const second = await sicrediReconciliationService.runCycle({ limit: 50, concurrency: 1 });
    expect(second).toBeNull();

    release();
    const first = await firstPromise;
    expect(first).not.toBeNull();
    expect(first!.length).toBeGreaterThanOrEqual(1);
  });

  it('auditoria falhando não derruba confirmação', async () => {
    const seeded = await seedActiveSicrediPayment();

    vi.spyOn(auditMod.auditLogRepository, 'write').mockRejectedValue(
      new Error('audit unavailable'),
    );

    vi.spyOn(
      (await import('../src/services/sicredi/sicredi-charge.service.js')).sicrediChargeService,
      'getCharge',
    ).mockResolvedValue(
      remoteCob({
        txid: seeded.txid,
        sicrediStatus: 'CONCLUIDA',
        status: 'paid',
        amountOriginal: '199.90',
        receivedAmount: '199.90',
      }),
    );

    const result = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    expect(result.action).toBe('confirmed');

    const payment = await paymentRepository.findPaymentById(seeded.paymentId);
    expect(payment?.status).toBe('paid');
    const charge = await paymentRepository.findCurrentChargeByPaymentId(seeded.paymentId);
    expect(charge?.status).toBe('paid');
    const registration = await paymentRepository.findRegistrationById(seeded.regId);
    expect(registration?.status).toBe('paid');
  });

  it('sanitizeAuditError expõe código Postgres sem unknown_audit_error opaco', () => {
    const sanitized = sanitizeAuditError({
      message: 'null value in column "entity_table" of relation "audit_logs" violates not-null constraint',
      code: '23502',
      details: 'Failing row contains (...)',
    });
    expect(sanitized.code).toBe('23502');
    expect(sanitized.message).toContain('entity_table');
    expect(sanitized.message).not.toBe('unknown_audit_error');
  });
});
