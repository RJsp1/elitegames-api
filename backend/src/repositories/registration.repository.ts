/**
 * Adapter legado — registrations agora via PaymentRepository (schema Lovable/Supabase).
 */
import { paymentRepository } from './payment.repository.js';

export function clearRegistrationMemoryStore(): void {
  // Limpeza completa em clearPaymentMemoryStore().
}

export const registrationRepository = {
  findById: (id: string) => paymentRepository.findRegistrationById(id),
  confirmByPaymentId: async (paymentId: string) => {
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment?.registrationId) return null;
    return paymentRepository.confirmRegistration(payment.registrationId);
  },
};
