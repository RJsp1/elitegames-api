import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import {
  clearPaymentMemoryStore,
  paymentRepository,
  seedRegistrationForTest,
  seedReservationForTest,
  seedAthleteForTest,
  seedRegistrationAthleteForTest,
} from '../src/repositories/payment.repository.js';
import {
  auditLogRepository,
  clearAuditLogMemoryStore,
  getAuditLogsSchemaColumns,
} from '../src/repositories/audit-log.repository.js';
import { clearMockPixStore } from '../src/services/mock/mock-pix.provider.js';
import { resetPaymentProviderCache } from '../src/services/payment/payment-provider.factory.js';

const VALID_CPF = '52998224725';

function seedRegistrationWithAthlete(regId: string, reservationId: string): void {
  seedRegistrationForTest({
    id: regId,
    totalPrice: 199.9,
    status: 'draft',
    format: 'individual',
    registrationNumber: 'INS-AUDIT',
    reservationId,
  });
  const athleteId = randomUUID();
  seedAthleteForTest({
    id: athleteId,
    fullName: 'Atleta Audit Resilience',
    cpf: VALID_CPF,
  });
  seedRegistrationAthleteForTest({
    id: randomUUID(),
    registrationId: regId,
    athleteId,
    role: 'athlete_a',
  });
  seedReservationForTest({
    id: reservationId,
    registrationId: regId,
    status: 'active',
  });
}

describe('audit_logs schema + payment resilience', () => {
  const apiKey = process.env.INTERNAL_API_KEY || 'test-internal-api-key';

  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'development';
    resetEnvCache();
    loadEnv();
  });

  beforeEach(() => {
    clearPaymentMemoryStore();
    clearAuditLogMemoryStore();
    clearMockPixStore();
    resetPaymentProviderCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('documenta apenas colunas reais de public.audit_logs', () => {
    expect([...getAuditLogsSchemaColumns()].sort()).toEqual(
      [
        'action',
        'actor_id',
        'after',
        'before',
        'created_at',
        'entity_id',
        'entity_table',
        'id',
        'ip',
        'reason',
      ].sort(),
    );
    expect(getAuditLogsSchemaColumns()).not.toContain('actor');
    expect(getAuditLogsSchemaColumns()).not.toContain('entity_type');
    expect(getAuditLogsSchemaColumns()).not.toContain('metadata');
  });

  it('falha de auditoria não desfaz payments, payment_charges nem registrations.status', async () => {
    const regId = randomUUID();
    const reservationId = randomUUID();
    seedRegistrationWithAthlete(regId, reservationId);

    vi.spyOn(auditLogRepository, 'write').mockRejectedValueOnce(
      new Error("Could not find the 'actor' column of 'audit_logs' in the schema cache"),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/payments')
      .set('X-API-Key', apiKey)
      .send({ registrationId: regId });

    expect(res.status).toBe(201);
    expect(res.body.paymentId).toBeTruthy();
    expect(res.body.status).toBe('active');

    const payment = await paymentRepository.findPaymentById(res.body.paymentId);
    expect(payment).not.toBeNull();
    expect(payment?.status).toBe('active');
    expect(payment?.registrationId).toBe(regId);

    const charge = await paymentRepository.findCurrentChargeByPaymentId(res.body.paymentId);
    expect(charge).not.toBeNull();
    expect(charge?.status).toBe('active');
    expect(charge?.isCurrent).toBe(true);

    const registration = await paymentRepository.findRegistrationById(regId);
    expect(registration?.status).toBe('pending_payment');
  });
});
