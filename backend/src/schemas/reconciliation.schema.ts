import { z } from 'zod';

export const reconcileSchema = z.object({
  force: z.boolean().optional().default(false),
});

export const reconciliationQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
