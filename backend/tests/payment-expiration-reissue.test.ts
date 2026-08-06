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
} from '../src/repositories/payment.repository.js';
import {
  clearAuditLogMemoryStore,
  listAuditLogMemoryStore,
} from '../src/repositories/audit-log.repository.js';
import { clearMockPixStore } from '../src/services/mock/mock-pix.provider.js';
import { resetPaymentProviderCache } from '../src/services/payment/payment-provider.factory.js';
import { paymentExpirationService } from '../src/services/payment/payment-expiration.service.js';
import { paymentService } from '../src/services/payment/payment.service.js';
import { expirePaymentsOnce } from '../src/jobs/expire-payments.job.js';
import type { ProviderChargeStatus } from '../src/types/payment.types.js';
import { logger } from '../src/utils/logger.js';

const VALID_CPF = '52998224725';
const apiKey = 'test-expire-reissue-key';

function remoteCob(
  partial: Partial<ProviderChargeStatus> & { sicrediStatus: string },
): ProviderChargeStatus {
  return {
    txid: partial.txid ?? 'EGABCDEFGHIJKLMNOPQRSTUVWX',
    status: partial.status ?? 'active',
    sicrediStatus: partial.sicrediStatus,
    amountOriginal: partial.amountOriginal ?? '199.90',
    receivedAmount: partial.receivedAmount ?? partial.amountOriginal ?? '199.90',
    endToEndId: partial.endToEndId ?? 'E2EEXPIRE123456789012345678901',
    paidAt: partial.paidAt ?? new Date().toISOString(),
    raw: partial.raw ?? { status: partial.sicrediStatus },
  };
}

function seedAthlete(regId: string): void {
  const athleteId = randomUUID();
  seedAthleteForTest({ id: athleteId, fullName: 'Atleta Expire', cpf: VALID_CPF });
  seedRegistrationAthleteForTest({
    id: randomUUID(),
    registrationId: regId,
    athleteId,
    role: 'athlete_a',
  });
}

