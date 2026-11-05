import { randomUUID } from 'node:crypto';
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { todayInTz } from '../../common/utils/date.js';
import { evaluateNegativeBalancePolicy } from './balance-policy.js';
import {
  resolveClientTxId,
  type CreateTransactionDto,
  type CreateIncomeDto,
  type CreateExpenseDto,
  type CreateTransferDto,
  type CreateAdjustmentDto,
  type UpdateTransactionDto,
  type ReverseTransactionDto,
  type CancelTransactionDto,
  type SplitItemDto,
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
  splits?: Array<{ id?: string; category_id: string; amount: number }>;
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
    splits?: Array<{ id?: string; category_id: string; amount: bigint | number }>;
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

  const splits =
    Array.isArray(tx.splits) && tx.splits.length > 0
      ? tx.splits.map((s: any) => ({
          id: s.id,
          category_id: s.category_id,
          amount: Number(s.amount),
        }))
      : undefined;

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
    splits,
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

export async function getAccountReserved(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<bigint> {
  const allocation = await tx.savingsAllocation.groupBy({
    by: ['account_id'],
    where: {
      account_id: accountId,
      status: 'ACTIVE',
    },
    _sum: {
      amount: true,
    },
  });
  return allocation[0]?._sum.amount ?? 0n;
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
    if (dto.type === 'EXPENSE') {
      return this.createExpense(user, dto, headerIdempotencyKey);
    }
    if (dto.type === 'TRANSFER') {
      return this.createTransfer(user, dto, headerIdempotencyKey);
    }
    if (dto.type === 'ADJUSTMENT') {
      return this.createAdjustment(user, dto, undefined, headerIdempotencyKey);
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

        // 2. Cek kategori jika tidak menggunakan splits
        if (dto.splits && dto.splits.length > 0) {
          await this.validateAndCreateSplits(
            tx,
            user.userId,
            'INCOME',
            dto.amount,
            dto.splits,
          );
        } else {
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
            category_id: dto.splits && dto.splits.length > 0 ? null : (dto.category_id ?? null),
            note: dto.note ?? null,
            client_tx_id: clientTxId,
          },
        });

        // 6. Relasi splits
        let splitRecords:
          | Array<{
              id: string;
              transaction_id: string;
              category_id: string;
              amount: bigint;
            }>
          | undefined;
        if (dto.splits && dto.splits.length > 0) {
          splitRecords = dto.splits.map((s) => ({
            id: randomUUID(),
            transaction_id: created.id,
            category_id: s.category_id,
            amount: BigInt(s.amount),
          }));
          await tx.transactionSplit.createMany({
            data: splitRecords,
          });
        }

        // 7. Relasi tag
        if (tagIds.length > 0) {
          await tx.transactionTag.createMany({
            data: tagIds.map((tag_id) => ({
              transaction_id: created.id,
              tag_id,
            })),
          });
        }

        // 8. Update balance akun jika POSTED
        let finalBalance = account.balance;
        let warning: string | undefined;
        if (status === 'POSTED') {
          const reserved = await getAccountReserved(tx, account.id);
          const policy = evaluateNegativeBalancePolicy({
            account,
            reserved,
            delta: BigInt(dto.amount),
          });
          finalBalance = policy.newBalance;
          warning = policy.warning;
          await tx.account.update({
            where: { id: account.id, user_id: user.userId },
            data: { balance: finalBalance },
          });
        }

        // 9. Buat TransactionAudit (C-06, NFR-TRX-005)
        const response = toTransactionResponse(
          {
            ...created,
            tags: tagIds,
            splits: splitRecords,
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

  private async createExpense(
    user: { userId: string; role?: string },
    dto: CreateExpenseDto,
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

        // 2. Cek kategori jika tidak menggunakan splits
        if (dto.splits && dto.splits.length > 0) {
          await this.validateAndCreateSplits(
            tx,
            user.userId,
            'EXPENSE',
            dto.amount,
            dto.splits,
          );
        } else {
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

          if (category.type !== 'EXPENSE') {
            throw new BadRequestException({
              code: 'INVALID_CATEGORY_TYPE',
              message: 'Kategori harus bertipe EXPENSE',
            });
          }
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

        // Pengecekan saldo hanya untuk transaksi efektif (status === POSTED)
        let finalBalance = account.balance;
        let warning: string | undefined;
        if (status === 'POSTED') {
          const reserved = await getAccountReserved(tx, account.id);
          const policy = evaluateNegativeBalancePolicy({
            account,
            reserved,
            delta: -BigInt(dto.amount),
          });
          finalBalance = policy.newBalance;
          warning = policy.warning;
        }

        // 5. Buat Transaction
        const created = await tx.transaction.create({
          data: {
            user_id: user.userId,
            financial_profile_id: account.financial_profile_id,
            account_id: account.id,
            type: 'EXPENSE',
            amount: BigInt(dto.amount),
            date: new Date(`${dto.date}T00:00:00.000Z`),
            status,
            category_id: dto.splits && dto.splits.length > 0 ? null : (dto.category_id ?? null),
            note: dto.note ?? null,
            client_tx_id: clientTxId,
          },
        });

        // 6. Relasi splits
        let splitRecords:
          | Array<{
              id: string;
              transaction_id: string;
              category_id: string;
              amount: bigint;
            }>
          | undefined;
        if (dto.splits && dto.splits.length > 0) {
          splitRecords = dto.splits.map((s) => ({
            id: randomUUID(),
            transaction_id: created.id,
            category_id: s.category_id,
            amount: BigInt(s.amount),
          }));
          await tx.transactionSplit.createMany({
            data: splitRecords,
          });
        }

        // 7. Relasi tag
        if (tagIds.length > 0) {
          await tx.transactionTag.createMany({
            data: tagIds.map((tag_id) => ({
              transaction_id: created.id,
              tag_id,
            })),
          });
        }

        // 8. Update balance akun jika POSTED
        if (status === 'POSTED') {
          await tx.account.update({
            where: { id: account.id, user_id: user.userId },
            data: { balance: finalBalance },
          });
        }

        // 9. Buat TransactionAudit (C-06, NFR-TRX-005)
        const response = toTransactionResponse(
          {
            ...created,
            tags: tagIds,
            splits: splitRecords,
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

  private async createTransfer(
    user: { userId: string; role?: string },
    dto: CreateTransferDto,
    headerIdempotencyKey?: string,
  ): Promise<TransactionResponse> {
    if (dto.account_id === dto.to_account_id) {
      throw new UnprocessableEntityException({
        code: 'SAME_ACCOUNT_TRANSFER',
        message: 'Akun sumber dan tujuan tidak boleh sama',
      });
    }

    const fee = dto.fee ?? 0;
    if (dto.fee_mode === 'BUNDLED' && fee > 0) {
      const amountReceived = dto.amount - fee;
      if (amountReceived <= 0) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_ERROR',
          message: 'Nominal diterima (amount - fee) harus lebih besar dari 0',
        });
      }
    }

    const clientTxId = resolveClientTxId(dto.client_tx_id, headerIdempotencyKey);

    const pref = await this.prisma.userPreference.findFirst({
      where: { user_id: user.userId },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const today = todayInTz(tz);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Kunci kedua akun dengan urutan anti-deadlock (ORDER BY id ASC)
        const accounts = await tx.$queryRaw<
          Array<{
            id: string;
            financial_profile_id: string;
            balance: bigint;
            allow_negative: boolean;
            archived: boolean;
          }>
        >`SELECT id, financial_profile_id, balance, allow_negative, archived FROM accounts WHERE id IN (${dto.account_id}::uuid, ${dto.to_account_id}::uuid) AND user_id = ${user.userId}::uuid ORDER BY id ASC FOR UPDATE`;

        const fromAccount = accounts.find((a) => a.id === dto.account_id);
        const toAccount = accounts.find((a) => a.id === dto.to_account_id);

        if (!fromAccount || !toAccount) {
          throw new NotFoundException({
            code: 'ACCOUNT_NOT_FOUND',
            message: 'Akun tidak ditemukan',
          });
        }

        if (fromAccount.archived || toAccount.archived) {
          throw new ConflictException({
            code: 'ACCOUNT_ARCHIVED',
            message: 'Akun telah diarsipkan',
          });
        }

        // 2. Kategori biaya jika Metode A dengan fee > 0
        const isSeparateFee = fee > 0 && dto.fee_mode === 'SEPARATE';
        let feeCategory: { id: string; archived: boolean; type: string } | null = null;

        if (isSeparateFee) {
          if (dto.fee_category_id) {
            feeCategory = await tx.category.findFirst({
              where: { id: dto.fee_category_id, user_id: user.userId },
            });

            if (!feeCategory) {
              throw new NotFoundException({
                code: 'CATEGORY_NOT_FOUND',
                message: 'Kategori tidak ditemukan',
              });
            }

            if (feeCategory.archived) {
              throw new UnprocessableEntityException({
                code: 'CATEGORY_ARCHIVED',
                message: 'Kategori telah diarsipkan',
              });
            }

            if (feeCategory.type !== 'EXPENSE') {
              throw new BadRequestException({
                code: 'INVALID_CATEGORY_TYPE',
                message: 'Kategori harus bertipe EXPENSE',
              });
            }
          } else {
            // Default: kategori sistem 'Biaya Transfer' milik user
            feeCategory = await tx.category.findFirst({
              where: {
                user_id: user.userId,
                name: 'Biaya Transfer',
              },
            });

            if (!feeCategory) {
              feeCategory = await tx.category.create({
                data: {
                  user_id: user.userId,
                  financial_profile_id: fromAccount.financial_profile_id,
                  name: 'Biaya Transfer',
                  type: 'EXPENSE',
                  is_system: true,
                },
              });
            } else if (feeCategory.archived) {
              // Auto-unarchive sesuai Edge Case #17
              feeCategory = await tx.category.update({
                where: { id: feeCategory.id },
                data: { archived: false, archived_at: null },
              });
            }
          }
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

        // 5. Hitung nominal keluar dan diterima
        const amountReceived = dto.fee_mode === 'BUNDLED' && fee > 0 ? dto.amount - fee : dto.amount;
        const totalOut = isSeparateFee ? BigInt(dto.amount) + BigInt(fee) : BigInt(dto.amount);
        const amountReceivedBigInt = BigInt(amountReceived);

        // Pengecekan saldo sumber hanya untuk transaksi efektif (status === POSTED)
        let fromFinalBalance = fromAccount.balance;
        let warning: string | undefined;
        if (status === 'POSTED') {
          const fromReserved = await getAccountReserved(tx, fromAccount.id);
          const policy = evaluateNegativeBalancePolicy({
            account: fromAccount,
            reserved: fromReserved,
            delta: -totalOut,
            isOutgoingTransfer: true,
          });
          fromFinalBalance = policy.newBalance;
          warning = policy.warning;
        }

        const transferGroupId = isSeparateFee ? randomUUID() : null;
        const feeMode = fee > 0 ? dto.fee_mode : null;

        // 6. Buat baris TRANSFER
        const transferTx = await tx.transaction.create({
          data: {
            user_id: user.userId,
            financial_profile_id: fromAccount.financial_profile_id,
            account_id: fromAccount.id,
            to_account_id: toAccount.id,
            type: 'TRANSFER',
            amount: amountReceivedBigInt,
            date: new Date(`${dto.date}T00:00:00.000Z`),
            status,
            transfer_group_id: transferGroupId,
            transfer_fee: BigInt(fee),
            fee_mode: feeMode,
            note: dto.note ?? null,
            client_tx_id: clientTxId,
          },
        });

        // 7. Relasi tag pada baris TRANSFER
        if (tagIds.length > 0) {
          await tx.transactionTag.createMany({
            data: tagIds.map((tag_id) => ({
              transaction_id: transferTx.id,
              tag_id,
            })),
          });
        }

        // 8. Buat baris EXPENSE jika Metode A dengan fee > 0
        if (isSeparateFee && feeCategory) {
          const feeTx = await tx.transaction.create({
            data: {
              user_id: user.userId,
              financial_profile_id: fromAccount.financial_profile_id,
              account_id: fromAccount.id,
              to_account_id: null,
              type: 'EXPENSE',
              amount: BigInt(fee),
              date: new Date(`${dto.date}T00:00:00.000Z`),
              status,
              category_id: feeCategory.id,
              transfer_group_id: transferGroupId,
              transfer_fee: 0n,
              fee_mode: null,
              note: dto.note ? `Biaya transfer: ${dto.note}` : 'Biaya transfer',
              client_tx_id: `${clientTxId}:fee`,
            },
          });

          const feeResponse = toTransactionResponse(feeTx);
          await tx.transactionAudit.create({
            data: {
              transaction_id: feeTx.id,
              action: 'CREATE',
              before: Prisma.DbNull,
              after: feeResponse as unknown as Prisma.InputJsonValue,
              actor_user_id: user.userId,
            },
          });
        }

        // 9. Update saldo kedua akun jika POSTED
        let toFinalBalance = toAccount.balance;

        if (status === 'POSTED') {
          toFinalBalance = toAccount.balance + amountReceivedBigInt;

          await tx.account.update({
            where: { id: fromAccount.id, user_id: user.userId },
            data: { balance: fromFinalBalance },
          });

          await tx.account.update({
            where: { id: toAccount.id, user_id: user.userId },
            data: { balance: toFinalBalance },
          });
        }

        // 10. Buat TransactionAudit untuk baris TRANSFER
        const response = toTransactionResponse(
          {
            ...transferTx,
            tags: tagIds,
          },
          warning,
        );

        await tx.transactionAudit.create({
          data: {
            transaction_id: transferTx.id,
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

  async createAdjustment(
    user: { userId: string; role?: string },
    dto: CreateAdjustmentDto,
    existingTx?: Prisma.TransactionClient,
    headerIdempotencyKey?: string,
  ): Promise<TransactionResponse> {
    if (dto.reason.trim().length < 10) {
      throw new UnprocessableEntityException({
        code: 'REASON_TOO_SHORT',
        message: 'Alasan penyesuaian minimal 10 karakter',
      });
    }

    if (dto.amount === 0) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_ERROR',
        message: 'Nominal penyesuaian tidak boleh 0',
      });
    }

    const clientTxId = resolveClientTxId(dto.client_tx_id, headerIdempotencyKey);

    const client = existingTx ?? this.prisma;
    const pref = await client.userPreference.findFirst({
      where: { user_id: user.userId },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const today = todayInTz(tz);

    if (dto.date > today) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_ERROR',
        message: 'Tanggal penyesuaian tidak boleh di masa depan',
      });
    }

    const executeInTx = async (tx: Prisma.TransactionClient): Promise<TransactionResponse> => {
      // 1. Kunci baris akun dengan SELECT ... FOR UPDATE (user_id wajib)
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

      // 2. Evaluasi kebijakan saldo negatif
      const reserved = await getAccountReserved(tx, account.id);
      const policy = evaluateNegativeBalancePolicy({
        account,
        reserved,
        delta: BigInt(dto.amount),
      });
      const newBalance = policy.newBalance;
      const warning = policy.warning;

      // 4. Simpan Transaction
      const created = await tx.transaction.create({
        data: {
          user_id: user.userId,
          financial_profile_id: account.financial_profile_id,
          account_id: account.id,
          type: 'ADJUSTMENT',
          status: 'POSTED',
          category_id: null,
          amount: BigInt(dto.amount),
          date: new Date(`${dto.date}T00:00:00.000Z`),
          reason: dto.reason.trim(),
          note: dto.note ?? null,
          client_tx_id: clientTxId,
        },
      });

      // 5. Update account.balance = newBalance
      await tx.account.update({
        where: { id: account.id, user_id: user.userId },
        data: { balance: newBalance },
      });

      // 6. Simpan TransactionAudit
      const response = toTransactionResponse(created, warning);

      await tx.transactionAudit.create({
        data: {
          transaction_id: created.id,
          action: 'CREATE',
          reason: dto.reason.trim(),
          before: { account_balance: Number(account.balance) },
          after: {
            ...response,
            account_balance: Number(newBalance),
          },
          actor_user_id: user.userId,
        },
      });

      return response;
    };

    try {
      if (existingTx) {
        return await executeInTx(existingTx);
      }
      return await this.prisma.$transaction(async (tx) => executeInTx(tx));
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

  private async validateAndCreateSplits(
    tx: Prisma.TransactionClient,
    userId: string,
    txType: 'INCOME' | 'EXPENSE',
    totalAmount: number,
    splits: SplitItemDto[],
  ) {
    const sum = splits.reduce((acc, s) => acc + BigInt(s.amount), 0n);
    if (sum !== BigInt(totalAmount)) {
      throw new UnprocessableEntityException({
        code: 'SPLIT_SUM_MISMATCH',
        message: 'Total nominal split harus sama dengan nominal transaksi',
      });
    }

    const uniqueCatIds = Array.from(new Set(splits.map((s) => s.category_id)));
    const categories = await tx.category.findMany({
      where: { id: { in: uniqueCatIds }, user_id: userId },
    });

    if (categories.length !== uniqueCatIds.length) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Kategori split tidak ditemukan atau bukan milik Anda',
      });
    }

    if (categories.some((c) => c.archived)) {
      throw new UnprocessableEntityException({
        code: 'CATEGORY_ARCHIVED',
        message: 'Kategori telah diarsipkan',
      });
    }

    if (categories.some((c) => c.type !== txType)) {
      throw new BadRequestException({
        code: 'INVALID_CATEGORY_TYPE',
        message: `Kategori harus bertipe ${txType}`,
      });
    }
  }

  async update(
    user: { userId: string; role?: string },
    transactionId: string,
    dto: UpdateTransactionDto,
    headerIdempotencyKey?: string,
  ): Promise<{
    transaction: TransactionResponse;
    audit_id: string;
    warning?: string;
  }> {
    const clientTxId = resolveClientTxId(dto.client_tx_id, headerIdempotencyKey);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Kunci baris transaksi dengan SELECT ... FOR UPDATE (isolasi user_id)
        const existingTxs = await tx.$queryRaw<
          Array<{
            id: string;
            financial_profile_id: string;
            user_id: string;
            account_id: string;
            to_account_id: string | null;
            type: string;
            amount: bigint;
            date: Date;
            status: string;
            category_id: string | null;
            transfer_group_id: string | null;
            transfer_fee: bigint;
            fee_mode: string | null;
            parent_transaction_id: string | null;
            reason: string | null;
            note: string | null;
            client_tx_id: string;
            processed_at: Date | null;
            cancelled_at: Date | null;
            created_at: Date;
            updated_at: Date;
          }>
        >`SELECT id, financial_profile_id, user_id, account_id, to_account_id, type, amount, date, status, category_id, transfer_group_id, transfer_fee, fee_mode, parent_transaction_id, reason, note, client_tx_id, processed_at, cancelled_at, created_at, updated_at FROM transactions WHERE id = ${transactionId}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE`;

        const existing = existingTxs[0];
        if (!existing) {
          throw new NotFoundException({
            code: 'TRANSACTION_NOT_FOUND',
            message: 'Transaksi tidak ditemukan',
          });
        }

        // 2. Restriksi status
        if (existing.status === 'REVERSED' || existing.type === 'REVERSAL') {
          throw new ConflictException({
            code: 'ALREADY_REVERSED',
            message: 'Transaksi yang sudah di-reverse tidak dapat diedit',
          });
        }
        if (existing.status === 'CANCELLED') {
          throw new ConflictException({
            code: 'TRANSACTION_CANCELLED',
            message: 'Transaksi yang dibatalkan tidak dapat diedit',
          });
        }

        // 3. Larangan mengubah akun pada POSTED
        if (existing.status === 'POSTED') {
          if (dto.account_id !== undefined && dto.account_id !== existing.account_id) {
            throw new UnprocessableEntityException({
              code: 'ACCOUNT_CHANGE_NOT_ALLOWED',
              message:
                'Akun pada transaksi POSTED tidak dapat diubah; gunakan reversal dan buat transaksi baru',
            });
          }
        } else if (
          existing.status === 'SCHEDULED' &&
          dto.account_id !== undefined &&
          dto.account_id !== existing.account_id
        ) {
          const targetAccount = await tx.account.findFirst({
            where: { id: dto.account_id, user_id: user.userId },
          });
          if (!targetAccount) {
            throw new NotFoundException({
              code: 'ACCOUNT_NOT_FOUND',
              message: 'Akun tidak ditemukan',
            });
          }
          if (targetAccount.archived) {
            throw new ConflictException({
              code: 'ACCOUNT_ARCHIVED',
              message: 'Akun telah diarsipkan',
            });
          }
        }

        // 4. Validasi nominal
        if (dto.amount !== undefined) {
          if (existing.type === 'ADJUSTMENT') {
            if (dto.amount === 0) {
              throw new UnprocessableEntityException({
                code: 'VALIDATION_ERROR',
                message: 'Nominal penyesuaian tidak boleh 0',
              });
            }
          } else {
            if (dto.amount <= 0) {
              throw new UnprocessableEntityException({
                code: 'VALIDATION_ERROR',
                message: 'Nominal harus lebih besar dari 0',
              });
            }
          }
        }

        // 5. Snapshot before
        const existingSplits = await tx.transactionSplit.findMany({
          where: { transaction_id: existing.id },
        });
        const existingTags = await tx.transactionTag.findMany({
          where: { transaction_id: existing.id },
        });
        const beforeResponse = toTransactionResponse({
          ...existing,
          splits: existingSplits,
          tags: existingTags.map((t) => t.tag_id),
        });

        // 6. Validasi & penanganan splits / category
        const newAmount = dto.amount !== undefined ? dto.amount : Number(existing.amount);

        if (dto.splits !== undefined) {
          if (dto.splits && dto.splits.length > 0) {
            await this.validateAndCreateSplits(
              tx,
              user.userId,
              existing.type as 'INCOME' | 'EXPENSE',
              newAmount,
              dto.splits,
            );
            await tx.transactionSplit.deleteMany({
              where: { transaction_id: existing.id },
            });
            await tx.transactionSplit.createMany({
              data: dto.splits.map((s) => ({
                id: randomUUID(),
                transaction_id: existing.id,
                category_id: s.category_id,
                amount: BigInt(s.amount),
              })),
            });
          } else if (dto.splits === null) {
            if (!dto.category_id && !existing.category_id) {
              throw new BadRequestException({
                code: 'VALIDATION_ERROR',
                message: 'category_id wajib disertakan jika splits dihapus',
              });
            }
            await tx.transactionSplit.deleteMany({
              where: { transaction_id: existing.id },
            });
          }
        } else {
          if (
            existingSplits.length > 0 &&
            dto.amount !== undefined &&
            BigInt(dto.amount) !== existing.amount
          ) {
            throw new UnprocessableEntityException({
              code: 'SPLIT_SUM_MISMATCH',
              message:
                'Transaksi memiliki split, splits harus dikirim ulang saat mengubah amount',
            });
          }
          if (dto.category_id !== undefined) {
            if (dto.category_id !== null && dto.category_id !== existing.category_id) {
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
              if (category.type !== existing.type) {
                throw new BadRequestException({
                  code: 'INVALID_CATEGORY_TYPE',
                  message: `Kategori harus bertipe ${existing.type}`,
                });
              }
            }
          }
        }

        // 7. Penanganan tags
        let tagIds: string[] | undefined;
        if (dto.tags !== undefined) {
          tagIds = Array.from(new Set(dto.tags));
          if (tagIds.length > 0) {
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
          await tx.transactionTag.deleteMany({
            where: { transaction_id: existing.id },
          });
          if (tagIds.length > 0) {
            await tx.transactionTag.createMany({
              data: tagIds.map((tag_id) => ({
                transaction_id: existing.id,
                tag_id,
              })),
            });
          }
        }

        // 8. Rekalkulasi selisih saldo secara atomik jika POSTED
        let finalAccountBalance: bigint | undefined;
        if (
          existing.status === 'POSTED' &&
          dto.amount !== undefined &&
          BigInt(dto.amount) !== existing.amount
        ) {
          const newAmountBigInt = BigInt(dto.amount);
          const oldAmountBigInt = existing.amount;

          if (existing.type === 'TRANSFER') {
            const accounts = await tx.$queryRaw<
              Array<{
                id: string;
                financial_profile_id: string;
                balance: bigint;
                allow_negative: boolean;
                archived: boolean;
              }>
            >`SELECT id, financial_profile_id, balance, allow_negative, archived FROM accounts WHERE id IN (${existing.account_id}::uuid, ${existing.to_account_id}::uuid) AND user_id = ${user.userId}::uuid ORDER BY id ASC FOR UPDATE`;

            const fromAcc = accounts.find((a) => a.id === existing.account_id);
            const toAcc = accounts.find((a) => a.id === existing.to_account_id);

            const fromDelta = -(newAmountBigInt - oldAmountBigInt);
            const toDelta = newAmountBigInt - oldAmountBigInt;

            if (fromDelta < 0n) {
              const fromReserved = await getAccountReserved(tx, fromAcc!.id);
              const fromPolicy = evaluateNegativeBalancePolicy({
                account: fromAcc!,
                reserved: fromReserved,
                delta: fromDelta,
                isOutgoingTransfer: true,
              });
              finalAccountBalance = fromPolicy.newBalance;
            } else {
              finalAccountBalance = fromAcc!.balance + fromDelta;
            }

            if (toDelta < 0n) {
              const toReserved = await getAccountReserved(tx, toAcc!.id);
              evaluateNegativeBalancePolicy({
                account: toAcc!,
                reserved: toReserved,
                delta: toDelta,
              });
            }

            finalAccountBalance = fromAcc!.balance + fromDelta;

            await tx.account.update({
              where: { id: fromAcc!.id, user_id: user.userId },
              data: { balance: finalAccountBalance },
            });
            await tx.account.update({
              where: { id: toAcc!.id, user_id: user.userId },
              data: { balance: toAcc!.balance + toDelta },
            });
          } else {
            const accounts = await tx.$queryRaw<
              Array<{
                id: string;
                financial_profile_id: string;
                balance: bigint;
                allow_negative: boolean;
                archived: boolean;
              }>
            >`SELECT id, financial_profile_id, balance, allow_negative, archived FROM accounts WHERE id = ${existing.account_id}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE`;

            const account = accounts[0];
            let oldEffect = 0n;
            let newEffect = 0n;

            if (existing.type === 'INCOME') {
              oldEffect = oldAmountBigInt;
              newEffect = newAmountBigInt;
            } else if (existing.type === 'EXPENSE') {
              oldEffect = -oldAmountBigInt;
              newEffect = -newAmountBigInt;
            } else if (existing.type === 'ADJUSTMENT') {
              oldEffect = oldAmountBigInt;
              newEffect = newAmountBigInt;
            }

            const delta = newEffect - oldEffect;
            const reserved = await getAccountReserved(tx, account.id);
            const policy = evaluateNegativeBalancePolicy({
              account,
              reserved,
              delta,
            });
            finalAccountBalance = policy.newBalance;

            await tx.account.update({
              where: { id: account.id, user_id: user.userId },
              data: { balance: finalAccountBalance },
            });
          }
        }

        // 9. Peringatan periode budget terkunci
        let warning: string | undefined;
        if (
          existing.type === 'EXPENSE' &&
          existing.status === 'POSTED' &&
          (dto.amount !== undefined || dto.date !== undefined)
        ) {
          const oldMonth = existing.date.toISOString().slice(0, 7);
          const newDateStr = dto.date ?? existing.date.toISOString().slice(0, 10);
          const newMonth = newDateStr.slice(0, 7);
          const periods = Array.from(new Set([oldMonth, newMonth]));

          const lockedPeriod = await tx.budgetPeriod.findFirst({
            where: {
              period: { in: periods },
              locked_at: { not: null },
              budget: { user_id: user.userId },
            },
          });

          if (lockedPeriod) {
            warning = 'LOCKED_BUDGET_PERIOD_AFFECTED';
          }
        }

        if (!warning && finalAccountBalance !== undefined && finalAccountBalance < 0n) {
          warning = 'NEGATIVE_BALANCE';
        }

        // 10. Update baris Transaction
        const updateData: Prisma.TransactionUpdateInput = {
          client_tx_id: clientTxId,
        };
        if (dto.amount !== undefined) {
          updateData.amount = BigInt(dto.amount);
        }
        if (dto.date !== undefined) {
          updateData.date = new Date(`${dto.date}T00:00:00.000Z`);
        }
        if (dto.category_id !== undefined) {
          updateData.category = dto.category_id
            ? { connect: { id: dto.category_id } }
            : { disconnect: true };
        }
        if (dto.splits && dto.splits.length > 0) {
          updateData.category = { disconnect: true };
        }
        if (dto.note !== undefined) {
          updateData.note = dto.note;
        }
        if (dto.reason !== undefined) {
          updateData.reason = dto.reason;
        }
        if (dto.account_id !== undefined && existing.status === 'SCHEDULED') {
          updateData.account = { connect: { id: dto.account_id } };
        }

        const updated = await tx.transaction.update({
          where: { id: existing.id, user_id: user.userId },
          data: updateData,
        });

        // 11. Snapshot after & TransactionAudit
        const finalSplits = await tx.transactionSplit.findMany({
          where: { transaction_id: existing.id },
        });
        const finalTags = await tx.transactionTag.findMany({
          where: { transaction_id: existing.id },
        });

        const afterResponse = toTransactionResponse(
          {
            ...updated,
            splits: finalSplits,
            tags: finalTags.map((t) => t.tag_id),
          },
          warning,
        );

        const audit = await tx.transactionAudit.create({
          data: {
            transaction_id: existing.id,
            action: 'UPDATE',
            before: beforeResponse as unknown as Prisma.InputJsonValue,
            after: afterResponse as unknown as Prisma.InputJsonValue,
            actor_user_id: user.userId,
            reason: dto.reason?.trim() ?? null,
          },
        });

        return {
          transaction: afterResponse,
          audit_id: audit.id,
          ...(warning ? { warning } : {}),
        };
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

  async reverse(
    user: { userId: string; role?: string },
    transactionId: string,
    dto: ReverseTransactionDto,
    headerIdempotencyKey?: string,
  ): Promise<{
    reversal_id: string;
    transaction: TransactionResponse;
    warning?: string;
  }> {
    const clientTxId = resolveClientTxId(dto?.client_tx_id, headerIdempotencyKey);

    const pref = await this.prisma.userPreference.findFirst({
      where: { user_id: user.userId },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const today = todayInTz(tz);
    const todayDate = new Date(`${today}T00:00:00.000Z`);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Kunci baris transaksi asli (FOR UPDATE + filter user_id)
        const originalTxs = await tx.$queryRaw<
          Array<{
            id: string;
            financial_profile_id: string;
            user_id: string;
            account_id: string;
            to_account_id: string | null;
            type: string;
            amount: bigint;
            date: Date;
            status: string;
            category_id: string | null;
            transfer_group_id: string | null;
            transfer_fee: bigint;
            fee_mode: string | null;
            parent_transaction_id: string | null;
            reason: string | null;
            note: string | null;
            client_tx_id: string;
            processed_at: Date | null;
            cancelled_at: Date | null;
            created_at: Date;
            updated_at: Date;
          }>
        >`SELECT id, financial_profile_id, user_id, account_id, to_account_id, type, amount, date, status, category_id, transfer_group_id, transfer_fee, fee_mode, parent_transaction_id, reason, note, client_tx_id, processed_at, cancelled_at, created_at, updated_at FROM transactions WHERE id = ${transactionId}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE`;

        const original = originalTxs[0];
        if (!original) {
          throw new NotFoundException({
            code: 'TRANSACTION_NOT_FOUND',
            message: 'Transaksi tidak ditemukan',
          });
        }

        // 2. Validasi status
        if (original.status === 'REVERSED') {
          throw new ConflictException({
            code: 'ALREADY_REVERSED',
            message: 'Transaksi sudah pernah di-reverse',
          });
        }
        if (original.status === 'SCHEDULED') {
          throw new ConflictException({
            code: 'CANNOT_REVERSE_SCHEDULED',
            message:
              'Transaksi terjadwal belum efektif; gunakan fitur batalkan (cancel)',
          });
        }
        if (original.status === 'CANCELLED') {
          throw new ConflictException({
            code: 'TRANSACTION_CANCELLED',
            message: 'Transaksi sudah dibatalkan',
          });
        }

        // Cek splits
        const originalSplits = await tx.transactionSplit.findMany({
          where: { transaction_id: original.id },
        });

        if (original.type === 'REVERSAL' && originalSplits.length > 0) {
          throw new UnprocessableEntityException({
            code: 'NESTED_SPLIT_REVERSAL_NOT_SUPPORTED',
            message:
              'Nested reversal untuk transaksi split tidak didukung di MVP',
          });
        }

        // 3. Efek pembalikan saldo
        let warning: string | undefined;

        if (original.type === 'INCOME') {
          const accounts = await tx.$queryRaw<
            Array<{
              id: string;
              financial_profile_id: string;
              balance: bigint;
              allow_negative: boolean;
              archived: boolean;
            }>
          >`SELECT id, financial_profile_id, balance, allow_negative, archived FROM accounts WHERE id = ${original.account_id}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE`;

          const account = accounts[0];
          const reserved = await getAccountReserved(tx, account.id);
          const policy = evaluateNegativeBalancePolicy({
            account,
            reserved,
            delta: -original.amount,
          });
          const newBalance = policy.newBalance;
          warning = policy.warning;

          await tx.account.update({
            where: { id: account.id, user_id: user.userId },
            data: { balance: newBalance },
          });
        } else if (original.type === 'EXPENSE') {
          const accounts = await tx.$queryRaw<
            Array<{
              id: string;
              financial_profile_id: string;
              balance: bigint;
              allow_negative: boolean;
              archived: boolean;
            }>
          >`SELECT id, financial_profile_id, balance, allow_negative, archived FROM accounts WHERE id = ${original.account_id}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE`;

          const account = accounts[0];
          const reserved = await getAccountReserved(tx, account.id);
          const policy = evaluateNegativeBalancePolicy({
            account,
            reserved,
            delta: original.amount,
          });
          const newBalance = policy.newBalance;
          if (policy.warning) {
            warning = policy.warning;
          }

          await tx.account.update({
            where: { id: account.id, user_id: user.userId },
            data: { balance: newBalance },
          });
        } else if (original.type === 'ADJUSTMENT') {
          const accounts = await tx.$queryRaw<
            Array<{
              id: string;
              financial_profile_id: string;
              balance: bigint;
              allow_negative: boolean;
              archived: boolean;
            }>
          >`SELECT id, financial_profile_id, balance, allow_negative, archived FROM accounts WHERE id = ${original.account_id}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE`;

          const account = accounts[0];
          const reserved = await getAccountReserved(tx, account.id);
          const policy = evaluateNegativeBalancePolicy({
            account,
            reserved,
            delta: -original.amount,
          });
          const newBalance = policy.newBalance;
          if (policy.warning) {
            warning = policy.warning;
          }

          await tx.account.update({
            where: { id: account.id, user_id: user.userId },
            data: { balance: newBalance },
          });
        } else if (original.type === 'TRANSFER') {
          const accounts = await tx.$queryRaw<
            Array<{
              id: string;
              financial_profile_id: string;
              balance: bigint;
              allow_negative: boolean;
              archived: boolean;
            }>
          >`SELECT id, financial_profile_id, balance, allow_negative, archived FROM accounts WHERE id IN (${original.account_id}::uuid, ${original.to_account_id}::uuid) AND user_id = ${user.userId}::uuid ORDER BY id ASC FOR UPDATE`;

          const fromAccount = accounts.find((a) => a.id === original.account_id);
          const toAccount = accounts.find((a) => a.id === original.to_account_id);

          const toReserved = await getAccountReserved(tx, toAccount!.id);
          const toPolicy = evaluateNegativeBalancePolicy({
            account: toAccount!,
            reserved: toReserved,
            delta: -original.amount,
          });
          const newToBalance = toPolicy.newBalance;
          if (toPolicy.warning) {
            warning = toPolicy.warning;
          }

          if (original.transfer_group_id) {
            // Metode A: cari pasangan transaksi di transfer_group_id yang sama
            const groupTxs = await tx.transaction.findMany({
              where: {
                transfer_group_id: original.transfer_group_id,
                user_id: user.userId,
                status: 'POSTED',
              },
            });

            const feeTx = groupTxs.find(
              (t) => t.id !== original.id && t.type === 'EXPENSE',
            );
            const feeAmount = feeTx ? feeTx.amount : 0n;
            const newFromBalance =
              fromAccount!.balance + original.amount + feeAmount;

            await tx.account.update({
              where: { id: fromAccount!.id, user_id: user.userId },
              data: { balance: newFromBalance },
            });
            await tx.account.update({
              where: { id: toAccount!.id, user_id: user.userId },
              data: { balance: newToBalance },
            });

            if (feeTx) {
              await tx.transaction.update({
                where: { id: feeTx.id, user_id: user.userId },
                data: { status: 'REVERSED' },
              });
              const feeReversal = await tx.transaction.create({
                data: {
                  user_id: user.userId,
                  financial_profile_id: feeTx.financial_profile_id,
                  account_id: feeTx.account_id,
                  type: 'REVERSAL',
                  status: 'POSTED',
                  parent_transaction_id: feeTx.id,
                  amount: feeTx.amount,
                  category_id: feeTx.category_id,
                  transfer_group_id: original.transfer_group_id,
                  date: todayDate,
                  reason: dto.reason?.trim() ?? null,
                  client_tx_id: `${clientTxId}:fee`,
                },
              });

              const feeReversalResp = toTransactionResponse(feeReversal);
              await tx.transactionAudit.create({
                data: {
                  transaction_id: feeTx.id,
                  action: 'REVERSE',
                  before: toTransactionResponse(feeTx) as unknown as Prisma.InputJsonValue,
                  after: {
                    ...toTransactionResponse(feeTx),
                    status: 'REVERSED',
                    reversal_id: feeReversal.id,
                  } as unknown as Prisma.InputJsonValue,
                  actor_user_id: user.userId,
                  reason: dto.reason?.trim() ?? null,
                },
              });
              await tx.transactionAudit.create({
                data: {
                  transaction_id: feeReversal.id,
                  action: 'CREATE',
                  before: Prisma.DbNull,
                  after: feeReversalResp as unknown as Prisma.InputJsonValue,
                  actor_user_id: user.userId,
                  reason: dto.reason?.trim() ?? null,
                },
              });
            }
          } else if (original.fee_mode === 'BUNDLED') {
            // Metode B: bundled fee
            const newFromBalance =
              fromAccount!.balance + original.amount + original.transfer_fee;
            await tx.account.update({
              where: { id: fromAccount!.id, user_id: user.userId },
              data: { balance: newFromBalance },
            });
            await tx.account.update({
              where: { id: toAccount!.id, user_id: user.userId },
              data: { balance: newToBalance },
            });
          } else {
            // Transfer biasa tanpa fee
            const newFromBalance = fromAccount!.balance + original.amount;
            await tx.account.update({
              where: { id: fromAccount!.id, user_id: user.userId },
              data: { balance: newFromBalance },
            });
            await tx.account.update({
              where: { id: toAccount!.id, user_id: user.userId },
              data: { balance: newToBalance },
            });
          }
        }

        // 4. Buat baris REVERSAL
        const reversalData: Prisma.TransactionUncheckedCreateInput = {
          user_id: user.userId,
          financial_profile_id: original.financial_profile_id,
          account_id: original.account_id,
          to_account_id: original.to_account_id ?? null,
          type: 'REVERSAL',
          status: 'POSTED',
          parent_transaction_id: original.id,
          amount: original.amount,
          category_id: original.category_id ?? null,
          transfer_group_id: original.transfer_group_id ?? null,
          transfer_fee:
            original.transfer_fee > 0n && original.fee_mode === 'BUNDLED'
              ? original.transfer_fee
              : 0n,
          fee_mode:
            original.transfer_fee > 0n && original.fee_mode === 'BUNDLED'
              ? 'BUNDLED'
              : null,
          date: todayDate,
          client_tx_id: clientTxId,
          reason: dto.reason?.trim() ?? null,
        };

        const reversal = await tx.transaction.create({
          data: reversalData,
        });

        // 5. Salin splits jika asli memiliki splits
        let createdSplits: Array<{ id: string; category_id: string; amount: bigint }> = [];
        if (originalSplits.length > 0) {
          createdSplits = originalSplits.map((s) => ({
            id: randomUUID(),
            category_id: s.category_id,
            amount: s.amount,
          }));
          await tx.transactionSplit.createMany({
            data: createdSplits.map((s) => ({
              id: s.id,
              transaction_id: reversal.id,
              category_id: s.category_id,
              amount: s.amount,
            })),
          });
        }

        // 6. Update status transaksi asli menjadi REVERSED
        const updatedOriginal = await tx.transaction.update({
          where: { id: original.id, user_id: user.userId },
          data: { status: 'REVERSED' },
        });

        // 7. Buat TransactionAudit
        const originalResp = toTransactionResponse({
          ...original,
          splits: originalSplits,
        });
        const updatedOriginalResp = toTransactionResponse({
          ...updatedOriginal,
          splits: originalSplits,
        });
        const reversalResp = toTransactionResponse(
          {
            ...reversal,
            splits: createdSplits,
          },
          warning,
        );

        await tx.transactionAudit.create({
          data: {
            transaction_id: original.id,
            action: 'REVERSE',
            before: originalResp as unknown as Prisma.InputJsonValue,
            after: {
              ...updatedOriginalResp,
              status: 'REVERSED',
              reversal_id: reversal.id,
            } as unknown as Prisma.InputJsonValue,
            actor_user_id: user.userId,
            reason: dto.reason?.trim() ?? null,
          },
        });

        await tx.transactionAudit.create({
          data: {
            transaction_id: reversal.id,
            action: 'CREATE',
            before: Prisma.DbNull,
            after: reversalResp as unknown as Prisma.InputJsonValue,
            actor_user_id: user.userId,
            reason: dto.reason?.trim() ?? null,
          },
        });

        return {
          reversal_id: reversal.id,
          transaction: reversalResp,
          ...(warning ? { warning } : {}),
        };
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

  private isLockNotAvailable(err: any): boolean {
    if (!err) return false;
    if (err.code === '55P03') return true;
    if (err.meta?.code === '55P03') return true;
    const metaMsg = typeof err.meta?.message === 'string' ? err.meta.message : '';
    if (metaMsg.includes('55P03') || metaMsg.includes('could not obtain lock')) return true;
    const msg = typeof err.message === 'string' ? err.message : '';
    return msg.includes('55P03') || msg.includes('could not obtain lock');
  }

  async cancel(
    user: { userId: string; role?: string },
    transactionId: string,
    dto: CancelTransactionDto,
    headerIdempotencyKey?: string,
  ): Promise<{
    id: string;
    status: 'CANCELLED';
    cancelled_at: Date;
  }> {
    resolveClientTxId(dto?.client_tx_id, headerIdempotencyKey);

    const now = new Date();

    try {
      return await this.prisma.$transaction(async (tx) => {
        let rows: Array<{
          id: string;
          status: string;
          transfer_group_id: string | null;
          reason: string | null;
        }>;

        try {
          rows = await tx.$queryRaw<
            Array<{
              id: string;
              status: string;
              transfer_group_id: string | null;
              reason: string | null;
            }>
          >`SELECT id, status, transfer_group_id, reason FROM transactions WHERE id = ${transactionId}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE NOWAIT`;
        } catch (rawError: any) {
          if (this.isLockNotAvailable(rawError)) {
            throw new ConflictException({
              code: 'RACE_CONDITION',
              message: 'Transaksi sedang diproses oleh sistem',
            });
          }
          throw rawError;
        }

        const row = rows[0];
        if (!row) {
          throw new NotFoundException({
            code: 'TRANSACTION_NOT_FOUND',
            message: 'Transaksi tidak ditemukan',
          });
        }

        if (row.status !== 'SCHEDULED') {
          throw new ConflictException({
            code: 'NOT_SCHEDULED',
            message:
              'Hanya transaksi terjadwal (SCHEDULED) yang dapat dibatalkan',
          });
        }

        const mainReason = dto?.reason?.trim() ? dto.reason.trim() : row.reason;

        await tx.transaction.update({
          where: { id: row.id, user_id: user.userId },
          data: {
            status: 'CANCELLED',
            cancelled_at: now,
            reason: mainReason,
          },
        });

        await tx.transactionAudit.create({
          data: {
            transaction_id: row.id,
            action: 'CANCEL',
            before: { status: 'SCHEDULED' },
            after: { status: 'CANCELLED', cancelled_at: now },
            actor_user_id: user.userId,
            reason: dto?.reason?.trim() ?? null,
          },
        });

        if (row.transfer_group_id) {
          let partners: Array<{
            id: string;
            status: string;
            reason: string | null;
          }>;

          try {
            partners = await tx.$queryRaw<
              Array<{
                id: string;
                status: string;
                reason: string | null;
              }>
            >`SELECT id, status, reason FROM transactions WHERE transfer_group_id = ${row.transfer_group_id}::uuid AND user_id = ${user.userId}::uuid AND id != ${row.id}::uuid FOR UPDATE NOWAIT`;
          } catch (partnerError: any) {
            if (this.isLockNotAvailable(partnerError)) {
              throw new ConflictException({
                code: 'RACE_CONDITION',
                message: 'Transaksi sedang diproses oleh sistem',
              });
            }
            throw partnerError;
          }

          for (const partner of partners) {
            if (partner.status === 'SCHEDULED') {
              const partnerReason = dto?.reason?.trim()
                ? dto.reason.trim()
                : partner.reason;

              await tx.transaction.update({
                where: { id: partner.id, user_id: user.userId },
                data: {
                  status: 'CANCELLED',
                  cancelled_at: now,
                  reason: partnerReason,
                },
              });

              await tx.transactionAudit.create({
                data: {
                  transaction_id: partner.id,
                  action: 'CANCEL',
                  before: { status: 'SCHEDULED' },
                  after: { status: 'CANCELLED', cancelled_at: now },
                  actor_user_id: user.userId,
                  reason: dto?.reason?.trim() ?? null,
                },
              });
            }
          }
        }

        return {
          id: row.id,
          status: 'CANCELLED',
          cancelled_at: now,
        };
      });
    } catch (err: any) {
      if (this.isLockNotAvailable(err)) {
        throw new ConflictException({
          code: 'RACE_CONDITION',
          message: 'Transaksi sedang diproses oleh sistem',
        });
      }
      throw err;
    }
  }
}
