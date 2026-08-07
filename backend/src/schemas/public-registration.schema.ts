import { z } from 'zod';
import { normalizeCpfDigits } from '../utils/cpf.js';

/** Limite alinhado ao frontend (assinatura data URL). */
export const MAX_SIGNATURE_DATA_URL_LENGTH = 500_000;

const cpfSchema = z
  .string()
  .min(11)
  .max(14)
  .transform((v) => normalizeCpfDigits(v))
  .refine((v) => v.length === 11, { message: 'CPF deve possuir 11 dígitos' });

/**
 * Campos alinhados a `public.athletes` NOT NULL sem default:
 * full_name, cpf, birth_date, gender, email, phone.
 * (Demais NOT NULL têm DEFAULT: consents, is_public_profile, timestamps.)
 */
const athleteSchema = z.object({
  fullName: z.string().min(2).max(200),
  cpf: cpfSchema,
  email: z
    .string({ error: 'Informe um e-mail válido para o atleta.' })
    .trim()
    .email('Informe um e-mail válido para o atleta.')
    .max(160, 'Informe um e-mail válido para o atleta.'),
  phone: z
    .string({ error: 'Informe o telefone do atleta.' })
    .trim()
    .min(8, 'Informe o telefone do atleta.')
    .max(20, 'Telefone inválido.'),
  birthDate: z
    .string({ error: 'Informe a data de nascimento do atleta.' })
    .trim()
    .min(8, 'Informe a data de nascimento do atleta.')
    .max(32, 'Data de nascimento inválida.'),
  /**
   * Obrigatório: `athletes.gender` é NOT NULL no banco.
   * Valores usados pelo formulário Elite CDT: masculino | feminino | outro.
   * Coluna é TEXT livre — exigimos string não vazia (sem inventar default).
   */
  gender: z
    .string({ error: 'Informe o gênero do atleta.' })
    .trim()
    .min(1, 'Informe o gênero do atleta.')
    .max(40, 'Gênero inválido.'),
  shirtSize: z.string().max(10).optional(),
  emergencyName: z.string().max(200).optional(),
  emergencyPhone: z.string().max(20).optional(),
  medicalNotes: z.string().max(2000).optional(),
  role: z.string().max(40).optional(),
});

/** Formato legado + Elite CDT (isAthlete1). */
const responsibleSchema = z.object({
  isAthlete1: z.boolean().optional(),
  fullName: z.string().min(2).max(200).optional(),
  cpf: cpfSchema.optional(),
  email: z.string().email().optional(),
  phone: z.string().min(8).max(20).optional(),
});

const waiverSchema = z.object({
  regulationAccepted: z.boolean().optional(),
  privacyAccepted: z.boolean().optional(),
  imageUseAccepted: z.boolean().optional(),
  fitnessAccepted: z.boolean().optional(),
  signatureDataUrl: z.string().max(MAX_SIGNATURE_DATA_URL_LENGTH).optional(),
});

export const publicEventSlugParamSchema = z.object({
  slug: z.string().min(1).max(120),
});

export const publicCategorySlugParamsSchema = z.object({
  slug: z.string().min(1).max(120),
  categorySlug: z.string().min(1).max(120),
});

export const publicRegistrationIdParamSchema = z.object({
  registrationId: z.string().uuid(),
});

export const publicPaymentIdParamSchema = z.object({
  paymentId: z.string().uuid().or(z.string().min(1)),
});

const PRICE_KEYS = [
  'totalPrice',
  'amount',
  'price',
  'valor',
  'clientAmountCents',
  'priceCents',
] as const;

/**
 * Normaliza body Elite CDT + legado:
 * - mapeia waiver.* → termsAccepted / privacyAccepted
 * - remove preço e metadados de UI (categoryFormat, teamSize)
 */
export function normalizePublicRegistrationInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  for (const key of PRICE_KEYS) {
    delete o[key];
  }
  delete o.categoryFormat;
  delete o.teamSize;

  const waiver = o.waiver;
  if (waiver && typeof waiver === 'object' && !Array.isArray(waiver)) {
    const w = waiver as Record<string, unknown>;
    if (w.regulationAccepted === true) o.termsAccepted = true;
    if (w.privacyAccepted === true) o.privacyAccepted = true;
    o.waiver = {
      regulationAccepted: w.regulationAccepted === true,
      privacyAccepted: w.privacyAccepted === true,
      imageUseAccepted: w.imageUseAccepted === true,
      fitnessAccepted: w.fitnessAccepted === true,
      signatureDataUrl:
        typeof w.signatureDataUrl === 'string' ? w.signatureDataUrl : undefined,
    };
  }

  // emergencyContact legado → propaga para atleta[0] se ausente
  const emergency = o.emergencyContact;
  if (emergency && typeof emergency === 'object' && Array.isArray(o.athletes)) {
    const athletes = [...(o.athletes as Record<string, unknown>[])];
    if (athletes[0]) {
      const e = emergency as Record<string, unknown>;
      athletes[0] = {
        ...athletes[0],
        emergencyName: athletes[0].emergencyName ?? e.name,
        emergencyPhone: athletes[0].emergencyPhone ?? e.phone,
      };
      o.athletes = athletes;
    }
  }

  // medicalNotes top-level → atleta[0]
  if (typeof o.medicalNotes === 'string' && Array.isArray(o.athletes)) {
    const athletes = [...(o.athletes as Record<string, unknown>[])];
    if (athletes[0] && athletes[0].medicalNotes == null) {
      athletes[0] = { ...athletes[0], medicalNotes: o.medicalNotes };
      o.athletes = athletes;
    }
  }

  return o;
}

const createPublicRegistrationObjectSchema = z
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
    waiver: waiverSchema.optional(),
    termsAccepted: z.literal(true),
    privacyAccepted: z.literal(true),
    requestId: z.string().min(8).max(120).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const cpfs = data.athletes.map((a) => a.cpf);
    if (new Set(cpfs).size !== cpfs.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'CPF duplicado na mesma inscrição',
        path: ['athletes'],
      });
    }

    const sig = data.waiver?.signatureDataUrl;
    if (sig != null && sig.length > MAX_SIGNATURE_DATA_URL_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        message: 'Assinatura excede o tamanho máximo permitido',
        path: ['waiver', 'signatureDataUrl'],
      });
    }
    if (sig != null && sig.length > 0 && !sig.startsWith('data:image/')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Assinatura deve ser data URL de imagem',
        path: ['waiver', 'signatureDataUrl'],
      });
    }

    const resp = data.responsible;
    if (resp && resp.isAthlete1 === false) {
      if (!resp.fullName || resp.fullName.trim().length < 2) {
        ctx.addIssue({
          code: 'custom',
          message: 'Responsável externo exige fullName',
          path: ['responsible', 'fullName'],
        });
      }
      if (!resp.phone || resp.phone.trim().length < 8) {
        ctx.addIssue({
          code: 'custom',
          message: 'Responsável externo exige phone',
          path: ['responsible', 'phone'],
        });
      }
      if (!resp.cpf) {
        ctx.addIssue({
          code: 'custom',
          message: 'Responsável externo exige cpf',
          path: ['responsible', 'cpf'],
        });
      }
    }
  });

export const createPublicRegistrationSchema = z.preprocess(
  normalizePublicRegistrationInput,
  createPublicRegistrationObjectSchema,
);

export type CreatePublicRegistrationBody = z.infer<typeof createPublicRegistrationObjectSchema>;
