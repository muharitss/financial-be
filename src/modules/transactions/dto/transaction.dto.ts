import { z } from 'zod';
import {
  UnprocessableEntityException,
  BadRequestException,
  PipeTransform,
  Injectable,
} from '@nestjs/common';

export const ULID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

export function resolveClientTxId(
  bodyClientTxId?: string,
  headerIdempotencyKey?: string | string[],
): string {
  const headerVal = Array.isArray(headerIdempotencyKey)
    ? headerIdempotencyKey[0]
    : headerIdempotencyKey;

  const candidate =
    bodyClientTxId && bodyClientTxId.trim() !== ''
      ? bodyClientTxId.trim()
      : headerVal && headerVal.trim() !== ''
        ? headerVal.trim()
        : undefined;

  if (!candidate) {
    throw new UnprocessableEntityException({
      code: 'MISSING_CLIENT_TX_ID',
      message: 'client_tx_id atau header Idempotency-Key wajib disertakan',
    });
  }

  if (!ULID_REGEX.test(candidate)) {
    throw new UnprocessableEntityException({
      code: 'VALIDATION_ERROR',
      message: 'Format client_tx_id tidak valid (harus ULID)',
    });
  }

  return candidate;
}

export const splitItemSchema = z
  .object({
    category_id: z.uuid(),
    amount: z.number().int().positive(),
  })
  .strict();

export type SplitItemDto = z.infer<typeof splitItemSchema>;

export const createIncomeSchema = z
  .object({
    type: z.literal('INCOME'),
    amount: z.number().int().positive(),
    account_id: z.uuid(),
    category_id: z.uuid().optional(),
    splits: z.array(splitItemSchema).min(2).max(20).optional(),
    date: z.iso.date(),
    note: z.string().trim().max(500).optional(),
    tags: z.array(z.uuid()).max(10).optional(),
    client_tx_id: z.string().regex(ULID_REGEX).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.splits && !data.category_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'category_id wajib disertakan jika splits tidak digunakan',
        path: ['category_id'],
      });
    }
  });

export type CreateIncomeDto = z.infer<typeof createIncomeSchema>;

export const createExpenseSchema = z
  .object({
    type: z.literal('EXPENSE'),
    amount: z.number().int().positive(),
    account_id: z.uuid(),
    category_id: z.uuid().optional(),
    splits: z.array(splitItemSchema).min(2).max(20).optional(),
    date: z.iso.date(),
    note: z.string().trim().max(500).optional(),
    tags: z.array(z.uuid()).max(10).optional(),
    client_tx_id: z.string().regex(ULID_REGEX).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.splits && !data.category_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'category_id wajib disertakan jika splits tidak digunakan',
        path: ['category_id'],
      });
    }
  });

export type CreateExpenseDto = z.infer<typeof createExpenseSchema>;

export const createTransferSchema = z
  .object({
    type: z.literal('TRANSFER'),
    account_id: z.uuid().optional(),
    from_account_id: z.uuid().optional(),
    to_account_id: z.uuid(),
    amount: z.number().int().positive(),
    fee: z.number().int().nonnegative().default(0),
    fee_mode: z.enum(['SEPARATE', 'BUNDLED']).default('SEPARATE'),
    fee_category_id: z.uuid().optional(),
    date: z.iso.date(),
    note: z.string().trim().max(500).optional(),
    tags: z.array(z.uuid()).max(10).optional(),
    client_tx_id: z.string().regex(ULID_REGEX).optional(),
  })
  .strict()
  .transform((val, ctx) => {
    const account_id = val.account_id ?? val.from_account_id;
    if (!account_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'account_id atau from_account_id wajib disertakan',
        path: ['account_id'],
      });
      return z.NEVER;
    }
    return {
      ...val,
      account_id,
    };
  });

export type CreateTransferDto = z.infer<typeof createTransferSchema>;

export const createAdjustmentSchema = z
  .object({
    type: z.literal('ADJUSTMENT'),
    account_id: z.uuid(),
    amount: z
      .number()
      .int()
      .refine((v) => v !== 0, { message: 'Nominal penyesuaian tidak boleh 0' }),
    date: z.iso.date(),
    reason: z.string().trim().max(500),
    note: z.string().trim().max(500).optional(),
    client_tx_id: z.string().regex(ULID_REGEX).optional(),
  })
  .strict();

export type CreateAdjustmentDto = z.infer<typeof createAdjustmentSchema>;

export const updateTransactionSchema = z
  .object({
    amount: z.number().int().optional(),
    date: z.iso.date().optional(),
    category_id: z.uuid().nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
    splits: z.array(splitItemSchema).min(2).max(20).nullable().optional(),
    tags: z.array(z.uuid()).max(10).optional(),
    account_id: z.uuid().optional(),
    client_tx_id: z.string().regex(ULID_REGEX).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const mutableFields = [
      data.amount,
      data.date,
      data.category_id,
      data.note,
      data.splits,
      data.tags,
      data.account_id,
    ];
    if (mutableFields.every((f) => f === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Minimal satu field perubahan harus dikirim',
      });
    }
  });

