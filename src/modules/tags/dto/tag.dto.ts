import { z } from 'zod';
import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

export const ALLOWED_TAG_COLORS = [
  'slate',
  'red',
  'orange',
  'amber',
  'emerald',
  'blue',
  'violet',
  'pink',
] as const;

export type AllowedTagColor = (typeof ALLOWED_TAG_COLORS)[number];

export const createTagSchema = z
  .object({
    name: z.string().trim().min(1).max(30),
    color: z.enum(ALLOWED_TAG_COLORS).nullable().optional(),
  })
  .strict();

export type CreateTagDto = z.infer<typeof createTagSchema>;

export const updateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(30).optional(),
    color: z.enum(ALLOWED_TAG_COLORS).nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.name === undefined && data.color === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Minimal 1 field harus diisi',
      });
    }
  });

export type UpdateTagDto = z.infer<typeof updateTagSchema>;

export interface TagResponse {
  id: string;
  financial_profile_id: string;
  user_id: string;
  name: string;
  color: string | null;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class CreateTagPipe implements PipeTransform {
  transform(value: unknown) {
    const parsed = createTagSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Data tidak valid',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    return parsed.data;
  }
}

@Injectable()
export class UpdateTagPipe implements PipeTransform {
  transform(value: unknown) {
    const parsed = updateTagSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Data tidak valid',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    return parsed.data;
  }
}
