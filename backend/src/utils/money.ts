import { AppError } from './app-error.js';

/** Converte reais (number) para centavos (inteiro). */
export function toCents(reais: number): number {
  return Math.round(reais * 100);
}

/** Converte centavos (inteiro) para string no formato Pix "199.90". */
export function centsToPixAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw AppError.badRequest('Valor em centavos inválido', 'INVALID_AMOUNT');
  }
  return (cents / 100).toFixed(2);
}

/** Converte string Pix "199.90" para centavos. */
export function pixAmountToCents(amount: string): number {
  const normalized = amount.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw AppError.badRequest(`Formato de valor Pix inválido: ${amount}`, 'INVALID_PIX_AMOUNT');
  }
  const [intPart, decPart = ''] = normalized.split('.');
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  if (!Number.isFinite(cents) || cents < 0) {
    throw AppError.badRequest(`Valor Pix inválido: ${amount}`, 'INVALID_PIX_AMOUNT');
  }
  return cents;
}

/** Compara dois valores Pix com tolerância zero (centavos exatos). */
export function amountsEqual(a: string, b: string): boolean {
  return pixAmountToCents(a) === pixAmountToCents(b);
}

export function formatBRL(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
    cents / 100,
  );
}
