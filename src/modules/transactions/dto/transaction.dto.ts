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

export const createIncomeSchema = z
  .object({
    type: z.literal('INCOME'),
    amount: z.number().int().positive(),
    account_id: z.uuid(),
    category_id: z.uuid(),
    date: z.iso.date(),
    note: z.string().trim().max(500).optional(),
    tags: z.array(z.uuid()).max(10).optional(),
    client_tx_id: z.string().regex(ULID_REGEX).optional(),
  })
  .strict();

export type CreateIncomeDto = z.infer<typeof createIncomeSchema>;

export const createExpenseSchema = z
  .object({
    type: z.literal('EXPENSE'),
    amount: z.number().int().positive(),
    account_id: z.uuid(),
    category_id: z.uuid(),
    date: z.iso.date(),
    note: z.string().trim().max(500).optional(),
    tags: z.array(z.uuid()).max(10).optional(),
    client_tx_id: z.string().regex(ULID_REGEX).optional(),
  })
  .strict();

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
