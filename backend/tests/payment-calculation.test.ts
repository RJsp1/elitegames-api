import { describe, it, expect } from 'vitest';
import {
  PaymentCalculationService,
  DEFAULT_PRICE_PER_PARTICIPANT_CENTS,
} from '../src/services/payment/payment-calculation.service.js';
import { AppError } from '../src/utils/app-error.js';

describe('payment calculation', () => {
  const service = new PaymentCalculationService();

  it('calcula individual R$ 199,90', () => {
    const result = service.calculate({ registrationType: 'individual' });
    expect(result.participantCount).toBe(1);
    expect(result.amountCents).toBe(DEFAULT_PRICE_PER_PARTICIPANT_CENTS);
    expect(result.amountOriginal).toBe('199.90');
  });

  it('calcula dupla R$ 399,80', () => {
    const result = service.calculate({ registrationType: 'dupla' });
    expect(result.participantCount).toBe(2);
    expect(result.amountCents).toBe(39980);
    expect(result.amountOriginal).toBe('399.80');
  });

  it('rejeita valor divergente do frontend', () => {
    expect(() =>
      service.calculate({
        registrationType: 'individual',
        clientAmountCents: 100,
      }),
    ).toThrow(AppError);

    try {
      service.calculate({
        registrationType: 'individual',
        clientAmountCents: 100,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('CLIENT_AMOUNT_MISMATCH');
    }
  });

  it('aceita clientAmountCents quando igual ao servidor', () => {
    const result = service.calculate({
      registrationType: 'individual',
      clientAmountCents: 19990,
    });
    expect(result.amountCents).toBe(19990);
  });
});
