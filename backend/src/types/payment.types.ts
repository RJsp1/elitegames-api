export type PaymentStatusV2 =
  | 'draft'
  | 'pending'
  | 'active'
  | 'paid'
  | 'expired'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded'
  | 'failed'
  | 'under_review';

/** @deprecated Use PaymentStatusV2 — mantido para compatibilidade de imports legados. */
export type PaymentStatus = PaymentStatusV2;

export type PaymentProviderName = 'mock' | 'sicredi';

export type RegistrationStatus =
  | 'draft'
  | 'pending_payment'
  | 'paid'
  | 'confirmed'
  | 'cancelled'
  | 'refunded'
  | 'waitlist';

export type ReservationStatus =
  | 'active'
  | 'confirmed'
  | 'expired'
  | 'released'
  | 'cancelled';

export interface AthleteRecord {
  id: string;
  fullName: string;
  cpf: string;
  email: string | null;
  phone: string | null;
  birthDate: string | null;
  gender: string | null;
  shirtSize: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  medicalRestrictions: string | null;
}

export interface GuardianRecord {
  id: string;
  athleteId: string;
  fullName: string;
  cpf: string;
  phone: string;
  email: string | null;
  relationship: string;
}

export interface TeamRecord {
  id: string;
  eventId: string;
  categoryId: string;
  name: string;
  isPublic: boolean;
}

export interface WaiverRecord {
  id: string;
  registrationId: string;
  athleteId: string | null;
  regulationAccepted: boolean;
  lgpdAccepted: boolean;
  imageUseAccepted: boolean;
  fitnessDeclarationAccepted: boolean;
  signatureUrl: string | null;
  signedAt: string | null;
}

export interface RegistrationAthleteLink {
  id: string;
  registrationId: string;
  athleteId: string;
  role: string | null;
}

export interface PaymentProviderRecord {
  id: string;
  name: string;
  code: string;
  environment: string | null;
  isActive: boolean;
  isDefault: boolean;
  supportsDynamicCharge: boolean;
  supportsWebhook: boolean;
  defaultExpirationSeconds: number | null;
}

export interface RegistrationRecord {
  id: string;
  eventId: string | null;
  categoryId: string | null;
  teamId: string | null;
  registrationNumber: string;
  format: string | null;
  totalPrice: number;
  status: RegistrationStatus;
  reservationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRecord {
  id: string;
  registrationId: string | null;
  teamId: string | null;
  athleteId: string | null;
  providerId: string;
  amount: number;
  discountAmount: number;
  feeAmount: number;
  totalAmount: number;
  currency: string;
  paymentMethod: string;
  status: PaymentStatusV2;
  externalReference: string | null;
  providerChargeId: string | null;
  txid: string | null;
  endToEndId: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  pricingSnapshot: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentChargeRecord {
  id: string;
  paymentId: string;
  providerId: string;
  txid: string;
  providerChargeId: string | null;
  pixCopyPaste: string | null;
  qrCodeData: string | null;
  qrCodeImageUrl: string | null;
  amount: number;
  status: PaymentStatusV2;
  expiresAt: string | null;
  rawRequest: Record<string, unknown> | null;
  rawResponse: Record<string, unknown> | null;
  isCurrent: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentEventRecord {
  id: string;
  paymentId: string | null;
  providerId: string | null;
  eventType: string;
  externalEventId: string | null;
  payload: unknown;
  signatureValid: boolean | null;
  processed: boolean;
  processingError: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface ReservationRecord {
  id: string;
  registrationId: string;
  categoryId: string | null;
  paymentId: string | null;
  quantity: number;
  status: ReservationStatus;
  reservedAt: string | null;
  expiresAt: string | null;
  confirmedAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePaymentInput {
  registrationId: string;
  debtorName?: string;
  debtorCpf?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolvedDebtor {
  athleteId: string;
  fullName: string;
  cpfDigits: string;
}

export interface PaymentResponse {
  paymentId: string;
  chargeId: string | null;
  txid: string | null;
  status: PaymentStatusV2;
  amount: string;
  amountNumeric: number;
  pixCopiaECola: string | null;
  qrCodeDataUrl: string | null;
  expiresAt: string | null;
  registrationId: string | null;
  registrationNumber: string | null;
  provider: string;
}

export interface ProviderChargeResult {
  txid: string;
  status: PaymentStatusV2;
  pixCopiaECola: string;
  amountOriginal: string;
  expiresAt: string;
  location?: string;
  providerChargeId?: string;
  rawRequest?: unknown;
  raw?: unknown;
}

export interface ProviderChargeStatus {
  txid: string;
  status: PaymentStatusV2;
  /** Status bruto retornado pela API Pix (ex.: CONCLUIDA, ATIVA). */
  sicrediStatus?: string;
  pixCopiaECola?: string;
  amountOriginal: string;
  /** Valor liquidado no pix[] quando houver; senão valor.original da cobrança. */
  receivedAmount?: string;
  endToEndId?: string;
  paidAt?: string;
  raw?: unknown;
}

export interface ProviderRefundResult {
  refundId: string;
  status: string;
  amount: string;
  raw?: unknown;
}