export type UpdateTransactionDto = z.infer<typeof updateTransactionSchema>;

export const reverseTransactionSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
    client_tx_id: z.string().regex(ULID_REGEX).optional(),
  })
  .strict();

export type ReverseTransactionDto = z.infer<typeof reverseTransactionSchema>;

@Injectable()
export class ReverseTransactionPipe implements PipeTransform {
  transform(value: unknown) {
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'object' && Object.keys(value).length === 0)
    ) {
      return {};
    }
    const parsed = reverseTransactionSchema.safeParse(value);
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

export const cancelTransactionSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
    client_tx_id: z.string().regex(ULID_REGEX).optional(),
  })
  .strict();

export type CancelTransactionDto = z.infer<typeof cancelTransactionSchema>;

@Injectable()
export class CancelTransactionPipe implements PipeTransform {
  transform(value: unknown) {
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'object' && Object.keys(value).length === 0)
    ) {
      return {};
    }
    const parsed = cancelTransactionSchema.safeParse(value);
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
export class UpdateTransactionPipe implements PipeTransform {
  transform(value: unknown) {
    if (typeof value === 'object' && value !== null) {
      const valObj = value as Record<string, any>;
      if (Array.isArray(valObj.tags) && valObj.tags.length > 10) {
        throw new UnprocessableEntityException({
          code: 'TOO_MANY_TAGS',
          message: 'Maksimal 10 tag per transaksi',
        });
      }
    }
    const parsed = updateTransactionSchema.safeParse(value);
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

export const createTransactionSchema = z.discriminatedUnion('type', [
  createIncomeSchema,
  createExpenseSchema,
  createTransferSchema,
  createAdjustmentSchema,
]);

export type CreateTransactionDto = z.infer<typeof createTransactionSchema>;

@Injectable()
export class CreateTransactionPipe implements PipeTransform {
  transform(value: unknown) {
    if (typeof value === 'object' && value !== null) {
      const valObj = value as Record<string, any>;
      if (Array.isArray(valObj.tags) && valObj.tags.length > 10) {
        throw new UnprocessableEntityException({
          code: 'TOO_MANY_TAGS',
          message: 'Maksimal 10 tag per transaksi',
        });
      }
    }
    const parsed = createTransactionSchema.safeParse(value);
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

export const ALLOWED_ATTACHMENT_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const MAX_ATTACHMENT_SIZE_BYTES = 5_242_880;
export const MAX_ATTACHMENTS_PER_TRANSACTION = 3;

export const presignAttachmentSchema = z
  .object({
    mime: z.enum(ALLOWED_ATTACHMENT_MIMES),
    size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE_BYTES),
  })
  .strict();

export type PresignAttachmentDto = z.infer<typeof presignAttachmentSchema>;

export const confirmAttachmentSchema = z
  .object({
    storage_key: z.string().trim().min(1),
    mime: z.enum(ALLOWED_ATTACHMENT_MIMES),
    size_bytes: z.number().int().positive().max(MAX_ATTACHMENT_SIZE_BYTES),
    magic_bytes_base64: z.string().trim().min(1),
  })
  .strict();

export type ConfirmAttachmentDto = z.infer<typeof confirmAttachmentSchema>;

@Injectable()
export class PresignAttachmentPipe implements PipeTransform {
  transform(value: unknown) {
    if (typeof value === 'object' && value !== null) {
      const v = value as Record<string, any>;
      if (
        typeof v.size === 'number' &&
        (v.size <= 0 || v.size > MAX_ATTACHMENT_SIZE_BYTES)
      ) {
        throw new UnprocessableEntityException({
          code: 'FILE_TOO_LARGE',
          message: 'Ukuran lampiran maksimal 5 MB',
        });
      }
      if (
        v.mime !== undefined &&
        !ALLOWED_ATTACHMENT_MIMES.includes(v.mime)
      ) {
        throw new UnprocessableEntityException({
          code: 'INVALID_FILE_TYPE',
          message: 'Tipe file harus JPEG, PNG, atau WebP',
        });
      }
    }
    const parsed = presignAttachmentSchema.safeParse(value);
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
export class ConfirmAttachmentPipe implements PipeTransform {
  transform(value: unknown) {
    if (typeof value === 'object' && value !== null) {
      const v = value as Record<string, any>;
      if (
        typeof v.size_bytes === 'number' &&
        (v.size_bytes <= 0 || v.size_bytes > MAX_ATTACHMENT_SIZE_BYTES)
      ) {
        throw new UnprocessableEntityException({
          code: 'FILE_TOO_LARGE',
          message: 'Ukuran lampiran maksimal 5 MB',
        });
      }
      if (
        v.mime !== undefined &&
        !ALLOWED_ATTACHMENT_MIMES.includes(v.mime)
      ) {
        throw new UnprocessableEntityException({
          code: 'INVALID_FILE_TYPE',
          message: 'Tipe file harus JPEG, PNG, atau WebP',
        });
      }
    }
    const parsed = confirmAttachmentSchema.safeParse(value);
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
