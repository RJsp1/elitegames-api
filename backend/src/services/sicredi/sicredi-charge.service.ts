import { getSicrediConfig, SICREDI_ENDPOINTS } from '../../config/sicredi.js';
import type { SicrediCobRequest, SicrediCobResponse } from '../../types/sicredi.types.js';
import { AppError } from '../../utils/app-error.js';
import { addSeconds } from '../../utils/date.js';
import { logger } from '../../utils/logger.js';
import { redactSensitiveData } from '../../utils/redact-sensitive-data.js';
import { assertValidCpf } from '../../utils/cpf.js';
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
  }): Promise<ProviderChargeResult> {
    const config = getSicrediConfig();
    const client = createSicrediHttpClient();
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

    if (response.status < 200 || response.status >= 300) {
      logger.error('Falha ao criar cobrança Sicredi', {
        status: response.status,
        body: redactSensitiveData(response.data),
      });
      throw AppError.serviceUnavailable(
        'Falha ao criar cobrança Pix Sicredi',
        'SICREDI_CHARGE_FAILED',
      );
    }

    const data = response.data;
    if (!data.pixCopiaECola) {
      throw AppError.serviceUnavailable(
        'Cobrança Sicredi sem pixCopiaECola',
        'SICREDI_MISSING_PIX',
      );
    }

    const expiresAt = addSeconds(new Date(), data.calendario?.expiracao ?? input.expirationSeconds);

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

  async getCharge(txid: string): Promise<ProviderChargeStatus> {
    const client = createSicrediHttpClient();
    const token = await sicrediAuthService.getAccessToken();

    const response = await client.get<
      SicrediCobResponse & { pix?: Array<{ endToEndId: string; horario: string; valor: string }> }
    >(SICREDI_ENDPOINTS.cobGet(txid), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) {
      throw AppError.notFound('Cobrança Sicredi não encontrada');
    }

    if (response.status < 200 || response.status >= 300) {
      logger.error('Falha ao consultar cobrança Sicredi', { status: response.status });
      throw AppError.serviceUnavailable(
        'Falha ao consultar cobrança Sicredi',
        'SICREDI_GET_FAILED',
      );
    }

    const data = response.data;
    const pix = data.pix?.[0];

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
    };
  }
}

export const sicrediChargeService = new SicrediChargeService();
