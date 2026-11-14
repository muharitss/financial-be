import { z } from 'zod';
import { CategoryType } from '@prisma/client';

export const createCategorySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Nama kategori wajib diisi')
      .max(50, 'Nama kategori maksimal 50 karakter'),
    type: z.enum(['INCOME', 'EXPENSE']),
    parent_id: z.uuid().nullable().optional(),
  })
  .strict();

export type CreateCategoryDto = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Nama kategori wajib diisi')
      .max(50, 'Nama kategori maksimal 50 karakter'),
  })
  .strict();

export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;

export interface CategoryResponse {
  id: string;
  financial_profile_id: string;
  user_id: string;
  type: CategoryType;
  parent_id: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  is_system: boolean;
  archived: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
