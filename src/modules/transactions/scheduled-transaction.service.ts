import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { todayInTz } from '../../common/utils/date.js';
import { getAccountReserved } from './transactions.service.js';
import { BudgetWarningService } from '../budgets/budget-warning.service.js';

@Injectable()
export class ScheduledTransactionService {
  private readonly logger = new Logger(ScheduledTransactionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly budgetWarningService?: BudgetWarningService,
  ) {}

  @Cron('5 0 * * *', { timeZone: 'Asia/Jakarta' })
  async runDailyScheduledPosting(): Promise<{
    processedCount: number;
    skippedCount: number;
    errors: number;
  }> {
    const lockRows = await this.prisma.asSystem().$queryRaw<
      Array<{ pg_try_advisory_lock: boolean }>
    >`SELECT pg_try_advisory_lock(4045001)`;

    const acquired = lockRows[0]?.pg_try_advisory_lock;
    if (!acquired) {
      this.logger.log('Daily scheduled posting already running on another instance, skipping');
      return { processedCount: 0, skippedCount: 0, errors: 0 };
    }

    try {
      this.logger.log('Starting daily scheduled posting job...');
      const jobRunId = randomUUID();

      const scheduledTxs = await this.prisma.asSystem().transaction.findMany({
        where: {
          status: 'SCHEDULED',
          processed_at: null,
        },
        select: {
          id: true,
          user_id: true,
          date: true,
        },
        orderBy: { date: 'asc' },
      });

      const userTimezones = new Map<string, string>();
      let processedCount = 0;
      let skippedCount = 0;
      let errors = 0;

      for (const tx of scheduledTxs) {
        let tz = userTimezones.get(tx.user_id);
        if (!tz) {
          const pref = await this.prisma.asSystem().userPreference.findFirst({
            where: { user_id: tx.user_id },
          });
          tz = pref?.timezone ?? 'Asia/Jakarta';
          userTimezones.set(tx.user_id, tz);
        }

        const today = todayInTz(tz);
        const txDateStr =
          tx.date instanceof Date
            ? tx.date.toISOString().slice(0, 10)
            : String(tx.date).slice(0, 10);

        if (txDateStr > today) {
          skippedCount++;
          continue;
        }

        try {
          const ok = await this.postSingleScheduledTransaction(tx.id, jobRunId);
          if (ok) {
            processedCount++;
          } else {
            skippedCount++;
          }
        } catch (err: any) {
          errors++;
          this.logger.error(`Error posting scheduled transaction ${tx.id}: ${err.message}`);
        }
      }

      this.logger.log(
        `Daily scheduled posting completed. Processed: ${processedCount}, Skipped: ${skippedCount}, Errors: ${errors}`,
      );
      return { processedCount, skippedCount, errors };
    } finally {
      await this.prisma.asSystem().$queryRaw`SELECT pg_advisory_unlock(4045001)`;
    }
  }

