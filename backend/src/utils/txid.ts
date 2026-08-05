import { randomBytes } from 'node:crypto';
import { AppError } from './app-error.js';

const TXID_LENGTH = 26;
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Gera txid Pix conforme Bacen/Sicredi:
 * - apenas letras e números
 * - exatamente 26 caracteres
 * - sem CPF, telefone ou dados pessoais
 */
export function generateTxid(prefix = 'EG'): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6);
  const remaining = TXID_LENGTH - safePrefix.length;
  const bytes = randomBytes(remaining);
  let body = '';
  for (let i = 0; i < remaining; i += 1) {
    body += ALPHANUM[bytes[i]! % ALPHANUM.length];
  }
  const txid = `${safePrefix}${body}`;
  assertValidTxid(txid);
  return txid;
}

export function assertValidTxid(txid: string): void {
  if (!/^[a-zA-Z0-9]{26}$/.test(txid)) {
    throw AppError.badRequest(
      'txid deve ter exatamente 26 caracteres alfanuméricos',
      'INVALID_TXID',
    );
  }
}

export function isValidTxid(txid: string): boolean {
  return /^[a-zA-Z0-9]{26}$/.test(txid);
}
