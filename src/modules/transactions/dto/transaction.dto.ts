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

export const createTransactionSchema = z.discriminatedUnion('type', [
  createIncomeSchema,
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
