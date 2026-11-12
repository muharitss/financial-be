import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ReportsService } from './reports.service.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('ReportsService', () => {
  let service: ReportsService;
  let dashboardServiceMock: {
    resolveRange: jest.Mock;
    getSummary: jest.Mock;
    getCategoryBreakdown: jest.Mock;
  };
  let transactionsServiceMock: {
    list: jest.Mock;
  };
  let prismaMock: {
    userPreference: { findFirst: jest.Mock };
    account: { findMany: jest.Mock };
    category: { findMany: jest.Mock };
    transaction: { findMany: jest.Mock; count: jest.Mock };
  };

  beforeEach(async () => {
    dashboardServiceMock = {
      resolveRange: jest.fn() as any,
      getSummary: jest.fn() as any,
      getCategoryBreakdown: jest.fn() as any,
    };
    transactionsServiceMock = {
      list: jest.fn() as any,
    };
    prismaMock = {
      userPreference: { findFirst: jest.fn() as any },
      account: { findMany: jest.fn() as any },
      category: { findMany: jest.fn() as any },
      transaction: { findMany: jest.fn() as any, count: jest.fn() as any },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        {
          provide: DashboardService,
          useValue: dashboardServiceMock,
        },
        {
          provide: TransactionsService,
          useValue: transactionsServiceMock,
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
          id: 'acc-bca',
          name: 'BCA',
          type: 'BANK',
          opening_balance: 1_000_000n,
          opening_date: new Date('2026-10-01T00:00:00.000Z'),
        },
        {
          id: 'acc-cash',
          name: 'Dompet',
          type: 'CASH',
          opening_balance: 200_000n,
          opening_date: new Date('2026-10-01T00:00:00.000Z'),
        },
      ]);

      // BCA had 100k expense in October (before from -> opening)
      // BCA received 500k income in Nov (inflow)
      // Dompet spent 50k in Nov (outflow)
      // Transfer 100k from BCA to Dompet in Nov (BCA outflow 100k, Dompet inflow 100k)
      prismaMock.transaction.findMany.mockResolvedValue([
        {
          id: 'tx-oct',
          type: 'EXPENSE',
          amount: 100_000n,
          account_id: 'acc-bca',
          to_account_id: null,
          transfer_fee: 0n,
          fee_mode: null,
          date: new Date('2026-10-15T00:00:00.000Z'),
          parent: null,
        },
        {
          id: 'tx-nov-inc',
          type: 'INCOME',
          amount: 500_000n,
          account_id: 'acc-bca',
          to_account_id: null,
          transfer_fee: 0n,
          fee_mode: null,
          date: new Date('2026-11-05T00:00:00.000Z'),
          parent: null,
        },
        {
          id: 'tx-nov-exp',
          type: 'EXPENSE',
          amount: 50_000n,
          account_id: 'acc-cash',
          to_account_id: null,
          transfer_fee: 0n,
          fee_mode: null,
          date: new Date('2026-11-10T00:00:00.000Z'),
          parent: null,
        },
        {
          id: 'tx-nov-trf',
          type: 'TRANSFER',
          amount: 100_000n,
          account_id: 'acc-bca',
          to_account_id: 'acc-cash',
          transfer_fee: 0n,
          fee_mode: null,
          date: new Date('2026-11-15T00:00:00.000Z'),
          parent: null,
        },
      ]);

      const result = await service.getBalanceChanges('user-1', {
        from: '2026-11-01',
        to: '2026-11-30',
      });

      expect(result.from).toBe('2026-11-01');
      expect(result.to).toBe('2026-11-30');
      expect(result.items).toHaveLength(2);

      // BCA:
      // opening = 1_000_000 - 100_000 = 900_000
      // inflow = 500_000
      // outflow = 100_000 (transfer)
      // closing = 900_000 + 500_000 - 100_000 = 1_300_000
      const bca = result.items.find((i) => i.account_id === 'acc-bca')!;
      expect(bca.opening).toBe(900_000);
      expect(bca.inflow).toBe(500_000);
      expect(bca.outflow).toBe(100_000);
      expect(bca.closing).toBe(1_300_000);
      expect(bca.closing - bca.opening).toBe(bca.inflow - bca.outflow);

      // Dompet:
      // opening = 200_000
      // inflow = 100_000 (transfer from BCA)
      // outflow = 50_000
      // closing = 200_000 + 100_000 - 50_000 = 250_000
      const cash = result.items.find((i) => i.account_id === 'acc-cash')!;
      expect(cash.opening).toBe(200_000);
      expect(cash.inflow).toBe(100_000);
      expect(cash.outflow).toBe(50_000);
      expect(cash.closing).toBe(250_000);
      expect(cash.closing - cash.opening).toBe(cash.inflow - cash.outflow);

      // Totals
      expect(result.totals.opening).toBe(1_100_000);
      expect(result.totals.inflow).toBe(600_000);
      expect(result.totals.outflow).toBe(150_000);
      expect(result.totals.closing).toBe(1_550_000);
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
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
        },
      ]);

      // Expense 100k on Nov 5, reversed on Nov 10
      prismaMock.transaction.findMany.mockResolvedValue([
        {
          id: 'tx-exp',
          type: 'EXPENSE',
          amount: 100_000n,
          account_id: 'acc-1',
          to_account_id: null,
          transfer_fee: 0n,
          fee_mode: null,
          date: new Date('2026-11-05T00:00:00.000Z'),
          parent: null,
        },
        {
          id: 'tx-rev',
          type: 'REVERSAL',
          amount: 100_000n,
          account_id: 'acc-1',
          to_account_id: null,
          transfer_fee: 0n,
          fee_mode: null,
          date: new Date('2026-11-10T00:00:00.000Z'),
          parent: { type: 'EXPENSE' },
        },
      ]);

      const result = await service.getBalanceChanges('user-1', {
        from: '2026-11-01',
        to: '2026-11-30',
      });

      const acc = result.items[0];
      // Inflow = 100_000 (from reversal), Outflow = 100_000 (from expense)
      expect(acc.inflow).toBe(100_000);
      expect(acc.outflow).toBe(100_000);
      expect(acc.closing).toBe(1_000_000);
      expect(acc.closing - acc.opening).toBe(acc.inflow - acc.outflow);
    });

    it('returns empty result when filtered account_id does not belong to user (AC-8)', async () => {
      dashboardServiceMock.resolveRange.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
      });
      // User has no account with foreign UUID
      prismaMock.account.findMany.mockResolvedValue([]);

      const result = await service.getBalanceChanges('user-1', {
        account_id: ['00000000-0000-0000-0000-000000000099'],
      });

      expect(result.items).toEqual([]);
      expect(result.totals).toEqual({
        opening: 0,
        inflow: 0,
        outflow: 0,
        closing: 0,
      });
      expect(prismaMock.transaction.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getMonthlyComparison', () => {
    it('AC-4: computes delta and delta_bp accurately; returns null delta_bp when previous is 0', async () => {
      prismaMock.userPreference.findFirst.mockResolvedValue({
        timezone: 'Asia/Jakarta',
      });

      dashboardServiceMock.getSummary.mockImplementation(
        async (_userId: string, range: { from: string; to: string }) => {
          if (range.from.startsWith('2026-11')) {
            // November (current)
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
            // October (previous)
            return {
              from: '2026-10-01',
              to: '2026-10-31',
              income: 1_000_000,
              expense: 1_000_000,
              net: 0,
              adjustment_net: 0,
              transfer_total: 0,
            };
          }
        },
      );

      dashboardServiceMock.getCategoryBreakdown.mockImplementation(
        async (_userId: string, range: { from: string; to: string }) => {
          if (range.from.startsWith('2026-11')) {
            return {
              from: '2026-11-01',
              to: '2026-11-30',
              total: 1_250_000,
              items: [
                {
                  category_id: 'cat-makanan',
                  name: 'Makanan & Minuman',
                  icon: 'food',
                  color: '#ff0000',
                  archived: false,
                  amount: 800_000,
                  percent_bp: 6400,
                },
                {
                  category_id: 'cat-transport',
                  name: 'Transportasi',
                  icon: 'car',
                  color: '#00ff00',
                  archived: false,
                  amount: 450_000,
                  percent_bp: 3600,
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
                  category_id: 'cat-makanan',
                  name: 'Makanan & Minuman',
                  icon: 'food',
                  color: '#ff0000',
                  archived: false,
                  amount: 600_000,
                  percent_bp: 6000,
                },
                {
                  category_id: 'cat-hiburan',
                  name: 'Hiburan',
                  icon: 'game',
                  color: '#0000ff',
                  archived: false,
                  amount: 400_000,
                  percent_bp: 4000,
                },
              ],
            };
          }
        },
      );

      const result = await service.getMonthlyComparison('user-1', '2026-11');

      expect(result.month).toBe('2026-11');
      expect(result.previous_month).toBe('2026-10');

      // Delta: current - previous
      // income: 2_000_000 - 1_000_000 = 1_000_000
      // expense: 1_250_000 - 1_000_000 = 250_000
      // net: 750_000 - 0 = 750_000
      expect(result.delta).toEqual({
        income: 1_000_000,
        expense: 250_000,
        net: 750_000,
      });

      // delta_bp:
      // income: 1_000_000 * 10000 / 1_000_000 = 10000
      // expense: 250_000 * 10000 / 1_000_000 = 2500
      // net: previous was 0 -> null
      expect(result.delta_bp).toEqual({
        income: 10000,
        expense: 2500,
        net: null,
      });

      // Categories merged & sorted by current descending
      // 1. Makanan (current: 800k, prev: 600k, delta: 200k)
      // 2. Transport (current: 450k, prev: 0, delta: 450k)
      // 3. Hiburan (current: 0, prev: 400k, delta: -400k)
      expect(result.categories).toHaveLength(3);
      expect(result.categories[0]).toEqual({
        category_id: 'cat-makanan',
        name: 'Makanan & Minuman',
        current: 800_000,
        previous: 600_000,
        delta: 200_000,
      });
      expect(result.categories[1]).toEqual({
        category_id: 'cat-transport',
        name: 'Transportasi',
        current: 450_000,
        previous: 0,
        delta: 450_000,
      });
      expect(result.categories[2]).toEqual({
        category_id: 'cat-hiburan',
        name: 'Hiburan',
        current: 0,
        previous: 400_000,
        delta: -400_000,
      });
    });

    it('AC-4: when previous month has zero expense, delta_bp.expense is null (no division by zero)', async () => {
      prismaMock.userPreference.findFirst.mockResolvedValue({
        timezone: 'Asia/Jakarta',
      });

      dashboardServiceMock.getSummary.mockImplementation(
        async (_userId: string, range: { from: string; to: string }) => {
          if (range.from.startsWith('2026-11')) {
            return {
              from: '2026-11-01',
              to: '2026-11-30',
              income: 0,
              expense: 500_000,
              net: -500_000,
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

  describe('streamTransactionsCsv', () => {
    it('writes BOM and header, then iterates cursor until next_cursor is null', async () => {
      prismaMock.account.findMany.mockResolvedValue([
        { id: 'acc-1', name: 'Dompet Tunai' },
      ]);

      transactionsServiceMock.list
        .mockResolvedValueOnce({
          items: [
            {
              id: 'tx-1',
              date: '2026-11-01',
              type: 'INCOME',
              status: 'POSTED',
              account_id: 'acc-1',
              amount: 500000,
              transfer_fee: 0,
              created_at: '2026-11-01T08:00:00.000Z',
            },
          ],
          next_cursor: 'cursor-123',
        })
        .mockResolvedValueOnce({
          items: [
            {
              id: 'tx-2',
              date: '2026-11-02',
              type: 'EXPENSE',
              status: 'POSTED',
              account_id: 'acc-1',
              amount: 25000,
              transfer_fee: 0,
              created_at: '2026-11-02T09:00:00.000Z',
            },
          ],
          next_cursor: null,
        });

      const chunks: string[] = [];
      await service.streamTransactionsCsv(
        'user-1',
        { date_from: '2026-11-01', date_to: '2026-11-30' } as any,
        (chunk) => chunks.push(chunk),
      );

      expect(chunks.length).toBe(3);
      expect(chunks[0].startsWith('\uFEFFID,Tanggal,Jenis')).toBe(true);
      expect(chunks[1]).toContain('Dompet Tunai');
      expect(chunks[1]).toContain('500000');
      expect(chunks[2]).toContain('Dompet Tunai');
      expect(chunks[2]).toContain('25000');
      expect(transactionsServiceMock.list).toHaveBeenCalledTimes(2);
      expect(transactionsServiceMock.list).toHaveBeenNthCalledWith(
        1,
        'user-1',
        expect.objectContaining({ limit: 200, cursor: undefined }),
      );
      expect(transactionsServiceMock.list).toHaveBeenNthCalledWith(
        2,
        'user-1',
        expect.objectContaining({ limit: 200, cursor: 'cursor-123' }),
      );
    });
  });

  describe('buildPdf', () => {
    it('generates a valid PDF buffer starting with %PDF- header', async () => {
      dashboardServiceMock.resolveRange.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
      });
      prismaMock.userPreference.findFirst.mockResolvedValue({
        timezone: 'Asia/Jakarta',
      });
      prismaMock.account.findMany.mockResolvedValue([{ name: 'BCA' }]);
      prismaMock.category.findMany.mockResolvedValue([{ name: 'Makanan' }]);
      dashboardServiceMock.getSummary.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
        income: 1000000,
        expense: 500000,
        net: 500000,
        adjustment_net: 0,
        transfer_total: 0,
      });
      dashboardServiceMock.getCategoryBreakdown.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
        total: 500000,
        items: [
          {
            category_id: 'cat-1',
            name: 'Makanan',
            amount: 500000,
            percent_bp: 10000,
          },
        ],
      });
      prismaMock.transaction.count.mockResolvedValue(1);
      prismaMock.transaction.findMany.mockResolvedValue([
        {
          id: 'tx-1',
          date: new Date('2026-11-05T10:00:00.000Z'),
          type: 'EXPENSE',
          amount: 500000n,
          note: 'Makan siang',
          reason: null,
          account: { name: 'BCA' },
          to_account: null,
          category: { name: 'Makanan' },
          splits: [],
        },
      ]);

      const buffer = await service.buildPdf('user-1', {
        from: '2026-11-01',
        to: '2026-11-30',
      });

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(100);
      expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    }, 15000);

    it('throws 503 PDF_GENERATION_FAILED if puppeteer fails', async () => {
      dashboardServiceMock.resolveRange.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
      });
      prismaMock.userPreference.findFirst.mockResolvedValue(null);
      dashboardServiceMock.getSummary.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
        income: 0,
        expense: 0,
        net: 0,
        adjustment_net: 0,
        transfer_total: 0,
      });
      dashboardServiceMock.getCategoryBreakdown.mockResolvedValue({
        from: '2026-11-01',
        to: '2026-11-30',
        total: 0,
        items: [],
      });
      prismaMock.transaction.count.mockResolvedValue(0);
      prismaMock.transaction.findMany.mockResolvedValue([]);

      // Mock puppeteer.launch to simulate a failure
      const puppeteerModule = await import('puppeteer');
      const spy = jest
        .spyOn(puppeteerModule.default, 'launch')
        .mockRejectedValueOnce(new Error('Chromium crash simulation'));

      await expect(service.buildPdf('user-1')).rejects.toMatchObject({
        response: {
          code: 'PDF_GENERATION_FAILED',
          message: 'Gagal membuat PDF, coba lagi atau gunakan ekspor CSV',
        },
        status: 503,
      });

      spy.mockRestore();
    });
  });
});
