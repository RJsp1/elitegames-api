/**
 * Thin adapter — eventos financeiros passam pelo PaymentRepository (schema real).
 */
import { paymentRepository } from './payment.repository.js';

export function clearPaymentEventMemoryStore(): void {
  // Limpeza completa fica em clearPaymentMemoryStore();
}

export const paymentEventRepository = {
  async list(limit = 50) {
    return paymentRepository.listPaymentEvents(limit);
  },
  async findById(id: string) {
    return paymentRepository.findPaymentEventById(id);
  },
  async markProcessed(id: string) {
    return paymentRepository.markPaymentEventProcessed(id);
  },
};

export { paymentRepository };
