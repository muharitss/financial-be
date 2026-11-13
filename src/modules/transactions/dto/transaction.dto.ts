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

export function encodeCursor(
  item: {
    date: Date | string;
    created_at: Date | string;
    id: string;
    amount?: bigint | number;
    category?: { name: string } | null;
  },
  sort?: 'date' | 'amount' | 'category',
): string {
  const d =
    item.date instanceof Date
      ? item.date.toISOString().slice(0, 10)
      : String(item.date).slice(0, 10);
  const c =
    item.created_at instanceof Date
      ? item.created_at.toISOString()
      : new Date(item.created_at).toISOString();

  let v: string | number | undefined;
  if (sort === 'amount' && item.amount !== undefined) {
    v = Number(item.amount);
  } else if (sort === 'category' && item.category) {
    v = item.category.name;
  }

  const payload = v !== undefined ? { d, c, id: item.id, v } : { d, c, id: item.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): {
  d: string;
  c: string;
  id: string;
  v?: any;
} {
  try {
    const jsonStr = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Not an object');
    }
    const { d, c, id, v } = parsed;
    if (typeof d !== 'string' || typeof c !== 'string' || typeof id !== 'string') {
      throw new Error('Missing fields');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) {
      throw new Error('Invalid date');
    }
    if (isNaN(Date.parse(c))) {
      throw new Error('Invalid timestamp');
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ) {
      throw new Error('Invalid UUID');
    }
    return { d, c, id, v };
  } catch {
    throw new BadRequestException({
      code: 'INVALID_CURSOR',
      message: 'Cursor pagination tidak valid',
    });
  }
}

export const adjustToTargetSchema = z
  .object({
    target_balance: z.number().int(),
    reason: z
      .string()
      .trim()
      .min(10, { message: 'Alasan penyesuaian minimal 10 karakter' })
      .max(500),
    note: z.string().trim().max(500).optional(),
    client_tx_id: z.string().regex(ULID_REGEX).optional(),
  })
  .strict();

export type AdjustToTargetDto = z.infer<typeof adjustToTargetSchema>;

@Injectable()
export class AdjustToTargetPipe implements PipeTransform {
  transform(value: unknown) {
    const parsed = adjustToTargetSchema.safeParse(value);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Data tidak valid',
        details: fieldErrors,
      });
    }
    return parsed.data;
  }
}

const toArrayHelper = (val: unknown): string[] | undefined => {
  if (val === undefined || val === null || val === '') return undefined;
  if (Array.isArray(val)) {
    return val.flatMap((v) =>
      typeof v === 'string'
        ? v.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
    );
  }
  if (typeof val === 'string') {
    return val.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
};

const emptyToUndefined = (val: unknown) => (val === '' ? undefined : val);

export const listTransactionsQuerySchema = z.object({
  q: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
  type: z.preprocess(
    toArrayHelper,
    z
      .array(
        z.enum(['INCOME', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT', 'REVERSAL']),
      )
      .optional(),
  ),
  status: z.preprocess(
    toArrayHelper,
    z.array(z.enum(['POSTED', 'SCHEDULED', 'CANCELLED', 'REVERSED'])).optional(),
  ),
  account_id: z.preprocess(
    toArrayHelper,
    z.array(z.uuid()).optional(),
  ),
  category_id: z.preprocess(
    toArrayHelper,
    z.array(z.uuid()).optional(),
  ),
  tag_id: z.preprocess(
    toArrayHelper,
    z.array(z.uuid()).optional(),
  ),
  date_from: z.preprocess(emptyToUndefined, z.iso.date().optional()),
  date_to: z.preprocess(emptyToUndefined, z.iso.date().optional()),
  amount_min: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().optional(),
  ),
  amount_max: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().optional(),
  ),
  sort: z.enum(['date', 'amount', 'category']).default('date'),
  cursor: z.preprocess(emptyToUndefined, z.string().optional()),
  limit: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(200).default(50),
  ),
});

export type ListTransactionsQueryDto = z.infer<
  typeof listTransactionsQuerySchema
>;

@Injectable()
export class ListTransactionsPipe implements PipeTransform {
  transform(value: unknown) {
    const parsed = listTransactionsQuerySchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Parameter query tidak valid',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    return parsed.data;
  }
}
