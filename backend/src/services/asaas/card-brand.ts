export type AcceptedCardBrand = 'VISA' | 'MASTERCARD' | 'ELO' | 'AMEX';

export const ACCEPTED_CARD_BRANDS: readonly AcceptedCardBrand[] = [
  'VISA',
  'MASTERCARD',
  'ELO',
  'AMEX',
];

// Faixas BIN Elo (6 dígitos); testadas antes de Visa, pois parte delas começa com 4.
const ELO_BIN_RANGES: Array<[number, number]> = [
  [401178, 401179],
  [431274, 431274],
  [438935, 438935],
  [451416, 451416],
  [457393, 457393],
  [457631, 457632],
  [504175, 504175],
  [506699, 506778],
  [509000, 509999],
  [627780, 627780],
  [636297, 636297],
  [636368, 636368],
  [650031, 650033],
  [650035, 650051],
  [650405, 650439],
  [650485, 650538],
  [650541, 650598],
  [650700, 650718],
  [650720, 650727],
  [650901, 650978],
  [651652, 651679],
  [655000, 655019],
  [655021, 655058],
];

function isEloBin(digits: string): boolean {
  if (digits.length < 6) return false;
  const bin = Number(digits.slice(0, 6));
  return ELO_BIN_RANGES.some(([from, to]) => bin >= from && bin <= to);
}

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export function passesLuhn(cardNumber: string): boolean {
  const digits = onlyDigits(cardNumber);
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Bandeira aceita para o número informado, ou null se não for Visa/Master/Elo/Amex. */
export function detectAcceptedBrand(cardNumber: string): AcceptedCardBrand | null {
  const n = onlyDigits(cardNumber);
  if (!n) return null;
  if (isEloBin(n)) return n.length === 16 ? 'ELO' : null;
  if (/^3[47]/.test(n)) return n.length === 15 ? 'AMEX' : null;
  if (/^4/.test(n)) return n.length === 13 || n.length === 16 || n.length === 19 ? 'VISA' : null;
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/.test(n)) {
    return n.length === 16 ? 'MASTERCARD' : null;
  }
  return null;
}

export function expectedCvvLength(brand: AcceptedCardBrand): number {
  return brand === 'AMEX' ? 4 : 3;
}

/** Limite de parcelas suportado pelo Asaas por bandeira. */
export function brandInstallmentLimit(brand: AcceptedCardBrand): number {
  return brand === 'VISA' || brand === 'MASTERCARD' ? 21 : 12;
}

export function isCardExpired(month: number, year: number, reference = new Date()): boolean {
  const fullYear = year < 100 ? 2000 + year : year;
  const refYear = reference.getFullYear();
  const refMonth = reference.getMonth() + 1;
  return fullYear < refYear || (fullYear === refYear && month < refMonth);
}
