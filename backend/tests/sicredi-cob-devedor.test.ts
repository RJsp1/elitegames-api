import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildSicrediCobBody } from '../src/services/sicredi/sicredi-charge.service.js';
import { assertValidCpf } from '../src/utils/cpf.js';
import {
  clearPaymentMemoryStore,
  seedRegistrationForTest,
  seedAthleteForTest,
  seedRegistrationAthleteForTest,
} from '../src/repositories/payment.repository.js';
import { paymentService } from '../src/services/payment/payment.service.js';
import { resetEnvCache, loadEnv } from '../src/config/env.js';
import { resetPaymentProviderCache } from '../src/services/payment/payment-provider.factory.js';
import { clearMockPixStore } from '../src/services/mock/mock-pix.provider.js';

/** CPF válido com dígitos verificadores corretos. */
const VALID_CPF = '52998224725';

describe('Sicredi cob payload — devedor', () => {
  it('buildSicrediCobBody inclui body.devedor.cpf e body.devedor.nome', () => {
    const body = buildSicrediCobBody({
      txid: 'EG123456789012345678901234',
      amountOriginal: '199.90',
      expirationSeconds: 1800,
      debtorName: 'Atleta Elite',
      debtorCpf: VALID_CPF,
      registrationNumber: 'INS-001',
      categoryName: 'individual',
      pixKey: '63325362000172',
    });

    expect(body.devedor).toBeDefined();
    expect(body.devedor?.cpf).toBe(VALID_CPF);
    expect(body.devedor?.nome).toBe('Atleta Elite');
    expect(body.devedor?.cpf).toHaveLength(11);
  });

  it('não remove devedor após JSON.stringify/parse (serialização)', () => {
    const body = buildSicrediCobBody({
      txid: 'EGABCDEFGHIJKLMNOPQRSTUVWX',
      amountOriginal: '199.90',
      expirationSeconds: 1800,
      debtorName: 'Nome Completo',
      debtorCpf: VALID_CPF,
      registrationNumber: 'INS-002',
      pixKey: 'chave-pix',
    });

    const roundTrip = JSON.parse(JSON.stringify(body));
    expect(roundTrip.devedor.cpf).toBe(VALID_CPF);
    expect(roundTrip.devedor.nome).toBe('Nome Completo');
  });

  it('rejeita CPF inválido', () => {
    expect(() => assertValidCpf('11111111111')).toThrow();
    expect(() =>
      buildSicrediCobBody({
        txid: 'EGABCDEFGHIJKLMNOPQRSTUVWX',
        amountOriginal: '199.90',
        expirationSeconds: 1800,
        debtorName: 'X',
        debtorCpf: '123',
        registrationNumber: 'INS',
        pixKey: 'k',
      }),
    ).toThrow();
  });
});

describe('Sicredi charge Axios body inclui devedor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('intercepta put do Axios e confirma body.devedor', async () => {
    vi.resetModules();

    const putMock = vi.fn().mockResolvedValue({
      status: 201,
      data: {
        txid: 'EGABCDEFGHIJKLMNOPQRSTUVWX',
        status: 'ATIVA',
        calendario: { criacao: new Date().toISOString(), expiracao: 1800 },
        valor: { original: '199.90' },
        chave: 'chave',
        pixCopiaECola: '00020126MOCKPIXCOPIACOLAABCDEFGHIJKLMNOP',
      },
    });

    vi.doMock('../src/services/sicredi/sicredi-http-client.js', () => ({
      createSicrediHttpClient: () => ({
        put: putMock,
        get: vi.fn(),
      }),
      loadMtlsMaterial: vi.fn(),
      resetSicrediHttpClient: vi.fn(),
    }));

    vi.doMock('../src/services/sicredi/sicredi-auth.service.js', () => ({
      sicrediAuthService: {
        getAccessToken: async () => 'token-mock-nao-imprimir',
      },
    }));

    vi.doMock('../src/config/sicredi.js', () => ({
      getSicrediConfig: () => ({
        pixKey: '63325362000172',
        baseUrl: 'https://api-pix.sicredi.com.br',
        requestTimeoutMs: 15000,
        tokenSafetySeconds: 30,
        privateKeyPath: 'x',
        certificatePath: 'x',
        caChainPath: 'x',
        webhookCertificatePath: 'x',
        webhookUrl: '',
        clientId: 'id',
        clientSecret: 'secret',
        environment: 'producao',
        chargeExpirationSeconds: 1800,
      }),
      SICREDI_ENDPOINTS: {
        cobPut: (txid: string) => `/api/v3/cob/${txid}`,
        cobGet: (txid: string) => `/api/v3/cob/${txid}`,
        token: '/oauth/token',
      },
    }));

    const { sicrediChargeService } = await import(
      '../src/services/sicredi/sicredi-charge.service.js'
    );

    await sicrediChargeService.createImmediateCharge({
      txid: 'EGABCDEFGHIJKLMNOPQRSTUVWX',
      amountOriginal: '199.90',
      expirationSeconds: 1800,
      debtorName: 'Atleta Axios',
      debtorCpf: VALID_CPF,
      registrationNumber: 'INS-AX',
      categoryName: 'individual',
    });

    expect(putMock).toHaveBeenCalled();
    const [, body] = putMock.mock.calls[0]!;
    expect(body.devedor).toBeDefined();
    expect(body.devedor.cpf).toBe(VALID_CPF);
    expect(body.devedor.nome).toBe('Atleta Axios');
  });
});

describe('createPayment individual com athlete_a envia devedor', () => {
  beforeEach(() => {
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.NODE_ENV = 'test';
    resetEnvCache();
    loadEnv();
    clearPaymentMemoryStore();
    clearMockPixStore();
    resetPaymentProviderCache();
  });

  it('inscrição individual + athlete_a + CPF válido cria cobrança com pagador', async () => {
    const regId = randomUUID();
    const athleteId = randomUUID();

    seedRegistrationForTest({
      id: regId,
      totalPrice: 199.9,
      status: 'draft',
      format: 'individual',
      registrationNumber: 'INS-ATH',
    });
    seedAthleteForTest({
      id: athleteId,
      fullName: 'Atleta Principal',
      cpf: VALID_CPF,
    });
    seedRegistrationAthleteForTest({
      id: randomUUID(),
      registrationId: regId,
      athleteId,
      role: 'athlete_a',
    });

    const result = await paymentService.createPayment({ registrationId: regId });
    expect(result.status).toBe('active');
    expect(result.amount).toBe('199.90');

    const debtor = await paymentService.resolveDebtorForRegistration(regId);
    expect(debtor.fullName).toBe('Atleta Principal');
    expect(debtor.cpfDigits).toBe(VALID_CPF);

    const body = buildSicrediCobBody({
      txid: result.txid!,
      amountOriginal: result.amount,
      expirationSeconds: 1800,
      debtorName: debtor.fullName,
      debtorCpf: debtor.cpfDigits,
      registrationNumber: 'INS-ATH',
      categoryName: 'individual',
      pixKey: '63325362000172',
    });
    expect(body.devedor?.cpf).toBe(VALID_CPF);
    expect(body.devedor?.nome).toBe('Atleta Principal');
  });

  it('sem vínculo de atleta lança ATHLETE_NOT_LINKED', async () => {
    const regId = randomUUID();
    seedRegistrationForTest({
      id: regId,
      totalPrice: 199.9,
      status: 'draft',
      format: 'individual',
    });

    await expect(paymentService.createPayment({ registrationId: regId })).rejects.toMatchObject({
      code: 'ATHLETE_NOT_LINKED',
    });
  });
});
