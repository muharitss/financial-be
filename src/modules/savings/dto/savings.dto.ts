import { z } from 'zod';

export const createSavingsGoalSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    target_amount: z.number().int().positive(),
    target_date: z.iso.date().nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    client_tx_id: z.string().max(64).optional(),
  })
  .strict();

export type CreateSavingsGoalDto = z.infer<typeof createSavingsGoalSchema>;

export const updateSavingsGoalSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    target_amount: z.number().int().positive().optional(),
    target_date: z.iso.date().nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    client_tx_id: z.string().max(64).optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.name !== undefined ||
      data.target_amount !== undefined ||
      data.target_date !== undefined ||
      data.note !== undefined,
    {
      message: 'Minimal satu field harus diisi untuk update',
    },
  );

export type UpdateSavingsGoalDto = z.infer<typeof updateSavingsGoalSchema>;

export const createAllocationSchema = z
  .object({
    account_id: z.uuid(),
    amount: z.number().int().positive(),
    client_tx_id: z.string().max(64).optional(),
  })
  .strict();

export type CreateAllocationDto = z.infer<typeof createAllocationSchema>;

export const releaseAllocationSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
    client_tx_id: z.string().max(64).optional(),
  })
  .strict()
  .default({});

export type ReleaseAllocationDto = z.infer<typeof releaseAllocationSchema>;


