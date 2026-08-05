import { AppError } from './app-error.js';

/** Remove tudo que não for dígito. */
export function normalizeCpfDigits(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * Valida CPF brasileiro (11 dígitos + dígitos verificadores).
 * Rejeita sequências conhecidas inválidas (000..., 111..., etc.).
 */
export function assertValidCpf(raw: string): string {
  const cpf = normalizeCpfDigits(raw);
  if (cpf.length !== 11) {
    throw AppError.badRequest('CPF deve possuir 11 dígitos', 'INVALID_CPF');
  }
  if (/^(\d)\1{10}$/.test(cpf)) {
    throw AppError.badRequest('CPF inválido', 'INVALID_CPF');
  }

  const calcDigit = (base: string, factor: number): number => {
    let sum = 0;
    for (let i = 0; i < base.length; i += 1) {
      sum += Number(base[i]) * (factor - i);
    }
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };

  const d1 = calcDigit(cpf.slice(0, 9), 10);
  const d2 = calcDigit(cpf.slice(0, 10), 11);
  if (d1 !== Number(cpf[9]) || d2 !== Number(cpf[10])) {
    throw AppError.badRequest('CPF com dígitos verificadores inválidos', 'INVALID_CPF');
  }

  return cpf;
}

/** Máscara visual: ***.***.***-15 (últimos 2 dígitos). */
export function maskCpfDisplay(raw: string): string {
  const digits = normalizeCpfDigits(raw);
  if (digits.length < 2) return '***.***.***-**';
  return `***.***.***-${digits.slice(-2)}`;
}
