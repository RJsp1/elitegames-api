import { isIP } from 'node:net';
import { z } from 'zod';
import { normalizeCpfDigits } from '../utils/cpf.js';

const digits = (v: string) => v.replace(/\D/g, '');

export const createCardPaymentSchema = z
  .object({
    installments: z.coerce.number().int().min(1).max(21),
    /** Total que o cliente viu na tela; se divergir do cálculo do servidor, a cobrança é bloqueada. */
    expectedTotalAmount: z.coerce.number().positive().optional(),
    remoteIp: z
      .string()
      .trim()
      .refine((v) => isIP(v) !== 0, { message: 'IP do comprador inválido' }),
    card: z
      .object({
        holderName: z.string().trim().min(3).max(100),
        number: z
          .string()
          .transform(digits)
          .refine((v) => v.length >= 13 && v.length <= 19, { message: 'Número do cartão inválido' }),
        expiryMonth: z
          .string()
          .transform(digits)
          .refine((v) => Number(v) >= 1 && Number(v) <= 12, { message: 'Mês de validade inválido' }),
        expiryYear: z
          .string()
          .transform(digits)
          .refine((v) => v.length === 2 || v.length === 4, { message: 'Ano de validade inválido' }),
        ccv: z
          .string()
          .transform(digits)
          .refine((v) => v.length === 3 || v.length === 4, { message: 'CVV inválido' }),
      })
      .strict(),
    holder: z
      .object({
        name: z.string().trim().min(3).max(100),
        email: z.string().trim().email().max(160),
        cpf: z
          .string()
          .transform((v) => normalizeCpfDigits(v))
          .refine((v) => v.length === 11, { message: 'CPF do titular deve possuir 11 dígitos' }),
        phone: z
          .string()
          .transform(digits)
          .refine((v) => v.length >= 10 && v.length <= 11, { message: 'Telefone do titular inválido' }),
        postalCode: z
          .string()
          .transform(digits)
          .refine((v) => v.length === 8, { message: 'CEP do titular inválido' }),
        addressNumber: z.string().trim().min(1).max(10),
      })
      .strict(),
  })
  .strict();

export type CreateCardPaymentBody = z.infer<typeof createCardPaymentSchema>;
