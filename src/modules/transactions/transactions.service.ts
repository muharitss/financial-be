import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { todayInTz } from '../../common/utils/date.js';
import {
  resolveClientTxId,
  type CreateTransactionDto,
  type CreateIncomeDto,
} from './dto/transaction.dto.js';

export interface TransactionResponse {
  id: string;
  financial_profile_id: string;
  user_id: string;
  account_id: string;
  to_account_id: string | null;
  type: string;
  amount: number;
  date: string;
  status: string;
  category_id: string | null;
  transfer_group_id: string | null;
  transfer_fee: number;
  fee_mode: string | null;
  parent_transaction_id: string | null;
  reason: string | null;
  note: string | null;
  client_tx_id: string;
  tags?: string[];
  processed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  warning?: string;
}

export function toTransactionResponse(
  tx: {
    id: string;
    financial_profile_id: string;
    user_id: string;
    account_id: string;
    to_account_id?: string | null;
    type: string;
    amount: bigint | number;
    date: Date | string;
    status: string;
    category_id?: string | null;
    transfer_group_id?: string | null;
    transfer_fee?: bigint | number | null;
    fee_mode?: string | null;
    parent_transaction_id?: string | null;
    reason?: string | null;
    note?: string | null;
    client_tx_id: string;
    tags?: Array<{ tag_id?: string; id?: string } | string>;
    processed_at?: Date | null;
    cancelled_at?: Date | null;
    created_at: Date;
    updated_at: Date;
  },
  warning?: string,
): TransactionResponse {
  const dateStr =
    tx.date instanceof Date
      ? tx.date.toISOString().slice(0, 10)
      : typeof tx.date === 'string'
        ? tx.date.slice(0, 10)
        : '';

  const tags = Array.isArray(tx.tags)
    ? tx.tags.map((t) => (typeof t === 'string' ? t : (t.tag_id ?? t.id ?? '')))
    : [];

  const res: TransactionResponse = {
    id: tx.id,
    financial_profile_id: tx.financial_profile_id,
    user_id: tx.user_id,
    account_id: tx.account_id,
    to_account_id: tx.to_account_id ?? null,
    type: tx.type,
    amount: Number(tx.amount),
    date: dateStr,
    status: tx.status,
    category_id: tx.category_id ?? null,
    transfer_group_id: tx.transfer_group_id ?? null,
    transfer_fee: Number(tx.transfer_fee ?? 0),
    fee_mode: tx.fee_mode ?? null,
    parent_transaction_id: tx.parent_transaction_id ?? null,
    reason: tx.reason ?? null,
    note: tx.note ?? null,
    client_tx_id: tx.client_tx_id,
    tags,
    processed_at: tx.processed_at ?? null,
    cancelled_at: tx.cancelled_at ?? null,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
  };

  if (warning) {
    res.warning = warning;
  }

  return res;
}

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    user: { userId: string; role?: string },
    dto: CreateTransactionDto,
    headerIdempotencyKey?: string,
  ): Promise<TransactionResponse> {
    if (dto.type === 'INCOME') {
      return this.createIncome(user, dto, headerIdempotencyKey);
    }

    throw new BadRequestException({
      code: 'UNSUPPORTED_TRANSACTION_TYPE',
      message: `Tipe transaksi ${(dto as any).type} belum didukung`,
    });
  }

  private async createIncome(
    user: { userId: string; role?: string },
    dto: CreateIncomeDto,
    headerIdempotencyKey?: string,
  ): Promise<TransactionResponse> {
    const clientTxId = resolveClientTxId(dto.client_tx_id, headerIdempotencyKey);

    const pref = await this.prisma.userPreference.findFirst({
      where: { user_id: user.userId },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const today = todayInTz(tz);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Kunci baris akun dengan SELECT ... FOR UPDATE
        const accounts = await tx.$queryRaw<
          Array<{
            id: string;
            financial_profile_id: string;
            balance: bigint;
            allow_negative: boolean;
            archived: boolean;
          }>
        >`SELECT id, financial_profile_id, balance, allow_negative, archived FROM accounts WHERE id = ${dto.account_id}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE`;

        const account = accounts[0];
        if (!account) {
          throw new NotFoundException({
            code: 'ACCOUNT_NOT_FOUND',
            message: 'Akun tidak ditemukan',
          });
        }

        if (account.archived) {
          throw new ConflictException({
            code: 'ACCOUNT_ARCHIVED',
            message: 'Akun telah diarsipkan',
          });
        }

        // 2. Cek kategori
        const category = await tx.category.findFirst({
          where: { id: dto.category_id, user_id: user.userId },
        });

        if (!category) {
          throw new NotFoundException({
            code: 'CATEGORY_NOT_FOUND',
            message: 'Kategori tidak ditemukan',
          });
        }

        if (category.archived) {
          throw new UnprocessableEntityException({
            code: 'CATEGORY_ARCHIVED',
            message: 'Kategori telah diarsipkan',
          });
        }

        if (category.type !== 'INCOME') {
          throw new BadRequestException({
            code: 'INVALID_CATEGORY_TYPE',
            message: 'Kategori harus bertipe INCOME',
          });
        }

        // 3. Cek tags jika ada
        let tagIds: string[] = [];
        if (dto.tags && dto.tags.length > 0) {
          tagIds = Array.from(new Set(dto.tags));
          const tags = await tx.tag.findMany({
            where: { id: { in: tagIds }, user_id: user.userId },
          });

          if (tags.length !== tagIds.length) {
            throw new NotFoundException({
              code: 'TAG_NOT_FOUND',
              message: 'Tag tidak ditemukan',
            });
          }

          if (tags.some((t) => t.archived)) {
            throw new UnprocessableEntityException({
              code: 'TAG_ARCHIVED',
              message: 'Tag telah diarsipkan',
            });
          }
        }

        // 4. Hitung status: scheduled vs posted (C-04)
        const isScheduled = dto.date > today;
        const status: TransactionStatus = isScheduled ? 'SCHEDULED' : 'POSTED';

        // 5. Buat Transaction
        const created = await tx.transaction.create({
          data: {
            user_id: user.userId,
            financial_profile_id: account.financial_profile_id,
            account_id: account.id,
            type: 'INCOME',
            amount: BigInt(dto.amount),
            date: new Date(`${dto.date}T00:00:00.000Z`),
            status,
            category_id: dto.category_id,
            note: dto.note ?? null,
            client_tx_id: clientTxId,
          },
        });

        // 6. Relasi tag
        if (tagIds.length > 0) {
          await tx.transactionTag.createMany({
            data: tagIds.map((tag_id) => ({
              transaction_id: created.id,
              tag_id,
            })),
          });
        }

        // 7. Update balance akun jika POSTED
        let finalBalance = account.balance;
        if (status === 'POSTED') {
          finalBalance = account.balance + BigInt(dto.amount);
          await tx.account.update({
            where: { id: account.id, user_id: user.userId },
            data: { balance: finalBalance },
          });
        }

        let warning: string | undefined;
        if (status === 'POSTED' && finalBalance < 0n) {
          warning = 'NEGATIVE_BALANCE';
        }

        // 8. Buat TransactionAudit (C-06, NFR-TRX-005)
        const response = toTransactionResponse(
          {
            ...created,
            tags: tagIds,
          },
          warning,
        );

        await tx.transactionAudit.create({
          data: {
            transaction_id: created.id,
            action: 'CREATE',
            before: Prisma.DbNull,
            after: response as unknown as Prisma.InputJsonValue,
            actor_user_id: user.userId,
          },
        });

        return response;
      });
    } catch (error: any) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'CLIENT_TX_ID_DUPLICATE',
          message: 'client_tx_id sudah pernah digunakan',
        });
      }
      throw error;
    }
  }
}
