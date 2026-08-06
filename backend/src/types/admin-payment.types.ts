export interface AdminDashboardSummary {
  totalPayments: number;
  activePayments: number;
  paidPayments: number;
  expiredPayments: number;
  cancelledPayments: number;
  failedPayments: number;
  amountReceivedToday: string;
  amountPending: string;
  paymentsCreatedToday: number;
  paymentsPaidToday: number;
  averagePaymentTimeSeconds: number;
}

export interface AdminReconciliationHealthSnippet {
  status: 'ok' | 'degraded' | 'down';
  enabled: boolean;
  lastSuccessfulCycleAt: string | null;
  lastCycleDurationMs: number | null;
  lastCycleTotal: number;
  lastCycleErrors: number;
  consecutiveFailures: number;
}

export interface AdminChargeSnippet {
  chargeId: string;
  txidMasked: string | null;
  status: string;
  amount: string;
  expiresAt: string | null;
  isCurrent: boolean;
  createdAt: string;
  hasPixCopyPaste: boolean;
  hasQrCode: boolean;
}

export interface AdminPaymentListItem {
  paymentId: string;
  registrationId: string | null;
  registrationNumber: string | null;
  eventId: string | null;
  athleteName: string | null;
  amount: string;
  status: string;
  provider: string;
  createdAt: string;
  paidAt: string | null;
  paymentTimeSeconds: number | null;
  currentCharge: AdminChargeSnippet | null;
  chargeHistoryCount: number;
  endToEndIdMasked: string | null;
  txidMasked: string | null;
}

export interface AdminMetricsBucket {
  period: string;
  createdCount: number;
  paidCount: number;
  expiredCount: number;
  cancelledCount: number;
  failedCount: number;
  amountCreated: string;
  amountPaid: string;
  conversionRate: number;
  averagePaymentTimeSeconds: number;
  expirationRate: number;
  reissueCount: number;
}

export interface AdminMetricsResponse {
  dateFrom: string | null;
  dateTo: string | null;
  groupBy: 'day' | 'week' | 'month';
  totals: {
    createdCount: number;
    paidCount: number;
    expiredCount: number;
    cancelledCount: number;
    failedCount: number;
    amountCreated: string;
    amountPaid: string;
    conversionRate: number;
    averagePaymentTimeSeconds: number;
    expirationRate: number;
    reissueCount: number;
  };
  series: AdminMetricsBucket[];
}
