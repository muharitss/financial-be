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
import {
  resolveClientTxId,
  type CreateTransactionDto,
  type CreateIncomeDto,
  type CreateExpenseDto,
  type CreateTransferDto,
  type CreateAdjustmentDto,
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
        if (status === 'POSTED') {
          const reserved = await getAccountReserved(tx, account.id);
          const available = account.balance - reserved;
          const needed = BigInt(dto.amount);

          if (
            !account.allow_negative &&
            (needed > available || account.balance - needed < 0n)
          ) {
            throw new ConflictException({
              code: 'INSUFFICIENT_BALANCE',
              message: 'Saldo tersedia tidak mencukupi',
              details: {
                available: Number(available),
                needed: dto.amount,
                account_id: account.id,
              },
            });
          }
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
        let finalBalance = account.balance;
        if (status === 'POSTED') {
          finalBalance = account.balance - BigInt(dto.amount);
          await tx.account.update({
            where: { id: account.id, user_id: user.userId },
            data: { balance: finalBalance },
          });
        }

        let warning: string | undefined;
        if (status === 'POSTED' && finalBalance < 0n) {
          warning = 'NEGATIVE_BALANCE';
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
        if (status === 'POSTED') {
          const fromReserved = await getAccountReserved(tx, fromAccount.id);
          const fromAvailable = fromAccount.balance - fromReserved;

          if (
            !fromAccount.allow_negative &&
            (fromAccount.balance < 0n || totalOut > fromAvailable || fromAccount.balance - totalOut < 0n)
          ) {
            throw new ConflictException({
              code: 'INSUFFICIENT_BALANCE',
              message: 'Saldo tersedia tidak mencukupi',
              details: {
                available: Number(fromAvailable),
                needed: Number(totalOut),
                account_id: fromAccount.id,
              },
            });
          }
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
        let fromFinalBalance = fromAccount.balance;
        let toFinalBalance = toAccount.balance;

        if (status === 'POSTED') {
          fromFinalBalance = fromAccount.balance - totalOut;
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

        let warning: string | undefined;
        if (status === 'POSTED' && fromFinalBalance < 0n) {
          warning = 'NEGATIVE_BALANCE';
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

      // 2. Hitung newBalance = account.balance + BigInt(dto.amount)
      const newBalance = account.balance + BigInt(dto.amount);

      // 3. Cek saldo negatif
      const reserved = await getAccountReserved(tx, account.id);
      const available = account.balance - reserved;

      if (newBalance < 0n && !account.allow_negative) {
        throw new ConflictException({
          code: 'INSUFFICIENT_BALANCE',
          message:
            'Penyesuaian membuat saldo negatif pada akun yang tidak mengizinkannya',
          details: {
            available: Number(available),
            needed: Math.abs(dto.amount),
            account_id: account.id,
          },
        });
      }

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

      let warning: string | undefined;
      if (newBalance < 0n) {
        warning = 'NEGATIVE_BALANCE';
      }

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
}