describe('Etapa 3 — expiração e reemissão Pix', () => {
  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'test';
    process.env.INTERNAL_API_KEY = apiKey;
    process.env.PAYMENT_EXPIRATION_ENABLED = 'true';
    process.env.PAYMENT_RECONCILIATION_ENABLED = 'true';
    resetEnvCache();
    loadEnv();
  });

  beforeEach(() => {
    clearPaymentMemoryStore();
    clearAuditLogMemoryStore();
    clearMockPixStore();
    resetPaymentProviderCache();
    paymentExpirationService.resetCycleLock();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    paymentExpirationService.resetCycleLock();
  });

  async function seedExpiredSicrediCharge(opts?: { amount?: number }) {
    const regId = randomUUID();
    const amount = opts?.amount ?? 199.9;
    seedRegistrationForTest({
      id: regId,
      totalPrice: amount,
      status: 'pending_payment',
    });
    seedAthlete(regId);

    const sicredi = await paymentRepository.findProviderByCode('sicredi');
    expect(sicredi).not.toBeNull();

    const txid = `EG${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const past = new Date(Date.now() - 60_000).toISOString();
    const payment = await paymentRepository.createPayment({
      registrationId: regId,
      providerId: sicredi!.id,
      amount,
      totalAmount: amount,
      status: 'active',
    });
    await paymentRepository.updatePaymentStatus(payment.id, 'active', {
      txid,
      providerChargeId: txid,
      expiresAt: past,
    });
    const charge = await paymentRepository.createPaymentCharge({
      paymentId: payment.id,
      providerId: sicredi!.id,
      txid,
      amount,
      status: 'active',
      expiresAt: past,
      isCurrent: true,
    });

    return { paymentId: payment.id, chargeId: charge.id, regId, txid, amount };
  }

  it('charge vencida + Sicredi ATIVA -> expired', async () => {
    process.env.PAYMENT_PROVIDER = 'sicredi';
    // Bypass mTLS validation for unit path: force isSicredi via mock of getEnv isn't needed —
    // expiration uses sicrediChargeService only when getEnv().isSicredi. Keep mock provider
    // and spy queryRemoteCharge instead.
    process.env.PAYMENT_PROVIDER = 'mock';
    resetEnvCache();
    loadEnv();

    const seeded = await seedExpiredSicrediCharge();
    vi.spyOn(paymentExpirationService, 'queryRemoteCharge').mockResolvedValue({
      remote: remoteCob({
        txid: seeded.txid,
        sicrediStatus: 'ATIVA',
        status: 'active',
      }),
      durationMs: 12,
    });

    const result = await paymentExpirationService.processExpiredCandidate({
      payment: (await paymentRepository.findPaymentById(seeded.paymentId))!,
      charge: (await paymentRepository.listChargesByPaymentId(seeded.paymentId))[0]!,
    });

    expect(result.action).toBe('expired');
    const payment = await paymentRepository.findPaymentById(seeded.paymentId);
    expect(payment?.status).toBe('expired');
    const charge = (await paymentRepository.listChargesByPaymentId(seeded.paymentId))[0];
    expect(charge?.status).toBe('expired');
    expect(charge?.isCurrent).toBe(false);
  });

  it('charge vencida + Sicredi CONCLUIDA -> paid, não expired', async () => {
    const seeded = await seedExpiredSicrediCharge();
    vi.spyOn(paymentExpirationService, 'queryRemoteCharge').mockResolvedValue({
      remote: remoteCob({
        txid: seeded.txid,
        sicrediStatus: 'CONCLUIDA',
        status: 'paid',
        amountOriginal: '199.90',
        receivedAmount: '199.90',
      }),
      durationMs: 15,
    });

    // Confirm path for mock provider (not isSicredi): processExpiredCandidate uses provider.getCharge
    // after classification paid — stub queryRemote already returned paid.
    const mockProvider = await import('../src/services/payment/payment-provider.factory.js').then(
      (m) => m.getPaymentProvider(),
    );
    vi.spyOn(await mockProvider, 'getCharge').mockResolvedValue(
      remoteCob({
        txid: seeded.txid,
        sicrediStatus: 'CONCLUIDA',
        status: 'paid',
        amountOriginal: '199.90',
        receivedAmount: '199.90',
      }),
    );

    const result = await paymentExpirationService.processExpiredCandidate({
      payment: (await paymentRepository.findPaymentById(seeded.paymentId))!,
      charge: (await paymentRepository.listChargesByPaymentId(seeded.paymentId))[0]!,
    });

    expect(result.action).toBe('confirmed_before_expire');
    const payment = await paymentRepository.findPaymentById(seeded.paymentId);
    expect(payment?.status).toBe('paid');
    expect(payment?.status).not.toBe('expired');
    const registration = await paymentRepository.findRegistrationById(seeded.regId);
    expect(registration?.status).toBe('paid');
  });

  it('erro transitório Sicredi -> mantém active', async () => {
    const seeded = await seedExpiredSicrediCharge();
    vi.spyOn(paymentExpirationService, 'queryRemoteCharge').mockRejectedValue(
      new Error('socket hang up'),
    );

    const result = await paymentExpirationService.processExpiredCandidate({
      payment: (await paymentRepository.findPaymentById(seeded.paymentId))!,
      charge: (await paymentRepository.listChargesByPaymentId(seeded.paymentId))[0]!,
    });

    expect(result.action).toBe('skipped');
    expect(result.message).toBe('transient_remote_error');
    const charge = (await paymentRepository.listChargesByPaymentId(seeded.paymentId))[0];
    expect(charge?.status).toBe('active');
    const payment = await paymentRepository.findPaymentById(seeded.paymentId);
    expect(payment?.status).toBe('active');
  });

  it('expiração atualiza charge, payment e registration', async () => {
    const seeded = await seedExpiredSicrediCharge();
    vi.spyOn(paymentExpirationService, 'queryRemoteCharge').mockResolvedValue({
      remote: remoteCob({ txid: seeded.txid, sicrediStatus: 'ATIVA', status: 'active' }),
      durationMs: 8,
    });

    await paymentExpirationService.processExpiredCandidate({
      payment: (await paymentRepository.findPaymentById(seeded.paymentId))!,
      charge: (await paymentRepository.listChargesByPaymentId(seeded.paymentId))[0]!,
    });

    expect((await paymentRepository.findPaymentById(seeded.paymentId))?.status).toBe('expired');
    expect((await paymentRepository.listChargesByPaymentId(seeded.paymentId))[0]?.status).toBe(
      'expired',
    );
    expect((await paymentRepository.findRegistrationById(seeded.regId))?.status).toBe('draft');
  });

  it('segunda execução não duplica auditoria', async () => {
    const seeded = await seedExpiredSicrediCharge();
    vi.spyOn(paymentExpirationService, 'queryRemoteCharge').mockResolvedValue({
      remote: remoteCob({ txid: seeded.txid, sicrediStatus: 'ATIVA', status: 'active' }),
      durationMs: 5,
    });

    const payment = (await paymentRepository.findPaymentById(seeded.paymentId))!;
    const charge = (await paymentRepository.listChargesByPaymentId(seeded.paymentId))[0]!;

    await paymentExpirationService.processExpiredCandidate({ payment, charge });
    const afterFirst = listAuditLogMemoryStore().filter((a) => a.action === 'PIX_CHARGE_EXPIRED');
    expect(afterFirst).toHaveLength(1);

    await paymentExpirationService.processExpiredCandidate({
      payment: (await paymentRepository.findPaymentById(seeded.paymentId))!,
      charge: (await paymentRepository.listChargesByPaymentId(seeded.paymentId))[0]!,
    });
    const afterSecond = listAuditLogMemoryStore().filter((a) => a.action === 'PIX_CHARGE_EXPIRED');
    expect(afterSecond).toHaveLength(1);
  });

  it('resumo do ciclo tem schema estável', async () => {
    const summary = await paymentExpirationService.runCycle({ limit: 10, concurrency: 2 });
    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      operation: 'payment_expiration_cycle',
      provider: 'mock',
      durationMs: expect.any(Number),
      total: expect.any(Number),
      expired: expect.any(Number),
      confirmedBeforeExpire: expect.any(Number),
      cancelled: expect.any(Number),
      skipped: expect.any(Number),
      errors: expect.any(Number),
      queried: expect.any(Number),
      averageQueryMs: expect.any(Number),
      minQueryMs: expect.any(Number),
      maxQueryMs: expect.any(Number),
      batchSize: expect.any(Number),
      intervalMs: expect.any(Number),
    });
  });

  it('reemissão cria nova charge current e antiga fica is_current=false', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 150, status: 'draft' });
    seedAthlete(regId);

    const created = await paymentService.createPayment({ registrationId: regId });
    await paymentRepository.updatePaymentStatus(created.paymentId, 'active', {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const oldChargeId = created.chargeId!;
    await paymentRepository.updateChargeStatus(oldChargeId, 'active', {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    vi.spyOn(paymentExpirationService, 'queryRemoteCharge').mockResolvedValue({
      remote: remoteCob({
        txid: created.txid!,
        sicrediStatus: 'ATIVA',
        status: 'active',
      }),
      durationMs: 3,
    });
    await expirePaymentsOnce();

    await paymentRepository.updateRegistrationStatus(regId, 'draft');

    const reissued = await paymentService.reissuePixPayment({
      registrationId: regId,
      paymentId: created.paymentId,
      reason: 'test_reissue',
    });

    expect(reissued.paymentId).toBe(created.paymentId);
    expect(reissued.chargeId).not.toBe(oldChargeId);
    expect(reissued.status).toBe('active');
    expect(reissued.pixCopiaECola).toBeTruthy();

    const charges = await paymentRepository.listChargesByPaymentId(created.paymentId);
    expect(charges).toHaveLength(2);
    const current = charges.find((c) => c.isCurrent);
    const old = charges.find((c) => c.id === oldChargeId);
    expect(current?.id).toBe(reissued.chargeId);
    expect(old?.isCurrent).toBe(false);
  });

  it('não permite reemitir se já paid', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 120, status: 'draft' });
    seedAthlete(regId);
    const created = await paymentService.createPayment({ registrationId: regId });
    await paymentRepository.updatePaymentStatus(created.paymentId, 'paid', {
      paidAt: new Date().toISOString(),
      endToEndId: 'E2EPAID123456789012345678901234',
    });
    await paymentRepository.updateRegistrationStatus(regId, 'paid');

    await expect(
      paymentService.reissuePixPayment({
        registrationId: regId,
        paymentId: created.paymentId,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_PAID' });
  });

  it('não permite duas charges current simultâneas', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 99, status: 'draft' });
    seedAthlete(regId);
    const created = await paymentService.createPayment({ registrationId: regId });

    await expect(
      paymentService.createPayment({ registrationId: regId }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CHARGE_EXISTS' });

    await expect(
      paymentService.reissuePixPayment({
        registrationId: regId,
        paymentId: created.paymentId,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CHARGE_EXISTS' });
  });

  it('endpoint exige autenticação', async () => {
    const app = createApp();
    const res = await request(app).post(`/api/v1/payments/${randomUUID()}/reissue`);
    expect(res.status).toBe(401);
  });

  it('endpoint bloqueia usuário sem permissão (API key inválida)', async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/v1/payments/${randomUUID()}/reissue`)
      .set('X-API-Key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('endpoint reissue autenticado retorna payload seguro', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 180, status: 'draft' });
    seedAthlete(regId);
    const created = await paymentService.createPayment({ registrationId: regId });

    const past = new Date(Date.now() - 2000).toISOString();
    await paymentRepository.updatePaymentStatus(created.paymentId, 'expired', { expiresAt: past });
    await paymentRepository.updateChargeStatus(created.chargeId!, 'expired', {
      isCurrent: false,
      expiresAt: past,
    });
    await paymentRepository.updateRegistrationStatus(regId, 'draft');

    const app = createApp();
    const res = await request(app)
      .post(`/api/v1/payments/${created.paymentId}/reissue`)
      .set('X-API-Key', apiKey)
      .send({ reason: 'user_retry' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      paymentId: created.paymentId,
      chargeId: expect.any(String),
      txid: expect.any(String),
      status: 'active',
      amount: expect.any(String),
      expiresAt: expect.any(String),
      pixCopiaECola: expect.any(String),
    });
    expect(res.body.chargeId).not.toBe(created.chargeId);
  });

  it('Pix Copia e Cola não aparece integralmente em logs', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 110, status: 'draft' });
    seedAthlete(regId);
    const created = await paymentService.createPayment({ registrationId: regId });
    const past = new Date(Date.now() - 2000).toISOString();
    await paymentRepository.updatePaymentStatus(created.paymentId, 'expired', { expiresAt: past });
    await paymentRepository.updateChargeStatus(created.chargeId!, 'expired', {
      isCurrent: false,
      expiresAt: past,
    });
    await paymentRepository.updateRegistrationStatus(regId, 'draft');

    const infoSpy = vi.spyOn(logger, 'info');
    const reissued = await paymentService.reissuePixPayment({
      registrationId: regId,
      paymentId: created.paymentId,
    });

    const logged = JSON.stringify(infoSpy.mock.calls);
    expect(reissued.pixCopiaECola).toBeTruthy();
    expect(logged).not.toContain(reissued.pixCopiaECola!);
  });
});
