import type { PaymentStatusV2 } from '../../types/payment.types.js';

/**
 * Mapeia status Sicredi/Bacen para payment_status_v2.
 */
export function mapSicrediStatus(status: string): PaymentStatusV2 {
  const normalized = status.trim().toUpperCase();

  switch (normalized) {
    case 'ATIVA':
    case 'ACTIVE':
      return 'active';
    case 'CONCLUIDA':
    case 'CONCLUIDA_PIX':
    case 'PAID':
      return 'paid';
    case 'REMOVIDA_PELO_USUARIO_RECEBEDOR':
    case 'REMOVIDA_PELO_PSP':
    case 'CANCELLED':
    case 'CANCELED':
      return 'cancelled';
    case 'EXPIRED':
    case 'EXPIRADA':
      return 'expired';
    case 'PENDING':
    case 'CRIADA':
    case 'DRAFT':
      return 'pending';
    default:
      return 'pending';
  }
}

export function isTerminalStatus(status: PaymentStatusV2): boolean {
  return (
    status === 'paid' ||
    status === 'expired' ||
    status === 'cancelled' ||
    status === 'refunded' ||
    status === 'failed'
  );
}
