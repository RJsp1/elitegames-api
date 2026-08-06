import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import {
  clearPaymentMemoryStore,
  paymentRepository,
  seedRegistrationForTest,
  seedAthleteForTest,
  seedRegistrationAthleteForTest,
  seedReservationForTest,
} from '../src/repositories/payment.repository.js';
import {
  clearAuditLogMemoryStore,
  listAuditLogMemoryStore,
  sanitizeAuditError,
  getAuditLogsSchemaColumns,
} from '../src/repositories/audit-log.repository.js';
import { clearMockPixStore } from '../src/services/mock/mock-pix.provider.js';
import { resetPaymentProviderCache } from '../src/services/payment/payment-provider.factory.js';
import { sicrediReconciliationService } from '../src/services/sicredi/sicredi-reconciliation.service.js';
import { financialAuditService } from '../src/services/audit/financial-audit.service.js';
import type { ProviderChargeStatus } from '../src/types/payment.types.js';
import * as auditMod from '../src/repositories/audit-log.repository.js';
import { maskTxid, maskEndToEndId } from '../src/utils/redact-sensitive-data.js';

const VALID_CPF = '52998224725';

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

describe('Etapa 1 — auditoria financeira Pix', () => {
  const apiKey = process.env.INTERNAL_API_KEY || 'test-internal-api-key';

  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_RECONCILIATION_ENABLED = 'true';
    resetEnvCache();
    loadEnv();
  });

  beforeEach(() => {
    clearPaymentMemoryStore();
    clearAuditLogMemoryStore();
    clearMockPixStore();
    resetPaymentProviderCache();
    sicrediReconciliationService.resetCycleLock();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedActiveSicrediPayment(opts?: { amount?: number; status?: 'pending' | 'active' }) {
    const regId = randomUUID();
    const amount = opts?.amount ?? 199.9;
    seedRegistrationForTest({
      id: regId,
      totalPrice: amount,
      status: 'pending_payment',
    });
    const sicredi = await paymentRepository.findProviderByCode('sicredi');
    const txid = `EG${randomUUID().replace(/-/g, '').slice(0, 24)}`;
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
    const charge = await paymentRepository.createPaymentCharge({
      paymentId: payment.id,
      providerId: sicredi!.id,
      txid,
      amount,
      status: opts?.status ?? 'active',
      isCurrent: true,
    });
    return { paymentId: payment.id, regId, txid, amount, chargeId: charge.id };
  }

  it('documenta schema real de audit_logs', () => {
    expect(getAuditLogsSchemaColumns()).toEqual(
      expect.arrayContaining([
        'id',
        'action',
        'entity_table',
        'entity_id',
        'before',
        'after',
        'reason',
        'created_at',
      ]),
    );
  });

  it('PAYMENT_CREATED e PIX_CHARGE_CREATED na criação', async () => {
    const regId = randomUUID();
    const reservationId = randomUUID();
    seedRegistrationForTest({
      id: regId,
      totalPrice: 199.9,
      status: 'draft',
      reservationId,
    });
    const athleteId = randomUUID();
    seedAthleteForTest({ id: athleteId, fullName: 'Atleta Audit', cpf: VALID_CPF });
    seedRegistrationAthleteForTest({
      id: randomUUID(),
      registrationId: regId,
      athleteId,
      role: 'athlete_a',
    });
    seedReservationForTest({ id: reservationId, registrationId: regId, status: 'active' });

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/payments')
      .set('X-API-Key', apiKey)
      .send({ registrationId: regId });

    expect(res.status).toBe(201);

    const audits = listAuditLogMemoryStore();
    const created = audits.filter((a) => a.action === 'PAYMENT_CREATED');
    const chargeCreated = audits.filter((a) => a.action === 'PIX_CHARGE_CREATED');
    const statusChanged = audits.filter((a) => a.action === 'PAYMENT_STATUS_CHANGED');
    const regChanged = audits.filter((a) => a.action === 'REGISTRATION_STATUS_CHANGED');

    expect(created).toHaveLength(1);
    expect(created[0]?.entityTable).toBe('payments');
    expect(created[0]?.after).toMatchObject({
      status: 'pending',
      provider: 'mock',
      registration_id: regId,
    });
    expect(JSON.stringify(created[0])).not.toMatch(/000201/);

    expect(chargeCreated).toHaveLength(1);
    expect(chargeCreated[0]?.entityTable).toBe('payment_charges');
    expect(chargeCreated[0]?.after).toMatchObject({
      payment_id: res.body.paymentId,
      status: 'active',
      is_current: true,
    });

    expect(statusChanged.some((a) => a.after && (a.after as { status?: string }).status === 'active')).toBe(
      true,
    );
    expect(regChanged.some((a) => (a.after as { status?: string }).status === 'pending_payment')).toBe(
      true,
    );
  });

  it('ATIVA não cria auditoria repetitiva', async () => {
    const seeded = await seedActiveSicrediPayment({ status: 'active' });
    const spy = vi.spyOn(auditMod.auditLogRepository, 'writeFinancialEvent');

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

    const first = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    const second = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    expect(first.action).toBe('unchanged');
    expect(second.action).toBe('unchanged');
    expect(spy).not.toHaveBeenCalled();
  });

  it('CONCLUIDA cria PAYMENT_RECONCILED uma vez + STATUS_CHANGED + REGISTRATION', async () => {
    const seeded = await seedActiveSicrediPayment();

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
        endToEndId: 'E2EFULL123456789012345678901234',
      }),
    );

    const result = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    expect(result.action).toBe('confirmed');

    // Segunda tentativa de audit reconciliado (idempotente)
    await financialAuditService.paymentReconciled({
      paymentId: seeded.paymentId,
      previousPaymentStatus: 'active',
      previousChargeStatus: 'active',
      paidAt: new Date().toISOString(),
      endToEndId: 'E2EFULL123456789012345678901234',
      amountReceived: '199.90',
      reason: 'polling_sicredi',
    });

    const audits = listAuditLogMemoryStore();
    const reconciled = audits.filter((a) => a.action === 'PAYMENT_RECONCILED');
    const statusChanged = audits.filter((a) => a.action === 'PAYMENT_STATUS_CHANGED');
    const regChanged = audits.filter((a) => a.action === 'REGISTRATION_STATUS_CHANGED');

    expect(reconciled).toHaveLength(1);
    expect(statusChanged.length).toBeGreaterThanOrEqual(1);
    expect(regChanged.some((a) => (a.after as { status?: string }).status === 'paid')).toBe(true);

    const dumped = JSON.stringify(reconciled[0]);
    expect(dumped).not.toContain('E2EFULL123456789012345678901234');
    expect(dumped).toContain(maskEndToEndId('E2EFULL123456789012345678901234'));
  });

  it('divergência cria PAYMENT_AMOUNT_MISMATCH sem paid e sem duplicar', async () => {
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

    const first = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    const second = await sicrediReconciliationService.reconcilePayment(seeded.paymentId);
    expect(first.action).toBe('amount_mismatch');
    expect(second.action).toBe('amount_mismatch');

    const mismatches = listAuditLogMemoryStore().filter(
      (a) => a.action === 'PAYMENT_AMOUNT_MISMATCH',
    );
    expect(mismatches).toHaveLength(1);

    const payment = await paymentRepository.findPaymentById(seeded.paymentId);
    expect(payment?.status).toBe('active');
  });

  it('falha do audit_logs não impede pagamento', async () => {
    const seeded = await seedActiveSicrediPayment();
    vi.spyOn(auditMod.auditLogRepository, 'writeFinancialEvent').mockResolvedValue({
      ok: false,
      duplicated: false,
      record: null,
      errorCode: '23502',
      errorMessage: 'null value in column "entity_table"',
    });

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
    expect((await paymentRepository.findPaymentById(seeded.paymentId))?.status).toBe('paid');
    expect(
      (await paymentRepository.findCurrentChargeByPaymentId(seeded.paymentId))?.status,
    ).toBe('paid');
    expect((await paymentRepository.findRegistrationById(seeded.regId))?.status).toBe('paid');
  });

  it('mascaramento de txid/e2e e sanitize 23502', () => {
    expect(maskTxid('EGABCDEFGHIJKLMNOPQRSTUVWX')).toBe('EGAB…UVWX');
    expect(maskEndToEndId('E2EABCDEFGH1234567890XYZ')).toMatch(/^E2EA/);

    const sanitized = sanitizeAuditError({
      code: '23502',
      message: 'null value in column "entity_table" of relation "audit_logs" violates not-null constraint',
      details: 'Failing row contains (...)',
    });
    expect(sanitized.code).toBe('23502');
    expect(sanitized.message).toContain('entity_table');
    expect(sanitized.message).not.toBe('unknown_audit_error');
  });

  it('PIX_CHARGE_CREATED não duplica', async () => {
    const chargeId = randomUUID();
    const first = await financialAuditService.pixChargeCreated({
      chargeId,
      paymentId: randomUUID(),
      txid: 'EGABCDEFGHIJKLMNOPQRSTUVWX',
      status: 'active',
      amount: 199.9,
      expiresAt: new Date().toISOString(),
      isCurrent: true,
    });
    const second = await financialAuditService.pixChargeCreated({
      chargeId,
      paymentId: randomUUID(),
      txid: 'EGABCDEFGHIJKLMNOPQRSTUVWX',
      status: 'active',
      amount: 199.9,
      expiresAt: new Date().toISOString(),
      isCurrent: true,
    });
    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    expect(listAuditLogMemoryStore().filter((a) => a.action === 'PIX_CHARGE_CREATED')).toHaveLength(
      1,
    );
  });
});
