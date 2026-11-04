import { z } from 'zod';
import { AccountType } from '@prisma/client';

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(50),
  type: z.enum(AccountType),
  provider: z.string().trim().max(50).optional(),
  opening_balance: z.number().int().nonnegative(),
  opening_date: z.iso.date().optional(),
  note: z.string().trim().max(500).optional(),
});

export type CreateAccountDto = z.infer<typeof createAccountSchema>;
