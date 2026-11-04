import { z } from 'zod';

export const requestDeletionSchema = z.object({
  display_name_confirmed: z.string().min(1, 'Nama tampilan konfirmasi wajib diisi'),
  password: z.string().min(1, 'Password wajib diisi'),
});

export type RequestDeletionDto = z.infer<typeof requestDeletionSchema>;

export const cancelDeletionSchema = z.object({
  email: z
    .string()
    .email('Format email tidak valid')
    .transform((v) => v.toLowerCase().trim()),
  password: z.string().min(1, 'Password wajib diisi'),
});

export type CancelDeletionDto = z.infer<typeof cancelDeletionSchema>;
