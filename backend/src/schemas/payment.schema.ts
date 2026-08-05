import { z } from 'zod';

export const createPaymentSchema = z
  .object({
    registrationId: z.string().uuid(),
    debtorName: z.string().min(2).max(200).optional(),
    debtorCpf: z
      .string()
      .transform((v) => v.replace(/\D/g, ''))
      .refine((v) => v.length === 0 || v.length === 11, {
        message: 'CPF deve ter 11 dígitos',
      })
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const forbidden = ['amount', 'clientAmountCents', 'totalPrice', 'valor', 'price'];
    for (const key of forbidden) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Valor não pode ser enviado pelo frontend; use registrations.total_price',
          path: [key],
        });
      }
    }
  });

export const paymentIdParamSchema = z.object({
  paymentId: z.string().uuid().or(z.string().min(1)),
});

export const refundSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  reason: z.string().max(200).optional(),
});

export type CreatePaymentBody = z.infer<typeof createPaymentSchema>;
