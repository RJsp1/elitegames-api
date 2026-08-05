import { z } from 'zod';

export const sicrediPixItemSchema = z.object({
  endToEndId: z.string().min(1),
  txid: z.string().optional(),
  valor: z.string().min(1),
  horario: z.string().min(1),
  infoPagador: z.string().optional(),
  chave: z.string().optional(),
});

export const sicrediWebhookSchema = z.object({
  pix: z.array(sicrediPixItemSchema).min(1),
});

export type SicrediWebhookBody = z.infer<typeof sicrediWebhookSchema>;
