import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { BudgetPeriodLockService } from './budget-period-lock.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  currentPeriodInTz,
  previousPeriod,
  nextPeriod,
  periodDateRange,
} from '../../common/utils/date.js';

describe('BudgetPeriodLockService & Date Period Helpers', () => {
  describe('AC-1: Pure Period Helpers in date.ts', () => {
    it('calculates previousPeriod correctly including year rollover', () => {
      expect(previousPeriod('2027-01')).toBe('2026-12');
      expect(previousPeriod('2026-11')).toBe('2026-10');
      expect(previousPeriod('2026-05')).toBe('2026-04');
    });

    it('calculates nextPeriod correctly including year rollover', () => {
      expect(nextPeriod('2026-12')).toBe('2027-01');
      expect(nextPeriod('2026-10')).toBe('2026-11');
      expect(nextPeriod('2026-01')).toBe('2026-02');
    });

    it('computes currentPeriodInTz taking timezone into account', () => {
      // 2026-10-31 17:30 UTC is 2026-11-01 00:30 in Asia/Jakarta (+7)
      const date = new Date('2026-10-31T17:30:00.000Z');
      expect(currentPeriodInTz('Asia/Jakarta', date)).toBe('2026-11');
      // In UTC it is still 2026-10
      expect(currentPeriodInTz('UTC', date)).toBe('2026-10');
    });

    it('computes periodDateRange boundaries at UTC midnight', () => {
      const { startDate, nextMonthStart } = periodDateRange('2026-11');
      expect(startDate.toISOString()).toBe('2026-11-01T00:00:00.000Z');
      expect(nextMonthStart.toISOString()).toBe('2026-12-01T00:00:00.000Z');

      const decRange = periodDateRange('2026-12');
      expect(decRange.startDate.toISOString()).toBe('2026-12-01T00:00:00.000Z');
      expect(decRange.nextMonthStart.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });
  });

  describe('BudgetPeriodLockService', () => {
    let service: BudgetPeriodLockService;
    let prismaMock: any;

    const userId = '018f0000-0000-7000-8000-000000000001';
    const periodId = '018f0000-0000-7000-8000-000000000002';

    beforeEach(async () => {
      prismaMock = {
        asSystem: jest.fn().mockReturnThis(),
        userPreference: {
          findFirst: jest.fn(),
        },
        budgetPeriod: {
          findMany: jest.fn(),
          update: jest.fn(),
        },
        auditLog: {
          create: jest.fn(),
        },
        $queryRaw: jest.fn(),
        $transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => {
          return cb(prismaMock);
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BudgetPeriodLockService,
          { provide: PrismaService, useValue: prismaMock },
        ],
      }).compile();

      service = module.get<BudgetPeriodLockService>(BudgetPeriodLockService);
    });

    describe('lockPeriodInTx', () => {
      it('returns false if row is already locked or skipped by FOR UPDATE SKIP LOCKED', async () => {
        prismaMock.$queryRaw.mockResolvedValueOnce([]);

        const result = await service.lockPeriodInTx(
          prismaMock,
          periodId,
          userId,
          new Date('2026-11-01T00:10:00.000Z'),
        );

        expect(result).toBe(false);
        expect(prismaMock.budgetPeriod.update).not.toHaveBeenCalled();
        expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
      });

      it('locks row, updates locked_at, writes AuditLog, and returns true when row is available', async () => {
        const lockedAt = new Date('2026-11-01T00:10:00.000Z');
        prismaMock.$queryRaw.mockResolvedValueOnce([
          {
            id: periodId,
            budget_id: 'b-1',
            period: '2026-10',
            base_amount: 1000000n,
            carryover_amount: 250000n,
            locked_at: null,
          },
        ]);
        prismaMock.budgetPeriod.update.mockResolvedValueOnce({});
        prismaMock.auditLog.create.mockResolvedValueOnce({});

        const result = await service.lockPeriodInTx(
          prismaMock,
          periodId,
          userId,
          lockedAt,
        );

        expect(result).toBe(true);
        expect(prismaMock.budgetPeriod.update).toHaveBeenCalledWith({
          where: { id: periodId },
          data: { locked_at: lockedAt },
        });
        expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
          data: {
            action: 'BUDGET_PERIOD_LOCK',
            resource_type: 'budget_period',
            resource_id: periodId,
            actor_user_id: userId,
            actor_role: 'SYSTEM',
            before: { locked_at: null },
            after: {
              period: '2026-10',
              locked_at: lockedAt,
              carryover_amount: 250000,
            },
          },
        });
      });
    });

    describe('lockExpiredPeriodsForUser', () => {
      it('locks all expired periods strictly before current period for user timezone', async () => {
        const now = new Date('2026-11-01T00:30:00.000Z');
        prismaMock.userPreference.findFirst.mockResolvedValueOnce({
          timezone: 'Asia/Jakarta',
        });
        prismaMock.budgetPeriod.findMany.mockResolvedValueOnce([
          { id: 'bp-1' },
          { id: 'bp-2' },
        ]);

        // Mock lockPeriodInTx queries for both periods
        prismaMock.$queryRaw
          .mockResolvedValueOnce([
            {
              id: 'bp-1',
              budget_id: 'b-1',
              period: '2026-09',
              base_amount: 1000000n,
              carryover_amount: 0n,
              locked_at: null,
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'bp-2',
              budget_id: 'b-1',
              period: '2026-10',
              base_amount: 1000000n,
              carryover_amount: 100000n,
              locked_at: null,
            },
          ]);
        prismaMock.budgetPeriod.update.mockResolvedValue({});
        prismaMock.auditLog.create.mockResolvedValue({});

        const result = await service.lockExpiredPeriodsForUser(userId, now);

        expect(prismaMock.budgetPeriod.findMany).toHaveBeenCalledWith({
          where: {
            budget: { user_id: userId },
            period: { lt: '2026-11' },
            locked_at: null,
          },
          select: { id: true },
          orderBy: { period: 'asc' },
        });
        expect(result).toEqual({ lockedCount: 2 });
      });

      it('falls back to Asia/Jakarta if user has no timezone preference', async () => {
        const now = new Date('2026-11-01T00:30:00.000Z');
        prismaMock.userPreference.findFirst.mockResolvedValueOnce(null);
        prismaMock.budgetPeriod.findMany.mockResolvedValueOnce([]);

        const result = await service.lockExpiredPeriodsForUser(userId, now);

        expect(prismaMock.budgetPeriod.findMany).toHaveBeenCalledWith({
          where: {
            budget: { user_id: userId },
            period: { lt: '2026-11' },
            locked_at: null,
          },
          select: { id: true },
          orderBy: { period: 'asc' },
        });
        expect(result).toEqual({ lockedCount: 0 });
      });

      it('increments lockedCount only for rows successfully locked', async () => {
        const now = new Date('2026-11-01T00:30:00.000Z');
        prismaMock.userPreference.findFirst.mockResolvedValueOnce({
          timezone: 'Asia/Jakarta',
        });
        prismaMock.budgetPeriod.findMany.mockResolvedValueOnce([
          { id: 'bp-1' },
          { id: 'bp-2' },
        ]);

        // First locked successfully, second skipped locked by another worker
        prismaMock.$queryRaw
          .mockResolvedValueOnce([
            {
              id: 'bp-1',
              budget_id: 'b-1',
              period: '2026-09',
              base_amount: 1000000n,
              carryover_amount: 0n,
              locked_at: null,
            },
          ])
          .mockResolvedValueOnce([]); // Empty -> skipped
        prismaMock.budgetPeriod.update.mockResolvedValue({});
        prismaMock.auditLog.create.mockResolvedValue({});

        const result = await service.lockExpiredPeriodsForUser(userId, now);

        expect(result).toEqual({ lockedCount: 1 });
      });
    });
  });
});
