import { AppError } from '../../utils/app-error.js';
import { centsToPixAmount } from '../../utils/money.js';

export type RegistrationType = 'individual' | 'dupla';

/** Preços iniciais — preparados para vir do Supabase futuramente. */
export const DEFAULT_PRICE_PER_PARTICIPANT_CENTS = 19990; // R$ 199,90

export interface PriceConfig {
  pricePerParticipantCents: number;
}

export interface CalculationResult {
  amountCents: number;
  amountOriginal: string;
  participantCount: number;
  pricePerParticipantCents: number;
}

export class PaymentCalculationService {
  constructor(
    private readonly config: PriceConfig = {
      pricePerParticipantCents: DEFAULT_PRICE_PER_PARTICIPANT_CENTS,
    },
  ) {}

  resolveParticipantCount(
    registrationType: RegistrationType,
    participantCount?: number,
  ): number {
    if (participantCount !== undefined) {
      if (registrationType === 'individual' && participantCount !== 1) {
        throw AppError.badRequest(
          'Inscrição individual deve ter 1 participante',
          'INVALID_PARTICIPANT_COUNT',
        );
      }
      if (registrationType === 'dupla' && participantCount !== 2) {
        throw AppError.badRequest(
          'Inscrição em dupla deve ter 2 participantes',
          'INVALID_PARTICIPANT_COUNT',
        );
      }
      return participantCount;
    }
    return registrationType === 'dupla' ? 2 : 1;
  }

  calculate(input: {
    registrationType: RegistrationType;
    participantCount?: number;
    clientAmountCents?: number;
  }): CalculationResult {
    const participantCount = this.resolveParticipantCount(
      input.registrationType,
      input.participantCount,
    );
    const amountCents = participantCount * this.config.pricePerParticipantCents;

    if (
      input.clientAmountCents !== undefined &&
      input.clientAmountCents !== amountCents
    ) {
      throw AppError.badRequest(
        'Valor enviado pelo frontend diverge do cálculo do servidor',
        'CLIENT_AMOUNT_MISMATCH',
        {
          serverAmountCents: amountCents,
          clientAmountCents: input.clientAmountCents,
        },
      );
    }

    return {
      amountCents,
      amountOriginal: centsToPixAmount(amountCents),
      participantCount,
      pricePerParticipantCents: this.config.pricePerParticipantCents,
    };
  }
}

export const paymentCalculationService = new PaymentCalculationService();
