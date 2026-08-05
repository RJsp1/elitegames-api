import { describe, it, expect } from 'vitest';
import { generateTxid, isValidTxid, assertValidTxid } from '../src/utils/txid.js';
import { AppError } from '../src/utils/app-error.js';

describe('txid', () => {
  it('gera txid com 26 caracteres', () => {
    const txid = generateTxid('EG');
    expect(txid).toHaveLength(26);
  });

  it('gera txid apenas alfanumérico', () => {
    for (let i = 0; i < 20; i += 1) {
      const txid = generateTxid('EG');
      expect(txid).toMatch(/^[a-zA-Z0-9]{26}$/);
      expect(isValidTxid(txid)).toBe(true);
    }
  });

  it('rejeita txid inválido', () => {
    expect(() => assertValidTxid('abc')).toThrow(AppError);
    expect(() => assertValidTxid('a'.repeat(26) + '!')).toThrow();
  });
});
