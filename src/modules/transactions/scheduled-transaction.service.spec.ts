import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ScheduledTransactionService } from './scheduled-transaction.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('ScheduledTransactionService', () => {
  let service: ScheduledTransactionService;
  let prisma: any;

  const userId = '11111111-1111-1111-1111-111111111111';
  const accountId = '22222222-2222-2222-2222-222222222222';
  const txId = '33333333-3333-3333-3333-333333333333';
  const jobRunId = '44444444-4444-4444-4444-444444444444';

  beforeEach(async () => {
    prisma = {
      userPreference: {
        findFirst: jest.fn<any>().mockResolvedValue({ timezone: 'Asia/Jakarta' }),
      },
      transaction: {
        findMany: jest.fn<any>(),
        update: jest.fn<any>(),
      },
      account: {
        update: jest.fn<any>(),
      },
      transactionAudit: {
        create: jest.fn<any>(),
      },
      savingsAllocation: {
        groupBy: jest.fn<any>().mockResolvedValue([]),
      },
      $queryRaw: jest.fn<any>(),
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
      asSystem: jest.fn(() => prisma),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTransactionService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ScheduledTransactionService>(ScheduledTransactionService);
  });

  describe('postSingleScheduledTransaction', () => {
    it('AC-1: memposting transaksi EXPENSE, mengurangi saldo akun, dan mencatat audit log', async () => {
      // 1. SELECT FOR UPDATE SKIP LOCKED
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: txId,
            user_id: userId,
            account_id: accountId,
            to_account_id: null,
            type: 'EXPENSE',
            amount: 40000n,
            transfer_fee: 0n,
            fee_mode: null,
            transfer_group_id: null,
            status: 'SCHEDULED',
            processed_at: null,
          },
        ])
        // 2. Lock accounts
        .mockResolvedValueOnce([
          {
            id: accountId,
            balance: 100000n,
            allow_negative: false,
            archived: false,
          },
        ]);

      const result = await service.postSingleScheduledTransaction(txId, jobRunId);

      expect(result).toBe(true);
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: accountId, user_id: userId },
        data: { balance: 60000n },
      });
      expect(prisma.transaction.update).toHaveBeenCalledWith({
        where: { id: txId },
        data: expect.objectContaining({
          status: 'POSTED',
          job_run_id: jobRunId,
        }),
      });
      expect(prisma.transactionAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          transaction_id: txId,
          action: 'UPDATE',
          before: { status: 'SCHEDULED', processed_at: null },
          after: expect.objectContaining({
            status: 'POSTED',
            job_run_id: jobRunId,
          }),
        }),
      });
    });

    it('AC-1: memposting transaksi INCOME dan menambah saldo akun', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: txId,
            user_id: userId,
            account_id: accountId,
            to_account_id: null,
            type: 'INCOME',
            amount: 50000n,
            transfer_fee: 0n,
            fee_mode: null,
            transfer_group_id: null,
            status: 'SCHEDULED',
            processed_at: null,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: accountId,
            balance: 100000n,
            allow_negative: false,
            archived: false,
          },
        ]);

      const result = await service.postSingleScheduledTransaction(txId, jobRunId);

      expect(result).toBe(true);
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: accountId, user_id: userId },
        data: { balance: 150000n },
      });
      expect(prisma.transaction.update).toHaveBeenCalledWith({
        where: { id: txId },
        data: expect.objectContaining({
          status: 'POSTED',
          job_run_id: jobRunId,
        }),
      });
    });

    it('AC-3: mengembalikan false jika baris transaksi sedang di-lock proses lain / sudah diproses (SKIP LOCKED)', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]); // Kosong karena SKIP LOCKED

      const result = await service.postSingleScheduledTransaction(txId, jobRunId);

      expect(result).toBe(false);
      expect(prisma.account.update).not.toHaveBeenCalled();
      expect(prisma.transaction.update).not.toHaveBeenCalled();
    });

    it('membatalkan posting dan mengembalikan false jika saldo tidak cukup (allow_negative = false)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: txId,
            user_id: userId,
            account_id: accountId,
            to_account_id: null,
            type: 'EXPENSE',
            amount: 150000n,
            transfer_fee: 0n,
            fee_mode: null,
            transfer_group_id: null,
            status: 'SCHEDULED',
            processed_at: null,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: accountId,
            balance: 100000n,
            allow_negative: false,
            archived: false,
          },
        ]);

      const result = await service.postSingleScheduledTransaction(txId, jobRunId);

      expect(result).toBe(false);
      expect(prisma.account.update).not.toHaveBeenCalled();
      expect(prisma.transaction.update).not.toHaveBeenCalled();
    });
  });

  describe('runDailyScheduledPosting', () => {
    it('AC-2: melewati transaksi yang date > today', async () => {
      // Advisory lock didapat
      prisma.$queryRaw
        .mockResolvedValueOnce([{ pg_try_advisory_lock: true }])
        .mockResolvedValueOnce([]); // unlock di finally

      prisma.transaction.findMany.mockResolvedValue([
        {
          id: txId,
          user_id: userId,
          date: '2099-12-31', // date > today
        },
      ]);

      const result = await service.runDailyScheduledPosting();

      expect(result.processedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('melewati eksekusi jika advisory lock tidak berhasil didapat (instance lain sedang jalan)', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ pg_try_advisory_lock: false }]);

      const result = await service.runDailyScheduledPosting();

      expect(result.processedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(prisma.transaction.findMany).not.toHaveBeenCalled();
    });
  });

  describe('processDueForUser', () => {
    it('memproses transaksi jatuh tempo untuk user tertentu', async () => {
      prisma.transaction.findMany.mockResolvedValue([{ id: txId }]);
      const spy = jest.spyOn(service, 'postSingleScheduledTransaction').mockResolvedValue(true);

      const result = await service.processDueForUser(userId);

      expect(result.processedCount).toBe(1);
      expect(spy).toHaveBeenCalledWith(
        txId,
        expect.any(String),
      );
    });
  });
});
