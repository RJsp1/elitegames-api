import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectPixKeyApparentType,
  maskPixKeyDiagnostic,
  sanitizeSicrediWebhookErrorBody,
} from '../src/services/sicredi/sicredi-webhook.service.js';

const FULL_PIX_KEY = '63325362000172';
const CLIENT_SECRET = 'super-secret-client-value';
const ACCESS_TOKEN = 'token-secreto-nao-deve-aparecer-nos-logs';

describe('sanitizeSicrediWebhookErrorBody / maskPixKeyDiagnostic', () => {
  it('detecta tipo aparente da chave Pix', () => {
    expect(detectPixKeyApparentType('52998224725')).toBe('CPF');
    expect(detectPixKeyApparentType('63325362000172')).toBe('CNPJ');
    expect(detectPixKeyApparentType('user@example.com')).toBe('email');
    expect(detectPixKeyApparentType('+5511999999999')).toBe('telefone');
    expect(detectPixKeyApparentType('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('EVP');
  });

  it('mascara chave Pix com 4+2, length e tipo', () => {
    const masked = maskPixKeyDiagnostic(FULL_PIX_KEY);
    expect(masked.masked).toBe('6332…72');
    expect(masked.length).toBe(14);
    expect(masked.type).toBe('CNPJ');
    expect(masked.masked).not.toContain(FULL_PIX_KEY);
  });

  it('extrai somente campos diagnósticos e remove chave Pix do detail', () => {
    const sanitized = sanitizeSicrediWebhookErrorBody(
      403,
      {
        type: 'https://pix.bcb.gov.br/api/v2/error/OperacaoNegada',
        title: 'Operação negada',
        status: 403,
        detail: `Acesso negado para a chave ${FULL_PIX_KEY}`,
        codigo: '403',
        mensagem: `Chave ${FULL_PIX_KEY} sem permissão`,
        message: 'Forbidden',
        violacoes: [{ razao: 'sem permissão', propriedade: 'chave' }],
        access_token: ACCESS_TOKEN,
        client_secret: CLIENT_SECRET,
        authorization: `Bearer ${ACCESS_TOKEN}`,
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      },
      [FULL_PIX_KEY, CLIENT_SECRET, ACCESS_TOKEN],
    );

    expect(sanitized.status).toBe(403);
    expect(sanitized.type).toContain('OperacaoNegada');
    expect(sanitized.title).toBe('Operação negada');
    expect(sanitized.detail).toContain('[REDACTED]');
    expect(sanitized.detail).not.toContain(FULL_PIX_KEY);
    expect(sanitized.codigo).toBe('403');
    expect(sanitized.mensagem).not.toContain(FULL_PIX_KEY);
    expect(sanitized.message).toBe('Forbidden');
    expect(sanitized.violacoes).toBeDefined();

    const json = JSON.stringify(sanitized);
    expect(json).not.toContain(FULL_PIX_KEY);
    expect(json).not.toContain(CLIENT_SECRET);
    expect(json).not.toContain(ACCESS_TOKEN);
    expect(json).not.toContain('authorization');
    expect(json).not.toContain('headers');
    expect(json).not.toContain('access_token');
    expect(json).not.toContain('client_secret');
  });
});

describe('SicrediWebhookService get/register diagnóstico', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadService(mocks: {
    get?: ReturnType<typeof vi.fn>;
    put?: ReturnType<typeof vi.fn>;
  }) {
    vi.resetModules();

    const getMock = mocks.get ?? vi.fn();
    const putMock = mocks.put ?? vi.fn();

    vi.doMock('../src/services/sicredi/sicredi-http-client.js', () => ({
      createSicrediHttpClient: () => ({
        get: getMock,
        put: putMock,
      }),
      loadMtlsMaterial: vi.fn(),
      resetSicrediHttpClient: vi.fn(),
    }));

    vi.doMock('../src/services/sicredi/sicredi-auth.service.js', () => ({
      sicrediAuthService: {
        getAccessToken: async () => ACCESS_TOKEN,
      },
    }));

    vi.doMock('../src/config/sicredi.js', () => ({
      getSicrediConfig: () => ({
        pixKey: FULL_PIX_KEY,
        baseUrl: 'https://api-pix.sicredi.com.br',
        requestTimeoutMs: 15000,
        tokenSafetySeconds: 30,
        privateKeyPath: 'x',
        certificatePath: 'x',
        caChainPath: 'x',
        webhookCertificatePath: 'x',
        webhookUrl: 'https://api.elitegames.example/api/v1/webhooks/sicredi/pix',
        clientId: 'client-id-mock',
        clientSecret: CLIENT_SECRET,
        environment: 'producao',
        chargeExpirationSeconds: 1800,
      }),
      SICREDI_ENDPOINTS: {
        webhook: (pixKey: string) => `/api/v3/webhook/${encodeURIComponent(pixKey)}`,
      },
    }));

    const loggerError = vi.fn();
    vi.doMock('../src/utils/logger.js', () => ({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: loggerError,
      },
    }));

    const mod = await import('../src/services/sicredi/sicredi-webhook.service.js');
    return { service: mod.sicrediWebhookService, getMock, putMock, loggerError };
  }

  it('GET 404 é tratado como null (webhook não cadastrado)', async () => {
    const { service, getMock } = await loadService({
      get: vi.fn().mockResolvedValue({ status: 404, data: { title: 'Not Found' } }),
    });

    await expect(service.getWebhook()).resolves.toBeNull();
    expect(getMock).toHaveBeenCalledOnce();
  });

  it('GET 403 registra corpo sanitizado e lança AppError', async () => {
    const { service, loggerError } = await loadService({
      get: vi.fn().mockResolvedValue({
        status: 403,
        data: {
          type: 'forbidden',
          title: 'Forbidden',
          detail: `Sem permissão para ${FULL_PIX_KEY}`,
          mensagem: 'Operação negada',
        },
      }),
    });

    await expect(service.getWebhook()).rejects.toMatchObject({
      code: 'SICREDI_WEBHOOK_GET_FAILED',
    });

    expect(loggerError).toHaveBeenCalled();
    const meta = loggerError.mock.calls[0]?.[1] as Record<string, unknown>;
    const dumped = JSON.stringify(meta);
    expect(meta.status).toBe(403);
    expect(meta.detail).toBeDefined();
    expect(dumped).not.toContain(FULL_PIX_KEY);
    expect(dumped).not.toContain(ACCESS_TOKEN);
    expect(dumped).not.toContain(CLIENT_SECRET);
    expect(meta.pixKey).toEqual({
      masked: '6332…72',
      length: 14,
      type: 'CNPJ',
    });
  });

  it('PUT 403 registra detail/mensagem sanitizados e lança AppError', async () => {
    const { service, loggerError } = await loadService({
      put: vi.fn().mockResolvedValue({
        status: 403,
        data: {
          type: 'https://pix.bcb.gov.br/api/v2/error/OperacaoNegada',
          title: 'Operação negada',
          detail: 'Webhook write não autorizado para esta chave',
          mensagem: 'Acesso negado',
          code: 'WH_FORBIDDEN',
        },
      }),
    });

    await expect(service.registerWebhook()).rejects.toMatchObject({
      code: 'SICREDI_WEBHOOK_REGISTER_FAILED',
      details: {
        status: 403,
        detail: 'Webhook write não autorizado para esta chave',
        mensagem: 'Acesso negado',
        code: 'WH_FORBIDDEN',
      },
    });

    const meta = loggerError.mock.calls[0]?.[1] as Record<string, unknown>;
    const dumped = JSON.stringify({ meta, details: loggerError.mock.calls });
    expect(meta.status).toBe(403);
    expect(meta.detail).toBe('Webhook write não autorizado para esta chave');
    expect(meta.mensagem).toBe('Acesso negado');
    expect(dumped).not.toContain(FULL_PIX_KEY);
    expect(dumped).not.toContain(ACCESS_TOKEN);
    expect(dumped).not.toContain(CLIENT_SECRET);
  });

  it('GET 200 retorna webhook atual', async () => {
    const payload = {
      webhookUrl: 'https://api.elitegames.example/api/v1/webhooks/sicredi/pix',
      chave: FULL_PIX_KEY,
    };
    const { service } = await loadService({
      get: vi.fn().mockResolvedValue({ status: 200, data: payload }),
    });

    await expect(service.getWebhook()).resolves.toEqual(payload);
  });
});
