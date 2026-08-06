import { getSicrediConfig, SICREDI_ENDPOINTS } from '../../config/sicredi.js';
import type { SicrediCobRequest, SicrediCobResponse } from '../../types/sicredi.types.js';
import { AppError } from '../../utils/app-error.js';
import { addSeconds } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import { redactSensitiveData, maskTxid } from '../../utils/redact-sensitive-data.js';
import { assertValidCpf } from '../../utils/cpf.js';
import {
  classifyPixError,
  extractSicrediCorrelationId,
  measureDurationMs,
  paymentCorrelationId,
  pixLog,
} from '../../utils/observability.js';
import { createSicrediHttpClient } from './sicredi-http-client.js';
import { sicrediAuthService } from './sicredi-auth.service.js';
import { mapSicrediStatus } from '../payment/payment-status.mapper.js';
import type { ProviderChargeResult, ProviderChargeStatus } from '../../types/payment.types.js';

export interface BuildSicrediCobInput {
  txid: string;
  amountOriginal: string;
  expirationSeconds: number;
  debtorName: string;
  debtorCpf: string;
  registrationNumber: string;
  categoryName?: string;
  solicitacaoPagador?: string;
  pixKey: string;
}

/**
 * Monta o body exato enviado em PUT /api/v3/cob/{txid}.
 * Sempre inclui devedor.cpf (11 dígitos) e devedor.nome.
 */
export function buildSicrediCobBody(input: BuildSicrediCobInput): SicrediCobRequest {
  const fullName = input.debtorName?.trim();
  if (!fullName) {
    throw AppError.badRequest('Nome do pagador (devedor.nome) é obrigatório', 'DEBTOR_NAME_REQUIRED');
  }

  const cpf = assertValidCpf(input.debtorCpf);

  const body: SicrediCobRequest = {
    calendario: { expiracao: input.expirationSeconds },
    devedor: {
      cpf,
      nome: fullName,
    },
    valor: { original: input.amountOriginal },
    chave: input.pixKey,
    solicitacaoPagador: input.solicitacaoPagador ?? 'Inscrição Elite Games 2026',
    infoAdicionais: [
      { nome: 'Inscrição', valor: input.registrationNumber },
      { nome: 'Categoria', valor: input.categoryName ?? 'inscricao' },
    ],
  };

  // Garantia explícita: serialização JSON preserva devedor
  const serialized = JSON.parse(JSON.stringify(body)) as SicrediCobRequest;
  if (!serialized.devedor?.cpf || !serialized.devedor?.nome) {
    throw AppError.internal('Payload Sicredi perdeu o campo devedor na serialização');
  }

  return serialized;
}

export function logSicrediCobPayloadSafety(body: SicrediCobRequest): void {
  const cpf = body.devedor?.cpf ?? '';
  logger.info('Payload Sicredi cob (checagem segura)', {
    possuiDevedor: Boolean(body.devedor),
    tipoDocumento: body.devedor?.cpf ? 'CPF' : body.devedor?.cnpj ? 'CNPJ' : 'AUSENTE',
    cpfCom11Digitos: cpf.length === 11,
    nomePreenchido: Boolean(body.devedor?.nome?.trim()),
  });
}

