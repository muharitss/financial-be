import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Logger } from '@nestjs/common';
import {
  BudgetRolloverService,
  computeCarryoverAmount,
} from './budget-rollover.service.js';

describe('BudgetRolloverService & computeCarryoverAmount', () => {
  describe('computeCarryoverAmount', () => {
    it('AC-1: menghitung sisa underspend kategori aktif dengan benar', () => {
      const result = computeCarryoverAmount({
        type: 'CATEGORY',
        rolloverEnabled: true,
        baseAmount: 1_000_000n,
        prevCarryover: 0n,
        spent: 650_000n,
      });
      expect(result).toBe(350_000n);
    });

    it('AC-2: overspend tidak pernah menghasilkan angka negatif (ADR-016 §4)', () => {
      const result = computeCarryoverAmount({
        type: 'CATEGORY',
        rolloverEnabled: true,
        baseAmount: 1_000_000n,
        prevCarryover: 0n,
        spent: 1_250_000n,
      });
      expect(result).toBe(0n);
    });

    it('AC-3: batas 1 bulan tanpa akumulasi berantai (ADR-016 §5)', () => {
      // Skenario A: base = 1jt, carryover = 350k, spent = 0 -> carryover dibatasi 1jt (bukan 1.350k)
      const resA = computeCarryoverAmount({
        type: 'CATEGORY',
        rolloverEnabled: true,
        baseAmount: 1_000_000n,
        prevCarryover: 350_000n,
        spent: 0n,
      });
      expect(resA).toBe(1_000_000n);

      // Skenario B: base = 1jt, carryover = 350k, spent = 1.150k -> sisa 200k (<= 1jt) di-rollover
      const resB = computeCarryoverAmount({
        type: 'CATEGORY',
        rolloverEnabled: true,
        baseAmount: 1_000_000n,
        prevCarryover: 350_000n,
        spent: 1_150_000n,
      });
      expect(resB).toBe(200_000n);
    });

    it('AC-4: budget TOTAL dan CATEGORY nonaktif selalu menghasilkan carryover 0 (ADR-016 §1–§2)', () => {
      const resTotal = computeCarryoverAmount({
        type: 'TOTAL',
        rolloverEnabled: false,
        baseAmount: 5_000_000n,
        prevCarryover: 0n,
        spent: 2_000_000n,
      });
      expect(resTotal).toBe(0n);

      const resDisabledCat = computeCarryoverAmount({
        type: 'CATEGORY',
        rolloverEnabled: false,
        baseAmount: 1_000_000n,
        prevCarryover: 0n,
        spent: 300_000n,
      });
      expect(resDisabledCat).toBe(0n);
    });

    it('pengeluaran tepat sama dengan budget efektif menghasilkan 0', () => {
      const result = computeCarryoverAmount({
        type: 'CATEGORY',
        rolloverEnabled: true,
        baseAmount: 1_000_000n,
        prevCarryover: 200_000n,
        spent: 1_200_000n,
      });
      expect(result).toBe(0n);
    });
  });

  describe('BudgetRolloverService', () => {
    let service: BudgetRolloverService;
    let mockPrisma: any;
    let mockBudgetsService: any;
    let mockBudgetPeriodLockService: any;

    beforeEach(() => {
      mockPrisma = {
        asSystem: jest.fn().mockReturnThis(),
        $queryRaw: jest.fn(),
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
        userPreference: {
          findFirst: jest.fn().mockResolvedValue({ timezone: 'Asia/Jakarta' }),
        },
        budget: {
          findMany: jest.fn(),
        },
        budgetPeriod: {
          findFirst: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        },
        budgetCategory: {
          create: jest.fn(),
          updateMany: jest.fn(),
        },
        rolloverConfig: {
          create: jest.fn(),
          upsert: jest.fn(),
        },
      };

      mockBudgetsService = {
        computeUsageForPeriod: jest.fn(),
      };

      mockBudgetPeriodLockService = {
        lockPeriodInTx: jest.fn().mockResolvedValue(true),
        lockExpiredPeriodsForUser: jest.fn().mockResolvedValue({ lockedCount: 1 }),
      };

      service = new BudgetRolloverService(
        mockPrisma,
        mockBudgetsService,
        mockBudgetPeriodLockService,
      );
    });

    describe('runDailyMonthTurnCheck', () => {
      it('melewati eksekusi jika gagal memperoleh pg advisory lock', async () => {
        mockPrisma.$queryRaw.mockResolvedValueOnce([{ pg_try_advisory_lock: false }]);

        const res = await service.runDailyMonthTurnCheck();
        expect(res).toEqual({ processedCount: 0, skippedCount: 0, errors: 0 });
        expect(mockPrisma.budget.findMany).not.toHaveBeenCalled();
      });

      it('menjalankan proses pergantian bulan jika lock didapat dan selalu melepas lock di finally', async () => {
        mockPrisma.$queryRaw
          .mockResolvedValueOnce([{ pg_try_advisory_lock: true }])
          .mockResolvedValueOnce([]); // pg_advisory_unlock

        mockPrisma.budget.findMany.mockResolvedValueOnce([
          { user_id: 'user-1' },
        ]);

        const processSpy = jest.spyOn(service, 'processMonthTurnForUser').mockResolvedValueOnce({
          processedCount: 1,
          skippedCount: 0,
          errors: 0,
        });

        const res = await service.runDailyMonthTurnCheck();
        expect(res).toEqual({ processedCount: 1, skippedCount: 0, errors: 0 });
        expect(processSpy).toHaveBeenCalledWith('user-1', expect.any(Date));
        // Verify unlock called
        expect(mockPrisma.$queryRaw).toHaveBeenCalledWith(
          expect.arrayContaining([expect.stringContaining('pg_advisory_unlock')]),
        );
      });

      it('mengisolasi error per user tanpa menghentikan user berikutnya', async () => {
        mockPrisma.$queryRaw
          .mockResolvedValueOnce([{ pg_try_advisory_lock: true }])
          .mockResolvedValueOnce([]);

        mockPrisma.budget.findMany.mockResolvedValueOnce([
          { user_id: 'user-error' },
          { user_id: 'user-success' },
        ]);

        jest
          .spyOn(service, 'processMonthTurnForUser')
          .mockRejectedValueOnce(new Error('DB failure'))
          .mockResolvedValueOnce({ processedCount: 1, skippedCount: 0, errors: 0 });

        const res = await service.runDailyMonthTurnCheck();
        expect(res).toEqual({ processedCount: 1, skippedCount: 0, errors: 1 });
      });
    });

    describe('processMonthTurnForUser', () => {
      it('AC-1: memproses rollover CATEGORY underspend, mengunci periode lama & membuat periode baru', async () => {
        // Set fixed now: 2026-11-01T00:10:00.000Z
        const now = new Date('2026-11-01T00:10:00.000Z');

        mockPrisma.budget.findMany.mockResolvedValueOnce([
          {
            id: 'budget-1',
            user_id: 'user-1',
            type: 'CATEGORY',
            category_id: 'cat-1',
            periods: [
              {
                id: 'bp-prev',
                period: '2026-10',
                base_amount: 1_000_000n,
                carryover_amount: 0n,
                locked_at: null,
                categories: [
                  {
                    id: 'bc-prev',
                    category_id: 'cat-1',
                    amount: 1_000_000n,
                    rollover_enabled: true,
                    rollover_config: { id: 'rc-1' },
                  },
                ],
              },
            ],
          },
        ]);

        // FOR UPDATE SKIP LOCKED row check
        mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'bp-prev' }]);

        // Usage calculation: spent = 650.000
        mockBudgetsService.computeUsageForPeriod.mockResolvedValueOnce({
          category_budgets: [{ id: 'budget-1', spent_amount: 650_000 }],
        });

        // No existing current period
        mockPrisma.budgetPeriod.findFirst.mockResolvedValueOnce(null);
        mockPrisma.budgetPeriod.create.mockResolvedValueOnce({ id: 'bp-current' });
        mockPrisma.budgetCategory.create.mockResolvedValueOnce({ id: 'bc-current' });

        const res = await service.processMonthTurnForUser('user-1', now);
        expect(res).toEqual({ processedCount: 1, skippedCount: 0, errors: 0 });

        // Verify rolloverConfig upsert
        expect(mockPrisma.rolloverConfig.upsert).toHaveBeenCalledWith({
          where: { budget_category_id: 'bc-prev' },
          create: {
            budget_category_id: 'bc-prev',
            enabled: true,
            last_computed_carryover: 350_000n,
            last_computed_at: now,
          },
          update: {
            last_computed_carryover: 350_000n,
            last_computed_at: now,
          },
        });

        // Verify BudgetPeriod creation with carryover = 350_000n
        expect(mockPrisma.budgetPeriod.create).toHaveBeenCalledWith({
          data: {
            budget_id: 'budget-1',
            period: '2026-11',
            base_amount: 1_000_000n,
            carryover_amount: 350_000n,
          },
        });

        // Verify budgetCategory & rolloverConfig creation
        expect(mockPrisma.budgetCategory.create).toHaveBeenCalledWith({
          data: {
            budget_period_id: 'bp-current',
            category_id: 'cat-1',
            amount: 1_000_000n,
            rollover_enabled: true,
            carryover_amount: 350_000n,
          },
        });

        // Verify lockPeriodInTx called
        expect(mockBudgetPeriodLockService.lockPeriodInTx).toHaveBeenCalledWith(
          expect.anything(),
          'bp-prev',
          'user-1',
          now,
        );
      });

      it('AC-1b: memperbarui carryover_amount pada BudgetPeriod berjalan jika sudah dibuat lebih awal', async () => {
        const now = new Date('2026-11-01T00:10:00.000Z');

        mockPrisma.budget.findMany.mockResolvedValueOnce([
          {
            id: 'budget-1',
            user_id: 'user-1',
            type: 'CATEGORY',
            category_id: 'cat-1',
            periods: [
              {
                id: 'bp-prev',
                period: '2026-10',
                base_amount: 1_000_000n,
                carryover_amount: 0n,
                locked_at: null,
                categories: [
                  {
                    id: 'bc-prev',
                    category_id: 'cat-1',
                    amount: 1_000_000n,
                    rollover_enabled: true,
                  },
                ],
              },
            ],
          },
        ]);

        mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'bp-prev' }]);
        mockBudgetsService.computeUsageForPeriod.mockResolvedValueOnce({
          category_budgets: [{ id: 'budget-1', spent_amount: 650_000 }],
        });

        // Existing current period created by user with locked_at = null
        mockPrisma.budgetPeriod.findFirst.mockResolvedValueOnce({
          id: 'bp-current-existing',
          period: '2026-11',
          base_amount: 1_200_000n,
          locked_at: null,
        });

        const res = await service.processMonthTurnForUser('user-1', now);
        expect(res).toEqual({ processedCount: 1, skippedCount: 0, errors: 0 });

        // Did NOT call create, but update with carryover_amount
        expect(mockPrisma.budgetPeriod.create).not.toHaveBeenCalled();
        expect(mockPrisma.budgetPeriod.update).toHaveBeenCalledWith({
          where: { id: 'bp-current-existing' },
          data: { carryover_amount: 350_000n },
        });
        expect(mockPrisma.budgetCategory.updateMany).toHaveBeenCalledWith({
          where: { budget_period_id: 'bp-current-existing' },
          data: { carryover_amount: 350_000n },
        });
      });

      it('AC-6: menerbitkan logger.warn jika eksekusi rollover lag >= 24 jam (tanggal >= 02) tanpa bocor nominal', async () => {
        // Now on 2nd of November
        const now = new Date('2026-11-02T10:00:00.000Z');

        mockPrisma.budget.findMany.mockResolvedValueOnce([
          {
            id: 'budget-lag-1',
            user_id: 'user-1',
            type: 'CATEGORY',
            category_id: 'cat-1',
            periods: [
              {
                id: 'bp-prev',
                period: '2026-10',
                base_amount: 1_000_000n,
                carryover_amount: 0n,
                locked_at: null,
                categories: [{ id: 'bc-1', rollover_enabled: true }],
              },
            ],
          },
        ]);

        mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'bp-prev' }]);
        mockBudgetsService.computeUsageForPeriod.mockResolvedValueOnce({
          category_budgets: [{ id: 'budget-lag-1', spent_amount: 500_000 }],
        });
        mockPrisma.budgetPeriod.findFirst.mockResolvedValueOnce(null);
        mockPrisma.budgetPeriod.create.mockResolvedValueOnce({ id: 'bp-lag-new' });
        mockPrisma.budgetCategory.create.mockResolvedValueOnce({ id: 'bc-lag-new' });

        const warnSpy = jest.spyOn(Logger.prototype, 'warn');

        await service.processMonthTurnForUser('user-1', now);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Budget rollover lag > 24h detected for budget budget-lag-1, period 2026-10'),
        );
        // Ensure no money amount in logged message
        for (const call of warnSpy.mock.calls) {
          expect(String(call[0])).not.toMatch(/500|1000|1\.000/);
        }
      });

      it('langsung mengunci periode tua (> 1 bulan) tanpa carryover (ADR-016 §5)', async () => {
        const now = new Date('2026-11-01T00:10:00.000Z');

        mockPrisma.budget.findMany.mockResolvedValueOnce([
          {
            id: 'budget-1',
            user_id: 'user-1',
            type: 'CATEGORY',
            periods: [
              {
                id: 'bp-very-old',
                period: '2026-08',
                base_amount: 1_000_000n,
                carryover_amount: 0n,
                locked_at: null,
                categories: [],
              },
            ],
          },
        ]);

        const res = await service.processMonthTurnForUser('user-1', now);
        expect(res).toEqual({ processedCount: 1, skippedCount: 0, errors: 0 });

        // Locked directly without computing carryover
        expect(mockBudgetsService.computeUsageForPeriod).not.toHaveBeenCalled();
        expect(mockBudgetPeriodLockService.lockPeriodInTx).toHaveBeenCalledWith(
          expect.anything(),
          'bp-very-old',
          'user-1',
          now,
        );
      });

      it('AC-5: idempoten dan melewati baris jika baris sedang/sudah dikunci oleh worker lain', async () => {
        const now = new Date('2026-11-01T00:10:00.000Z');

        mockPrisma.budget.findMany.mockResolvedValueOnce([
          {
            id: 'budget-1',
            user_id: 'user-1',
            type: 'CATEGORY',
            periods: [
              {
                id: 'bp-concurrent',
                period: '2026-10',
                base_amount: 1_000_000n,
                carryover_amount: 0n,
                locked_at: null,
                categories: [],
              },
            ],
          },
        ]);

        // FOR UPDATE SKIP LOCKED returns empty array (already locked)
        mockPrisma.$queryRaw.mockResolvedValueOnce([]);

        const res = await service.processMonthTurnForUser('user-1', now);
        expect(res).toEqual({ processedCount: 0, skippedCount: 1, errors: 0 });
        expect(mockBudgetsService.computeUsageForPeriod).not.toHaveBeenCalled();
      });
    });
  });
});
