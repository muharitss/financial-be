import { z } from 'zod';

export const PERIOD_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export const createBudgetSchema = z
  .object({
    type: z.enum(['TOTAL', 'CATEGORY']),
    category_id: z.uuid().optional(),
    period: z.string().regex(PERIOD_REGEX).optional(),
    amount: z.number().int().positive(),
    scope_account_ids: z.array(z.uuid()).max(50).optional(),
    rollover_enabled: z.boolean().optional(),
    client_tx_id: z.string().max(64).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.type === 'CATEGORY' && !data.category_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'category_id wajib diisi untuk anggaran kategori',
        path: ['category_id'],
      });
    }
    if (data.type === 'TOTAL' && data.category_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'category_id tidak boleh diisi untuk anggaran total',
        path: ['category_id'],
      });
    }
  });

export type CreateBudgetDto = z.infer<typeof createBudgetSchema>;

export const updateBudgetSchema = z
  .object({
    period: z.string().regex(PERIOD_REGEX).optional(),
    amount: z.number().int().positive().optional(),
    scope_account_ids: z.array(z.uuid()).max(50).optional(),
    rollover_enabled: z.boolean().optional(),
    client_tx_id: z.string().max(64).optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.amount !== undefined ||
      data.scope_account_ids !== undefined ||
      data.rollover_enabled !== undefined,
    {
      message: 'Minimal salah satu dari amount, scope_account_ids, atau rollover_enabled wajib diisi',
    },
  );

export type UpdateBudgetDto = z.infer<typeof updateBudgetSchema>;

export const budgetQuerySchema = z
  .object({
    period: z.string().regex(PERIOD_REGEX).optional(),
  })
  .strict();

export type BudgetQueryDto = z.infer<typeof budgetQuerySchema>;