export class SicrediChargeService {
  async createImmediateCharge(input: {
    txid: string;
    amountOriginal: string;
    expirationSeconds: number;
    debtorName: string;
    debtorCpf: string;
    registrationNumber: string;
    categoryName?: string;
    solicitacaoPagador?: string;
    correlationId?: string;
    paymentId?: string;
    registrationId?: string;
  }): Promise<ProviderChargeResult> {
    const config = getSicrediConfig();
    const client = createSicrediHttpClient();
    const startedAt = Date.now();
    const attempt = 1;
    const correlationId = input.correlationId ?? input.paymentId ?? undefined;

    const token = await sicrediAuthService.getAccessToken();

    const body = buildSicrediCobBody({
      ...input,
      pixKey: config.pixKey,
    });

    logSicrediCobPayloadSafety(body);
    console.log('Payload possui devedor: SIM');
    console.log('Tipo de documento: CPF');
    console.log(`CPF com 11 dígitos: ${body.devedor?.cpf?.length === 11 ? 'SIM' : 'NÃO'}`);
    console.log(`Nome preenchido: ${body.devedor?.nome?.trim() ? 'SIM' : 'NÃO'}`);

    const response = await client.put<SicrediCobResponse>(
      SICREDI_ENDPOINTS.cobPut(input.txid),
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    const durationMs = measureDurationMs(startedAt);
    const sicrediCorrelationId = extractSicrediCorrelationId(response.headers);

    if (response.status < 200 || response.status >= 300) {
      const errorCode = classifyPixError(null, {
        httpStatus: response.status,
        operation: 'sicredi_charge_create',
      });
      pixLog('error', 'Falha ao criar cobrança Sicredi', {
        correlationId,
        paymentId: input.paymentId,
        registrationId: input.registrationId,
        txid: input.txid,
        provider: 'sicredi',
        operation: 'sicredi_charge_create',
        attempt,
        httpStatus: response.status,
        durationMs,
        errorCode,
        endpoint: 'api/v3/cob/{txid}',
        sicrediCorrelationId,
      });
      throw AppError.serviceUnavailable(
        'Falha ao criar cobrança Pix Sicredi',
        'SICREDI_CHARGE_FAILED',
      );
    }

    const data = response.data;
    if (!data.pixCopiaECola) {
      pixLog('error', 'Cobrança Sicredi sem pixCopiaECola', {
        correlationId,
        paymentId: input.paymentId,
        txid: input.txid,
        provider: 'sicredi',
        operation: 'sicredi_charge_create',
        attempt,
        durationMs,
        errorCode: 'sicredi_invalid_response',
        endpoint: 'api/v3/cob/{txid}',
      });
      throw AppError.serviceUnavailable(
        'Cobrança Sicredi sem pixCopiaECola',
        'SICREDI_MISSING_PIX',
      );
    }

    const expiresAt = addSeconds(new Date(), data.calendario?.expiracao ?? input.expirationSeconds);

    pixLog('info', 'Cobrança Sicredi criada', {
      correlationId,
      paymentId: input.paymentId,
      registrationId: input.registrationId,
      txid: data.txid || input.txid,
      provider: 'sicredi',
      operation: 'sicredi_charge_create',
      statusRemote: data.status,
      attempt,
      durationMs,
      httpStatus: response.status,
      endpoint: 'api/v3/cob/{txid}',
      sicrediCorrelationId,
    });

    return {
      txid: data.txid || input.txid,
      status: mapSicrediStatus(data.status),
      pixCopiaECola: data.pixCopiaECola,
      amountOriginal: data.valor.original,
      expiresAt: expiresAt.toISOString(),
      location: data.location ?? data.loc?.location,
      rawRequest: redactSensitiveData(body),
      raw: redactSensitiveData(data),
    };
  }

  async getCharge(
    txid: string,
    opts?: {
      correlationId?: string;
      paymentId?: string;
      attempt?: number;
    },
  ): Promise<ProviderChargeStatus & { queryDurationMs?: number }> {
    const client = createSicrediHttpClient();
    const startedAt = Date.now();
    const attempt = opts?.attempt ?? 1;
    const correlationId =
      opts?.correlationId ?? (opts?.paymentId ? paymentCorrelationId(opts.paymentId) : undefined);

    const token = await sicrediAuthService.getAccessToken();

    const response = await client.get<
      SicrediCobResponse & { pix?: Array<{ endToEndId: string; horario: string; valor: string }> }
    >(SICREDI_ENDPOINTS.cobGet(txid), {
      headers: { Authorization: `Bearer ${token}` },
    });

    const durationMs = measureDurationMs(startedAt);
    const sicrediCorrelationId = extractSicrediCorrelationId(response.headers);

    if (response.status === 404) {
      pixLog('warn', 'Cobrança Sicredi não encontrada', {
        correlationId,
        paymentId: opts?.paymentId,
        txid,
        provider: 'sicredi',
        operation: 'sicredi_charge_get',
        attempt,
        httpStatus: 404,
        durationMs,
        errorCode: 'sicredi_http_error',
        endpoint: 'api/v3/cob/{txid}',
      });
      throw AppError.notFound('Cobrança Sicredi não encontrada');
    }

    if (response.status < 200 || response.status >= 300) {
      const errorCode = classifyPixError(null, {
        httpStatus: response.status,
        operation: 'sicredi_charge_get',
      });
      pixLog('error', 'Falha ao consultar cobrança Sicredi', {
        correlationId,
        paymentId: opts?.paymentId,
        txid,
        provider: 'sicredi',
        operation: 'sicredi_charge_get',
        attempt,
        httpStatus: response.status,
        durationMs,
        errorCode,
        endpoint: 'api/v3/cob/{txid}',
        sicrediCorrelationId,
      });
      throw AppError.serviceUnavailable(
        'Falha ao consultar cobrança Sicredi',
        'SICREDI_GET_FAILED',
      );
    }

    const data = response.data;
    const pix = data.pix?.[0];

    pixLog('debug', 'Consulta cobrança Sicredi', {
      correlationId,
      paymentId: opts?.paymentId,
      txid: data.txid || txid,
      provider: 'sicredi',
      operation: 'sicredi_charge_get',
      statusRemote: data.status,
      attempt,
      durationMs,
      httpStatus: response.status,
      endpoint: 'api/v3/cob/{txid}',
      sicrediCorrelationId,
      txidMasked: maskTxid(data.txid || txid),
    });

    return {
      txid: data.txid || txid,
      status: mapSicrediStatus(data.status),
      sicrediStatus: data.status,
      pixCopiaECola: data.pixCopiaECola,
      amountOriginal: data.valor.original,
      receivedAmount: pix?.valor ?? data.valor.original,
      endToEndId: pix?.endToEndId,
      paidAt: pix?.horario,
      raw: redactSensitiveData(data),
      queryDurationMs: durationMs,
    };
  }
}

export const sicrediChargeService = new SicrediChargeService();