  async processDueForUser(userId: string): Promise<{
    processedCount: number;
    skippedCount: number;
    errors: number;
  }> {
    const pref = await this.prisma.asSystem().userPreference.findFirst({
      where: { user_id: userId },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const today = todayInTz(tz);
    const todayDate = new Date(`${today}T00:00:00.000Z`);

    const candidateTxs = await this.prisma.asSystem().transaction.findMany({
      where: {
        user_id: userId,
        status: 'SCHEDULED',
        processed_at: null,
        date: { lte: todayDate },
      },
      select: { id: true },
      orderBy: { date: 'asc' },
    });

    const jobRunId = randomUUID();
    let processedCount = 0;
    let skippedCount = 0;
    let errors = 0;

    for (const tx of candidateTxs) {
      try {
        const ok = await this.postSingleScheduledTransaction(tx.id, jobRunId);
        if (ok) {
          processedCount++;
        } else {
          skippedCount++;
        }
      } catch (err: any) {
        errors++;
        this.logger.error(`Error processing scheduled transaction ${tx.id} for user ${userId}: ${err.message}`);
      }
    }

    return { processedCount, skippedCount, errors };
  }

  async postSingleScheduledTransaction(
    txId: string,
    jobRunId: string,
  ): Promise<boolean> {
    const warningContext: { userId?: string; period?: string } = {};

    const posted = await this.prisma.asSystem().$transaction(async (tx) => {
      // 1. Lock baris transactions dengan FOR UPDATE SKIP LOCKED
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          user_id: string;
          account_id: string;
          to_account_id: string | null;
          type: string;
          amount: bigint;
          date: Date;
          transfer_fee: bigint;
          fee_mode: string | null;
          transfer_group_id: string | null;
          status: string;
          processed_at: Date | null;
        }>
      >`SELECT id, user_id, account_id, to_account_id, type, amount, date, transfer_fee, fee_mode, transfer_group_id, status, processed_at FROM transactions WHERE id = ${txId}::uuid AND status = 'SCHEDULED' AND processed_at IS NULL FOR UPDATE SKIP LOCKED`;

      const row = rows[0];
      if (!row || row.status !== 'SCHEDULED' || row.processed_at !== null) {
        return false;
      }

      if (
        row.type === 'EXPENSE' ||
        (row.type === 'TRANSFER' && row.fee_mode === 'SEPARATE' && row.transfer_fee > 0n)
      ) {
        warningContext.userId = row.user_id;
        if (row.date) {
          warningContext.period =
            typeof row.date === 'string'
              ? (row.date as string).slice(0, 7)
              : (row.date as Date).toISOString().slice(0, 7);
        }
      }

      // Jika baris EXPENSE merupakan bagian dari transfer group, biarkan baris TRANSFER yang memprosesnya
      if (row.type === 'EXPENSE' && row.transfer_group_id) {
        const transferRows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT id, status FROM transactions
          WHERE transfer_group_id = ${row.transfer_group_id}::uuid
            AND type = 'TRANSFER'
        `;
        const transfer = transferRows[0];
        if (!transfer || transfer.status === 'SCHEDULED') {
          return false;
        }
        if (transfer.status === 'POSTED') {
          // Saldo sumber sudah dipotong saat baris TRANSFER diposting.
          // Cukup update status EXPENSE menjadi POSTED tanpa memotong saldo lagi.
          const now = new Date();
          await tx.transaction.update({
            where: { id: row.id },
            data: {
              status: 'POSTED',
              processed_at: now,
              job_run_id: jobRunId,
            },
          });
          await tx.transactionAudit.create({
            data: {
              transaction_id: row.id,
              action: 'UPDATE',
              before: { status: 'SCHEDULED', processed_at: null },
              after: { status: 'POSTED', processed_at: now, job_run_id: jobRunId },
              actor_user_id: row.user_id,
              reason: 'Auto-posted scheduled transaction',
            },
          });
          return true;
        }
        return false;
      }

      // 2. Lock akun terkait (ORDER BY id ASC FOR UPDATE)
      const accountIds = [row.account_id];
      if (row.to_account_id && row.to_account_id !== row.account_id) {
        accountIds.push(row.to_account_id);
      }

      const accounts = await tx.$queryRaw<
        Array<{
          id: string;
          balance: bigint;
          allow_negative: boolean;
          archived: boolean;
        }>
      >`SELECT id, balance, allow_negative, archived FROM accounts WHERE id IN (${Prisma.join(accountIds.map((id) => Prisma.sql`${id}::uuid`))}) AND user_id = ${row.user_id}::uuid ORDER BY id ASC FOR UPDATE`;

      const sourceAccount = accounts.find((a) => a.id === row.account_id);
      if (!sourceAccount || sourceAccount.archived) {
        return false;
      }

      const destAccount = row.to_account_id
        ? accounts.find((a) => a.id === row.to_account_id)
        : null;
      if (row.to_account_id && (!destAccount || destAccount.archived)) {
        return false;
      }

      const now = new Date();

      if (row.type === 'INCOME') {
        const newBalance = sourceAccount.balance + row.amount;
        await tx.account.update({
          where: { id: sourceAccount.id, user_id: row.user_id },
          data: { balance: newBalance },
        });

        await tx.transaction.update({
          where: { id: row.id },
          data: {
            status: 'POSTED',
            processed_at: now,
            job_run_id: jobRunId,
          },
        });

        await tx.transactionAudit.create({
          data: {
            transaction_id: row.id,
            action: 'UPDATE',
            before: { status: 'SCHEDULED', processed_at: null },
            after: { status: 'POSTED', processed_at: now, job_run_id: jobRunId },
            actor_user_id: row.user_id,
            reason: 'Auto-posted scheduled transaction',
          },
        });

        return true;
      }

      if (row.type === 'EXPENSE') {
        const reserved = await getAccountReserved(tx, sourceAccount.id);
        const available = sourceAccount.balance - reserved;
        const needed = row.amount;

        if (
          !sourceAccount.allow_negative &&
          (needed > available || sourceAccount.balance - needed < 0n)
        ) {
          this.logger.warn(`Scheduled expense transaction ${row.id} skipped due to insufficient balance`);
          return false;
        }

        const newBalance = sourceAccount.balance - needed;
        await tx.account.update({
          where: { id: sourceAccount.id, user_id: row.user_id },
          data: { balance: newBalance },
        });

        await tx.transaction.update({
          where: { id: row.id },
          data: {
            status: 'POSTED',
            processed_at: now,
            job_run_id: jobRunId,
          },
        });

        await tx.transactionAudit.create({
          data: {
            transaction_id: row.id,
            action: 'UPDATE',
            before: { status: 'SCHEDULED', processed_at: null },
            after: { status: 'POSTED', processed_at: now, job_run_id: jobRunId },
            actor_user_id: row.user_id,
            reason: 'Auto-posted scheduled transaction',
          },
        });

        return true;
      }

      if (row.type === 'TRANSFER' && destAccount) {
        const isSeparate = row.fee_mode === 'SEPARATE' && row.transfer_fee > 0n;
        const isBundled = row.fee_mode === 'BUNDLED' && row.transfer_fee > 0n;

        let feeExpenseRow: { id: string } | null = null;
        if (isSeparate && row.transfer_group_id) {
          const feeRows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM transactions
            WHERE transfer_group_id = ${row.transfer_group_id}::uuid
              AND type = 'EXPENSE'
              AND status = 'SCHEDULED'
              AND processed_at IS NULL
            FOR UPDATE
          `;
          feeExpenseRow = feeRows[0] ?? null;
          if (!feeExpenseRow) {
            // Pasangan fee tidak ditemukan atau sedang diproses; tunda posting transfer ini
            return false;
          }
        }

        const totalOut = isSeparate || isBundled
          ? row.amount + row.transfer_fee
          : row.amount;
        const amountReceived = row.amount;

        const reserved = await getAccountReserved(tx, sourceAccount.id);
        const available = sourceAccount.balance - reserved;

        if (
          !sourceAccount.allow_negative &&
          (totalOut > available || sourceAccount.balance - totalOut < 0n)
        ) {
          this.logger.warn(`Scheduled transfer transaction ${row.id} skipped due to insufficient balance`);
          return false;
        }

        const newSourceBalance = sourceAccount.balance - totalOut;
        const newDestBalance = destAccount.balance + amountReceived;

        await tx.account.update({
          where: { id: sourceAccount.id, user_id: row.user_id },
          data: { balance: newSourceBalance },
        });

        await tx.account.update({
          where: { id: destAccount.id, user_id: row.user_id },
          data: { balance: newDestBalance },
        });

        await tx.transaction.update({
          where: { id: row.id },
          data: {
            status: 'POSTED',
            processed_at: now,
            job_run_id: jobRunId,
          },
        });

        await tx.transactionAudit.create({
          data: {
            transaction_id: row.id,
            action: 'UPDATE',
            before: { status: 'SCHEDULED', processed_at: null },
            after: { status: 'POSTED', processed_at: now, job_run_id: jobRunId },
            actor_user_id: row.user_id,
            reason: 'Auto-posted scheduled transaction',
          },
        });

        if (feeExpenseRow) {
          await tx.transaction.update({
            where: { id: feeExpenseRow.id },
            data: {
              status: 'POSTED',
              processed_at: now,
              job_run_id: jobRunId,
            },
          });

          await tx.transactionAudit.create({
            data: {
              transaction_id: feeExpenseRow.id,
              action: 'UPDATE',
              before: { status: 'SCHEDULED', processed_at: null },
              after: { status: 'POSTED', processed_at: now, job_run_id: jobRunId },
              actor_user_id: row.user_id,
              reason: 'Auto-posted scheduled transaction',
            },
          });
        }

        return true;
      }

      return false;
    });

    if (posted && warningContext.userId && warningContext.period) {
      try {
        await this.budgetWarningService?.evaluateForPeriod(
          warningContext.userId,
          warningContext.period,
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to evaluate budget warnings for user ${warningContext.userId}: ${err.message}`,
        );
      }
    }

    return posted;
  }
}
