import { z } from 'zod';
import { normalizeCpfDigits } from '../utils/cpf.js';

const cpfSchema = z
  .string()
  .min(11)
  .max(14)
  .transform((v) => normalizeCpfDigits(v))
  .refine((v) => v.length === 11, { message: 'CPF deve possuir 11 dígitos' });

const athleteSchema = z.object({
  fullName: z.string().min(2).max(200),
  cpf: cpfSchema,
  birthDate: z.string().optional(),
  shirtSize: z.string().max(10).optional(),
  role: z.string().max(40).optional(),
});

const responsibleSchema = z.object({
  fullName: z.string().min(2).max(200),
  cpf: cpfSchema.optional(),
  email: z.string().email().optional(),
  phone: z.string().min(8).max(20).optional(),
});

export const publicEventSlugParamSchema = z.object({
  slug: z.string().min(1).max(120),
});

export const publicRegistrationIdParamSchema = z.object({
  registrationId: z.string().uuid(),
});

export const publicPaymentIdParamSchema = z.object({
  paymentId: z.string().uuid().or(z.string().min(1)),
});

export const createPublicRegistrationSchema = z
  .object({
    eventId: z.string().uuid(),
    categoryId: z.string().uuid(),
    athletes: z.array(athleteSchema).min(1).max(20),
    responsible: responsibleSchema.optional(),
    teamName: z.string().min(2).max(120).optional(),
    shirtSizes: z.array(z.string().max(10)).optional(),
    emergencyContact: z
      .object({
        name: z.string().min(2).max(200),
        phone: z.string().min(8).max(20),
      })
      .optional(),
    medicalNotes: z.string().max(2000).optional(),
    termsAccepted: z.literal(true),
    privacyAccepted: z.literal(true),
    requestId: z.string().min(8).max(120).optional(),
    // Nunca aceitar preço do cliente
  })
  .strict()
  .superRefine((data, ctx) => {
    const forbidden = ['totalPrice', 'amount', 'price', 'valor', 'clientAmountCents'];
    for (const key of forbidden) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Valor não pode ser enviado pelo frontend',
          path: [key],
        });
      }
    }
    const cpfs = data.athletes.map((a) => a.cpf);
    if (new Set(cpfs).size !== cpfs.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'CPF duplicado na mesma inscrição',
        path: ['athletes'],
      });
    }
  });

export type CreatePublicRegistrationBody = z.infer<typeof createPublicRegistrationSchema>;
