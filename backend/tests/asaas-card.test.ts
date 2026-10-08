import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import {
  clearPaymentMemoryStore,
  paymentRepository,
  seedRegistrationForTest,
} from '../src/repositories/payment.repository.js';
import {
  brandInstallmentLimit,
  detectAcceptedBrand,
  passesLuhn,
} from '../src/services/asaas/card-brand.js';
import { listInstallmentOptions, quoteCard } from '../src/services/asaas/card-pricing.js';
import { mapAsaasStatus } from '../src/services/asaas/card-payment.service.js';
import { redactSensitiveData } from '../src/utils/redact-sensitive-data.js';

const FEES = {
  feeFixed: 0.49,
  feeTiers: [
    { from: 1, to: 1, percent: 2.99 },
    { from: 2, to: 6, percent: 3.49 },
    { from: 7, to: 12, percent: 3.99 },
    { from: 13, to: 21, percent: 4.29 },
  ],
  maxInstallments: 12,
  minInstallmentValue: 5,
};

const WEBHOOK_TOKEN = 'test-asaas-webhook-token-0123456789abcdef';

describe('card pricing (cliente paga a taxa)', () => {
  it('líquido após taxa Asaas é o preço da inscrição', () => {
    for (const n of [1, 2, 6, 7, 12]) {
      const q = quoteCard(199.9, n, FEES);
      const asaasFee = q.totalAmount * (q.feePercent / 100) + FEES.feeFixed;
      const net = q.totalAmount - asaasFee;
      expect(net).toBeGreaterThanOrEqual(199.9 - 0.001);
      expect(net - 199.9).toBeLessThan(0.02);
      expect(q.feeAmount).toBeCloseTo(q.totalAmount - 199.9, 2);
    }
  });

  it('à vista 2,99% + 0,49', () => {
    const q = quoteCard(100, 1, FEES);
    expect(q.feePercent).toBe(2.99);
    expect(q.totalAmount).toBe(103.59);
  });

  it('respeita parcela mínima', () => {
    const options = listInstallmentOptions(20, FEES);
    expect(options.length).toBeLessThan(12);
    for (const o of options) expect(o.totalAmount / o.installments).toBeGreaterThanOrEqual(5);
  });
});

describe('card brand allowlist', () => {
  it('aceita Visa, Mastercard, Elo e Amex', () => {
    expect(detectAcceptedBrand('4444444444444444')).toBe('VISA');
    expect(detectAcceptedBrand('5184019740373151')).toBe('MASTERCARD');
    expect(detectAcceptedBrand('2221000000000009')).toBe('MASTERCARD');
    expect(detectAcceptedBrand('6362970000457013')).toBe('ELO');
    expect(detectAcceptedBrand('5067230000000000')).toBe('ELO');
    expect(detectAcceptedBrand('4011780000000000')).toBe('ELO');
    expect(detectAcceptedBrand('378282246310005')).toBe('AMEX');
  });

  it('recusa Hipercard, Diners, Discover e JCB', () => {
    expect(detectAcceptedBrand('6062825624254001')).toBeNull();
    expect(detectAcceptedBrand('36227206271667')).toBeNull();
    expect(detectAcceptedBrand('6011111111111117')).toBeNull();
    expect(detectAcceptedBrand('3530111333300000')).toBeNull();
  });

  it('luhn e limites de parcelas por bandeira', () => {
    expect(passesLuhn('4444444444444448')).toBe(true);
    expect(passesLuhn('4444444444444441')).toBe(false);
    expect(brandInstallmentLimit('VISA')).toBe(21);
    expect(brandInstallmentLimit('ELO')).toBe(12);
  });

  it('mapeia status Asaas', () => {
    expect(mapAsaasStatus('CONFIRMED')).toBe('paid');
    expect(mapAsaasStatus('AWAITING_RISK_ANALYSIS')).toBe('under_review');
    expect(mapAsaasStatus('OVERDUE')).toBe('failed');
  });

  it('não vaza dados do cartão em logs/payload', () => {
    const redacted = redactSensitiveData({
      creditCard: { number: '4444444444444444', ccv: '123' },
      ccv: '123',
      creditCardToken: 'tok_abcdef123456',
    }) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain('4444444444444444');
    expect(JSON.stringify(redacted)).not.toContain('"123"');
    expect(JSON.stringify(redacted)).not.toContain('tok_abcdef123456');
  });
});

describe('webhook Asaas', () => {
  const app = createApp();

  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'test';
    process.env.ASAAS_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
    resetEnvCache();
    loadEnv();
  });

  beforeEach(() => {
    clearPaymentMemoryStore();
  });

  async function seedCardPayment() {
    const regId = randomUUID();
    seedRegistrationForTest({ id: regId, totalPrice: 100, status: 'pending_payment' });
    const provider = await paymentRepository.findProviderByCode('asaas');
    const payment = await paymentRepository.createPayment({
      registrationId: regId,
      providerId: provider!.id,
      amount: 100,
      feeAmount: 3.59,
      totalAmount: 103.59,
      paymentMethod: 'credit_card',
      status: 'under_review',
    });
    return { regId, payment };
  }

  it('recusa sem token', async () => {
    const res = await request(app).post('/api/v1/webhooks/asaas').send({ id: 'evt_1', event: 'PAYMENT_CONFIRMED' });
    expect(res.status).toBe(401);
  });

  it('confirma pagamento e é idempotente', async () => {
    const { regId, payment } = await seedCardPayment();
    const body = {
      id: 'evt_confirm_1',
      event: 'PAYMENT_CONFIRMED',
      payment: {
        id: 'pay_123',
        status: 'CONFIRMED',
        billingType: 'CREDIT_CARD',
        value: 103.59,
        externalReference: payment.id,
      },
    };

    const first = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', WEBHOOK_TOKEN)
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe('processed');

    const paid = await paymentRepository.findPaymentById(payment.id);
    expect(paid?.status).toBe('paid');
    const reg = await paymentRepository.findRegistrationById(regId);
    expect(reg?.status).toBe('paid');

    const second = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', WEBHOOK_TOKEN)
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('duplicated');
  });

  it('ignora eventos PIX/boleto do Asaas', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', WEBHOOK_TOKEN)
      .send({ id: 'evt_pix', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x', billingType: 'PIX' } });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('ignored');
  });

  it('config pública não expõe chave', async () => {
    const res = await request(app).get('/api/v1/public/card/config');
    expect(res.status).toBe(200);
    expect(res.body.brands).toEqual(['VISA', 'MASTERCARD', 'ELO', 'AMEX']);
    expect(JSON.stringify(res.body)).not.toContain('aact');
  });
});
