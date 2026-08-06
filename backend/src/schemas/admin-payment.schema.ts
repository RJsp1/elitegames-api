import { z } from 'zod';

const optionalIsoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Data inválida' })
  .optional();

export const adminPaymentListQuerySchema = z.object({
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      const raw = Array.isArray(v) ? v.join(',') : v;
      const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
      return parts.length ? parts : undefined;
    }),
  registrationId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  txid: z.string().min(1).max(50).optional(),
  dateFrom: optionalIsoDate,
  dateTo: optionalIsoDate,
  minAmount: z.coerce.number().nonnegative().optional(),
  maxAmount: z.coerce.number().nonnegative().optional(),
  hasMismatch: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  expired: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z
    .enum(['createdAt', 'paidAt', 'amount', 'status', 'updatedAt'])
    .default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const adminPaymentIdParamSchema = z.object({
  paymentId: z.string().uuid().or(z.string().min(1)),
});

export const adminAuditQuerySchema = z.object({
  action: z.string().min(1).max(80).optional(),
  dateFrom: optionalIsoDate,
  dateTo: optionalIsoDate,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const adminMetricsQuerySchema = z.object({
  dateFrom: optionalIsoDate,
  dateTo: optionalIsoDate,
  eventId: z.string().uuid().optional(),
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
});

export const adminActionBodySchema = z.object({
  reason: z.string().max(200).optional(),
  confirm: z.boolean().optional(),
});

export type AdminPaymentListQuery = z.infer<typeof adminPaymentListQuerySchema>;
export type AdminAuditQuery = z.infer<typeof adminAuditQuerySchema>;
export type AdminMetricsQuery = z.infer<typeof adminMetricsQuerySchema>;
