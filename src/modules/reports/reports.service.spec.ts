import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ReportsService } from './reports.service.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('ReportsService', () => {
  let service: ReportsService;
  let dashboardServiceMock: {
    resolveRange: jest.Mock;
    getSummary: jest.Mock;
    getCategoryBreakdown: jest.Mock;
  };
  let prismaMock: {
    userPreference: { findFirst: jest.Mock };
    account: { findMany: jest.Mock };
    transaction: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    dashboardServiceMock = {
      resolveRange: jest.fn() as any,
      getSummary: jest.fn() as any,
      getCategoryBreakdown: jest.fn() as any,
    };
    prismaMock = {
      userPreference: { findFirst: jest.fn() as any },
      account: { findMany: jest.fn() as any },
      transaction: { findMany: jest.fn() as any },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        {
          provide: DashboardService,
          useValue: dashboardServiceMock,
        },
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
  });

  describe('getBalanceChanges', () => {
    it('AC-3: computes opening, inflow, outflow, closing per account and satisfies closing - opening === inflow - outflow', async () => {
      dashboardServiceMock.resolveRange.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
      });

      prismaMock.account.findMany.mockResolvedValue([
        {
          id: 'acc-1',
          name: 'BCA',
          type: 'BANK',
          opening_balance: 10_000_000n,
          opening_date: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'acc-2',
          name: 'Dompet',
          type: 'CASH',
          opening_balance: 500_000n,
          opening_date: new Date('2026-11-15T00:00:00.000Z'),
        },
      ]);

      prismaMock.transaction.findMany.mockResolvedValue([
        {
          id: 'tx-old',
          type: 'EXPENSE',
          amount: 200_000n,
          account_id: 'acc-1',
          to_account_id: null,
          transfer_fee: 0n,
          fee_mode: null,
          date: new Date('2026-10-15T00:00:00.000Z'),
          parent: null,
        },
        {
          id: 'tx-in-period-1',
          type: 'INCOME',
          amount: 5_000_000n,
          account_id: 'acc-1',
          to_account_id: null,
          transfer_fee: 0n,
          fee_mode: null,
          date: new Date('2026-11-05T00:00:00.000Z'),
          parent: null,
        },
        {
          id: 'tx-in-period-transfer',
          type: 'TRANSFER',
          amount: 1_000_000n,
          account_id: 'acc-1',
          to_account_id: 'acc-2',
          transfer_fee: 6_500n,
          fee_mode: 'SEPARATE',
          date: new Date('2026-11-10T00:00:00.000Z'),
          parent: null,
        },
      ]);

      const result = await service.getBalanceChanges('user-1', {
        from: '2026-11-01',
        to: '2026-11-30',
      });

      expect(result.from).toBe('2026-11-01');
      expect(result.to).toBe('2026-11-30');
      expect(result.items.length).toBe(2);

      const bca = result.items.find((i) => i.account_id === 'acc-1')!;
      expect(bca.opening).toBe(9_800_000);
      expect(bca.inflow).toBe(5_000_000);
      expect(bca.outflow).toBe(1_006_500);
      expect(bca.closing).toBe(9_800_000 + 5_000_000 - 1_006_500);
      expect(bca.closing - bca.opening).toBe(bca.inflow - bca.outflow);

      const dompet = result.items.find((i) => i.account_id === 'acc-2')!;
      expect(dompet.opening).toBe(0);
      expect(dompet.inflow).toBe(500_000 + 1_000_000);
      expect(dompet.outflow).toBe(0);
      expect(dompet.closing).toBe(1_500_000);
      expect(dompet.closing - dompet.opening).toBe(dompet.inflow - dompet.outflow);

      expect(result.totals.opening).toBe(bca.opening + dompet.opening);
      expect(result.totals.inflow).toBe(bca.inflow + dompet.inflow);
      expect(result.totals.outflow).toBe(bca.outflow + dompet.outflow);
      expect(result.totals.closing).toBe(bca.closing + dompet.closing);
      expect(result.totals.closing - result.totals.opening).toBe(
        result.totals.inflow - result.totals.outflow,
      );
    });

    it('handles REVERSAL transaction properly', async () => {
      dashboardServiceMock.resolveRange.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
      });

      prismaMock.account.findMany.mockResolvedValue([
        {
          id: 'acc-1',
          name: 'BCA',
          type: 'BANK',
          opening_balance: 1_000_000n,
          opening_date: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);

      prismaMock.transaction.findMany.mockResolvedValue([
        {
          id: 'tx-rev-orig',
          type: 'EXPENSE',
          amount: 50_000n,
          account_id: 'acc-1',
          to_account_id: null,
          transfer_fee: 0n,
          fee_mode: null,
          date: new Date('2026-11-02T00:00:00.000Z'),
          parent: null,
        },
        {
          id: 'tx-reversal',
          type: 'REVERSAL',
          amount: 50_000n,
          account_id: 'acc-1',
          to_account_id: null,
          transfer_fee: 0n,
          fee_mode: null,
          date: new Date('2026-11-03T00:00:00.000Z'),
          parent: { type: 'EXPENSE' },
        },
      ]);

      const result = await service.getBalanceChanges('user-1', {
        from: '2026-11-01',
        to: '2026-11-30',
      });

      const bca = result.items[0];
      expect(bca.inflow).toBe(50_000);
      expect(bca.outflow).toBe(50_000);
      expect(bca.closing).toBe(bca.opening);
    });

    it('returns empty result when filtered account_id does not belong to user (AC-8)', async () => {
      dashboardServiceMock.resolveRange.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
      });

      prismaMock.account.findMany.mockResolvedValue([]);

      const result = await service.getBalanceChanges('user-1', {
        from: '2026-11-01',
        to: '2026-11-30',
        account_id: ['non-existent-or-other-user'],
      });

      expect(result.items).toEqual([]);
      expect(result.totals).toEqual({ opening: 0, inflow: 0, outflow: 0, closing: 0 });
    });
  });

  describe('getMonthlyComparison', () => {
    it('AC-4: computes delta and delta_bp accurately; returns null delta_bp when previous is 0', async () => {
      dashboardServiceMock.getSummary.mockImplementation(
        async (_userId: string, filter?: { from?: string }) => {
          if (filter?.from?.startsWith('2026-11')) {
            return {
              from: '2026-11-01',
              to: '2026-11-30',
              income: 2_000_000,
              expense: 1_250_000,
              net: 750_000,
              adjustment_net: 0,
              transfer_total: 0,
            };
          } else {
            return {
              from: '2026-10-01',
              to: '2026-10-31',
              income: 1_500_000,
              expense: 1_000_000,
              net: 500_000,
              adjustment_net: 0,
              transfer_total: 0,
            };
          }
        },
      );

      dashboardServiceMock.getCategoryBreakdown.mockImplementation(
        async (_userId: string, filter?: { from?: string }) => {
          if (filter?.from?.startsWith('2026-11')) {
            return {
              from: '2026-11-01',
              to: '2026-11-30',
              total: 1_250_000,
              items: [
                {
                  category_id: 'cat-1',
                  name: 'Makanan',
                  icon: 'food',
                  color: '#fff',
                  total: 800_000,
                  percentage: 64,
                  percentage_bp: 6400,
                  subcategories: [],
                },
                {
                  category_id: 'cat-2',
                  name: 'Transportasi',
                  icon: 'car',
                  color: '#fff',
                  total: 450_000,
                  percentage: 36,
                  percentage_bp: 3600,
                  subcategories: [],
                },
              ],
            };
          } else {
            return {
              from: '2026-10-01',
              to: '2026-10-31',
              total: 1_000_000,
              items: [
                {
                  category_id: 'cat-1',
                  name: 'Makanan',
                  icon: 'food',
                  color: '#fff',
                  total: 600_000,
                  percentage: 60,
                  percentage_bp: 6000,
                  subcategories: [],
                },
                {
                  category_id: 'cat-3',
                  name: 'Tagihan',
                  icon: 'bill',
                  color: '#fff',
                  total: 400_000,
                  percentage: 40,
                  percentage_bp: 4000,
                  subcategories: [],
                },
              ],
            };
          }
        },
      );

      const result = await service.getMonthlyComparison('user-1', '2026-11');

      expect(result.month).toBe('2026-11');
      expect(result.previous_month).toBe('2026-10');

      expect(result.current.income).toBe(2_000_000);
      expect(result.current.expense).toBe(1_250_000);
      expect(result.previous.income).toBe(1_500_000);
      expect(result.previous.expense).toBe(1_000_000);

      expect(result.delta.income).toBe(500_000);
      expect(result.delta.expense).toBe(250_000);
      expect(result.delta.net).toBe(250_000);

      expect(result.delta_bp.income).toBe(3333);
      expect(result.delta_bp.expense).toBe(2500);
      expect(result.delta_bp.net).toBe(5000);

      expect(result.categories.length).toBe(3);
      expect(result.categories[0].name).toBe('Makanan');
      expect(result.categories[0].current).toBe(800_000);
      expect(result.categories[0].previous).toBe(600_000);
      expect(result.categories[0].delta).toBe(200_000);

      expect(result.categories[1].name).toBe('Transportasi');
      expect(result.categories[1].current).toBe(450_000);
      expect(result.categories[1].previous).toBe(0);
      expect(result.categories[1].delta).toBe(450_000);

      expect(result.categories[2].name).toBe('Tagihan');
      expect(result.categories[2].current).toBe(0);
      expect(result.categories[2].previous).toBe(400_000);
      expect(result.categories[2].delta).toBe(-400_000);
    });

    it('AC-4: when previous month has zero expense, delta_bp.expense is null (no division by zero)', async () => {
      dashboardServiceMock.getSummary.mockImplementation(
        async (_userId: string, filter?: { from?: string }) => {
          if (filter?.from?.startsWith('2026-11')) {
            return {
              from: '2026-11-01',
              to: '2026-11-30',
              income: 1_000_000,
              expense: 500_000,
              net: 500_000,
              adjustment_net: 0,
              transfer_total: 0,
            };
          } else {
            return {
              from: '2026-10-01',
              to: '2026-10-31',
              income: 0,
              expense: 0,
              net: 0,
              adjustment_net: 0,
              transfer_total: 0,
            };
          }
        },
      );

      dashboardServiceMock.getCategoryBreakdown.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
        total: 0,
        items: [],
      });

      const result = await service.getMonthlyComparison('user-1', '2026-11');

      expect(result.delta.expense).toBe(500_000);
      expect(result.delta_bp.expense).toBeNull();
    });
  });
});
