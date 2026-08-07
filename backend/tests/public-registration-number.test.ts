import { describe, expect, it } from 'vitest';
import { toPublicRegistrationNumber } from '../src/services/public/public-registration.service.js';

describe('toPublicRegistrationNumber', () => {
  it('preserva códigos INS-* sem parseInt', () => {
    expect(toPublicRegistrationNumber('INS-MSIGU5ZR')).toBe('INS-MSIGU5ZR');
  });

  it('prefixa dígitos vindos da coluna INT', () => {
    expect(toPublicRegistrationNumber(42)).toBe('INS-42');
    expect(toPublicRegistrationNumber('7')).toBe('INS-7');
  });
});
