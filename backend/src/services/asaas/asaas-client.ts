import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { getAsaasConfig } from '../../config/asaas.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';

export interface AsaasCustomerInput {
  name: string;
  cpfCnpj: string;
  email?: string | null;
  mobilePhone?: string | null;
  postalCode?: string | null;
  addressNumber?: string | null;
  externalReference?: string | null;
}

export interface AsaasCreditCard {
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
}

export interface AsaasCreditCardHolderInfo {
  name: string;
  email: string;
  cpfCnpj: string;
  postalCode: string;
  addressNumber: string;
  addressComplement?: string | null;
  phone: string;
  mobilePhone?: string | null;
}

export interface AsaasCardChargeInput {
  customer: string;
  value: number;
  installmentCount: number;
  dueDate: string;
  description: string;
  externalReference: string;
  creditCard: AsaasCreditCard;
  creditCardHolderInfo: AsaasCreditCardHolderInfo;
  remoteIp: string;
}

export interface AsaasPayment {
  id: string;
  status: string;
  value: number;
  netValue?: number;
  billingType?: string;
  externalReference?: string | null;
  installment?: string | null;
  installmentNumber?: number | null;
  confirmedDate?: string | null;
  paymentDate?: string | null;
  invoiceUrl?: string | null;
  transactionReceiptUrl?: string | null;
  creditCard?: {
    creditCardNumber?: string;
    creditCardBrand?: string;
    creditCardToken?: string;
  } | null;
}

/** Recusa do cartão (HTTP 400 do Asaas): a cobrança não é persistida no Asaas. */
export class AsaasDeclinedError extends Error {
  constructor(
    message: string,
    public readonly asaasCode: string | null,
  ) {
    super(message);
    this.name = 'AsaasDeclinedError';
  }
}

/** Falha de rede/timeout/5xx: o resultado da cobrança é desconhecido. */
export class AsaasUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsaasUnavailableError';
  }
}

interface AsaasErrorBody {
  errors?: Array<{ code?: string; description?: string }>;
}

let cachedClient: AxiosInstance | null = null;
let cachedKey = '';

function getClient(): AxiosInstance {
  const config = getAsaasConfig();
  if (!config.enabled) {
    throw AppError.serviceUnavailable(
      'Pagamento com cartão indisponível no momento.',
      'CARD_PAYMENTS_DISABLED',
    );
  }
  if (cachedClient && cachedKey === config.apiKey) return cachedClient;

  cachedClient = axios.create({
    baseURL: config.baseUrl,
    timeout: config.requestTimeoutMs,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'elitegames-api',
      access_token: config.apiKey,
    },
    validateStatus: () => true,
  });
  cachedKey = config.apiKey;
  return cachedClient;
}

function firstError(data: unknown): { code: string | null; description: string | null } {
  const body = (data ?? {}) as AsaasErrorBody;
  const err = Array.isArray(body.errors) ? body.errors[0] : undefined;
  return { code: err?.code ?? null, description: err?.description ?? null };
}

async function send<T>(
  operation: string,
  run: (client: AxiosInstance) => Promise<AxiosResponse<T>>,
): Promise<AxiosResponse<T>> {
  const client = getClient();
  try {
    return await run(client);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    logger.error('Falha de comunicação com Asaas', { operation, code });
    throw new AsaasUnavailableError(
      code === 'ECONNABORTED' || code === 'ETIMEDOUT' ? 'Timeout na API Asaas' : 'Falha na API Asaas',
    );
  }
}

function assertOk(operation: string, response: AxiosResponse<unknown>): void {
  if (response.status >= 200 && response.status < 300) return;
  const { code, description } = firstError(response.data);
  logger.warn('Asaas respondeu com erro', { operation, status: response.status, code, description });
  if (response.status >= 500 || response.status === 429) {
    throw new AsaasUnavailableError(`Asaas indisponível (${response.status})`);
  }
  if (response.status === 401 || response.status === 403) {
    throw AppError.serviceUnavailable(
      'Pagamento com cartão indisponível no momento.',
      'ASAAS_AUTH_FAILED',
    );
  }
  throw new AppError(description ?? 'Dados inválidos para o Asaas', 422, 'ASAAS_VALIDATION', {
    asaasCode: code,
  });
}

export const asaasClient = {
  async findOrCreateCustomer(input: AsaasCustomerInput): Promise<string> {
    const found = await send('customer_find', (c) =>
      c.get<{ data?: Array<{ id: string; deleted?: boolean }> }>('/customers', {
        params: { cpfCnpj: input.cpfCnpj, limit: 1 },
      }),
    );
    assertOk('customer_find', found);
    const existing = found.data.data?.find((cust) => !cust.deleted);
    if (existing) return existing.id;

    const created = await send('customer_create', (c) =>
      c.post<{ id: string }>('/customers', {
        name: input.name,
        cpfCnpj: input.cpfCnpj,
        email: input.email ?? undefined,
        mobilePhone: input.mobilePhone ?? undefined,
        postalCode: input.postalCode ?? undefined,
        addressNumber: input.addressNumber ?? undefined,
        externalReference: input.externalReference ?? undefined,
        // Asaas cobra por notificações (e-mail/SMS) enviadas ao cliente.
        notificationDisabled: true,
      }),
    );
    assertOk('customer_create', created);
    return created.data.id;
  },

  async createCardPayment(input: AsaasCardChargeInput): Promise<AsaasPayment> {
    const body: Record<string, unknown> = {
      customer: input.customer,
      billingType: 'CREDIT_CARD',
      dueDate: input.dueDate,
      description: input.description,
      externalReference: input.externalReference,
      creditCard: input.creditCard,
      creditCardHolderInfo: input.creditCardHolderInfo,
      remoteIp: input.remoteIp,
    };
    if (input.installmentCount > 1) {
      body.installmentCount = input.installmentCount;
      body.totalValue = input.value;
    } else {
      body.value = input.value;
    }

    const response = await send('card_payment_create', (c) =>
      c.post<AsaasPayment>('/payments', body),
    );
    if (response.status === 400) {
      const { code, description } = firstError(response.data);
      logger.warn('Cartão recusado pelo Asaas', { code, description });
      throw new AsaasDeclinedError(
        description ?? 'Transação não autorizada. Verifique os dados do cartão.',
        code,
      );
    }
    assertOk('card_payment_create', response);
    return response.data;
  },

  /** Busca cobranças pela referência externa (id do payment local) — usado após timeout. */
  async findPaymentsByExternalReference(externalReference: string): Promise<AsaasPayment[]> {
    const response = await send('payment_find', (c) =>
      c.get<{ data?: AsaasPayment[] }>('/payments', {
        params: { externalReference, limit: 20 },
      }),
    );
    assertOk('payment_find', response);
    return response.data.data ?? [];
  },
};
