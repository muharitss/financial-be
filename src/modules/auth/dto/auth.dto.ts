import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Format email tidak valid').transform((val) => val.toLowerCase().trim()),
  password: z.string().min(8, 'Password minimal 8 karakter'),
  name: z.string().min(1, 'Nama tidak boleh kosong').max(100),
});

export const loginSchema = z.object({
  email: z.string().email('Format email tidak valid').transform((val) => val.toLowerCase().trim()),
  password: z.string().min(1, 'Password tidak boleh kosong'),
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
