import type { CardFeeTier } from '../../config/asaas.js';

export interface CardPricingConfig {
  feeFixed: number;
  feeTiers: CardFeeTier[];
  maxInstallments: number;
  minInstallmentValue: number;
}

export interface CardQuote {
  installments: number;
  netAmount: number;
  feePercent: number;
  feeFixed: number;
  feeAmount: number;
  totalAmount: number;
  installmentValue: number;
}

const toCents = (value: number): number => Math.round(value * 100);
const fromCents = (cents: number): number => Number((cents / 100).toFixed(2));

export function feePercentFor(installments: number, tiers: CardFeeTier[]): number {
  const tier = tiers.find((t) => installments >= t.from && installments <= t.to);
  if (!tier) throw new Error(`Sem faixa de taxa para ${installments} parcela(s)`);
  return tier.percent;
}

/**
 * Valor bruto cobrado do cliente para que, após a taxa do Asaas
 * (percentual sobre o bruto + fixo por transação), o líquido seja o preço da inscrição.
 * bruto = (líquido + fixo) / (1 − percentual), arredondado para cima no centavo.
 */
export function quoteCard(
  netAmount: number,
  installments: number,
  config: Pick<CardPricingConfig, 'feeFixed' | 'feeTiers'>,
): CardQuote {
  const percent = feePercentFor(installments, config.feeTiers);
  const netCents = toCents(netAmount);
  const fixedCents = toCents(config.feeFixed);
  const totalCents = Math.ceil((netCents + fixedCents) / (1 - percent / 100) - 1e-9);
  return {
    installments,
    netAmount: fromCents(netCents),
    feePercent: percent,
    feeFixed: fromCents(fixedCents),
    feeAmount: fromCents(totalCents - netCents),
    totalAmount: fromCents(totalCents),
    installmentValue: fromCents(Math.ceil(totalCents / installments)),
  };
}

export function maxInstallmentsFor(netAmount: number, config: CardPricingConfig, brandLimit = 21): number {
  let max = 1;
  const cap = Math.min(config.maxInstallments, brandLimit);
  for (let n = 2; n <= cap; n += 1) {
    const q = quoteCard(netAmount, n, config);
    if (q.totalAmount / n < config.minInstallmentValue) break;
    max = n;
  }
  return max;
}

export function listInstallmentOptions(netAmount: number, config: CardPricingConfig): CardQuote[] {
  const max = maxInstallmentsFor(netAmount, config);
  return Array.from({ length: max }, (_, i) => quoteCard(netAmount, i + 1, config));
}
