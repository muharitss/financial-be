import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DashboardService, computeBalances } from './dashboard.service.js';
import { AccountsService, AccountResponse } from '../accounts/accounts.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('DashboardService & computeBalances', () => {
  describe('computeBalances (Pure Function)', () => {
    const makeAccount = (partial: Partial<AccountResponse>): AccountResponse => ({
      id: 'acc-1',
      name: 'Account',
      type: 'BANK',
      provider: null,
      note: null,
      opening_balance: 0,
      opening_date: '2026-01-01',
      balance: 0,
      reserved: 0,
      available: 0,
      allow_negative: false,
      archived: false,
      archived_at: null,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      ...partial,
    });

    it('AC-6: returns zeros when there are no accounts', () => {
      const result = computeBalances([]);

      expect(result).toEqual({
        ledger_balance: 0,
        reserved_total: 0,
        available_balance: 0,
        net_worth: 0,
        accounts_count: 0,
        as_of: expect.any(String),
      });
      expect(new Date(result.as_of).toISOString()).toBe(result.as_of);
    });

    it('AC-1: computes ledger_balance, reserved_total, available_balance, net_worth correctly and excludes archived accounts', () => {
      const accounts: AccountResponse[] = [
        makeAccount({
          id: 'acc-bca',
          name: 'BCA',
          type: 'BANK',
          balance: 1_000_000,
          reserved: 400_000,
          archived: false,
        }),
        makeAccount({
          id: 'acc-dompet',
          name: 'Dompet',
          type: 'CASH',
          balance: -50_000,
          reserved: 0,
          allow_negative: true,
          archived: false,
        }),
        makeAccount({
          id: 'acc-rd',
          name: 'Reksa Dana',
          type: 'INVESTMENT',
          balance: 2_000_000,
          reserved: 0,
          archived: false,
        }),
        makeAccount({
          id: 'acc-arsip',
          name: 'Akun Lama',
          type: 'BANK',
          balance: 500_000,
          reserved: 0,
          archived: true,
        }),
      ];

      const result = computeBalances(accounts);

      expect(result.ledger_balance).toBe(2_950_000);
      expect(result.reserved_total).toBe(400_000);
      expect(result.available_balance).toBe(550_000); // 1.000.000 - 50.000 - 400.000
      expect(result.net_worth).toBe(3_000_000); // 1.000.000 + 2.000.000 (Dompet negatif diabaikan)
      expect(result.accounts_count).toBe(3);
    });

    it('AC-2: RECEIVABLE increases ledger_balance & net_worth but does not change available_balance', () => {
      const baseAccounts: AccountResponse[] = [
        makeAccount({
          id: 'acc-bca',
          type: 'BANK',
          balance: 1_000_000,
          reserved: 100_000,
        }),
      ];

      const before = computeBalances(baseAccounts);
      expect(before.ledger_balance).toBe(1_000_000);
      expect(before.net_worth).toBe(1_000_000);
      expect(before.available_balance).toBe(900_000);

      const accountsWithReceivable: AccountResponse[] = [
        ...baseAccounts,
        makeAccount({
          id: 'acc-piutang',
          type: 'RECEIVABLE',
          balance: 300_000,
          reserved: 0,
        }),
      ];

      const after = computeBalances(accountsWithReceivable);
      expect(after.ledger_balance).toBe(1_300_000);
      expect(after.net_worth).toBe(1_300_000);
      expect(after.available_balance).toBe(900_000); // unaffected by RECEIVABLE
      expect(after.accounts_count).toBe(2);
    });

    it('AC-3: available_balance can be negative when reserved_total exceeds liquid balance (not clamped)', () => {
      const accounts: AccountResponse[] = [
        makeAccount({
          id: 'acc-bca',
          type: 'BANK',
          balance: 100_000,
          reserved: 300_000,
        }),
      ];

      const result = computeBalances(accounts);
      expect(result.ledger_balance).toBe(100_000);
      expect(result.reserved_total).toBe(300_000);
      expect(result.available_balance).toBe(-200_000);
    });
  });

  describe('DashboardService', () => {
    let service: DashboardService;
    let accountsServiceMock: { list: jest.Mock };
    let prismaMock: {
      userPreference: { findFirst: jest.Mock };
      transaction: { findMany: jest.Mock };
      category: { findMany: jest.Mock };
    };

    beforeEach(async () => {
      accountsServiceMock = {
        list: jest.fn(),
      };
      prismaMock = {
        userPreference: { findFirst: jest.fn() as any },
        transaction: { findMany: jest.fn() as any },
        category: { findMany: jest.fn() as any },
        account: { findMany: jest.fn() as any },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DashboardService,
          {
            provide: AccountsService,
            useValue: accountsServiceMock,
          },
          {
            provide: PrismaService,
            useValue: prismaMock,
          },
        ],
      }).compile();

      service = module.get<DashboardService>(DashboardService);
    });

    it('fetches accounts for user and computes balances', async () => {
      accountsServiceMock.list.mockResolvedValue([
        {
          id: 'acc-1',
          name: 'BCA',
          type: 'BANK',
          provider: null,
          note: null,
          opening_balance: 1_000_000,
          opening_date: '2026-01-01',
          balance: 1_000_000,
          reserved: 0,
          available: 1_000_000,
          allow_negative: false,
          archived: false,
          archived_at: null,
          created_at: new Date(),
        },
      ]);

      const res = await service.getBalances('user-123');

      expect(accountsServiceMock.list).toHaveBeenCalledWith('user-123');
      expect(res.ledger_balance).toBe(1_000_000);
      expect(res.available_balance).toBe(1_000_000);
      expect(res.net_worth).toBe(1_000_000);
      expect(res.accounts_count).toBe(1);
    });

    describe('resolveRange', () => {
      it('AC-5: resolves default from and to to start and end of current month in user timezone', async () => {
        prismaMock.userPreference.findFirst.mockResolvedValue({
          timezone: 'Asia/Jakarta',
        });

        const range = await service.resolveRange('user-123');
        expect(range.from).toMatch(/^\d{4}-\d{2}-01$/);
        expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(range.from <= range.to).toBe(true);
      });

      it('AC-8: throws VALIDATION_ERROR when from > to', async () => {
        await expect(
          service.resolveRange('user-123', '2026-11-10', '2026-11-01'),
        ).rejects.toThrow(BadRequestException);
      });

      it('AC-8: throws DATE_RANGE_TOO_LARGE when range > 366 days', async () => {
        await expect(
          service.resolveRange('user-123', '2025-01-01', '2026-03-01'),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('getSummary', () => {
      it('AC-1: computes income, expense, net, adjustment_net, transfer_total correctly', async () => {
        prismaMock.transaction.findMany.mockResolvedValue([
          {
            type: 'INCOME',
            amount: 5_000_000n,
            date: new Date('2026-11-05'),
            splits: [],
          },
          {
            type: 'EXPENSE',
            amount: 1_200_000n,
            date: new Date('2026-11-06'),
            splits: [],
          },
          {
            type: 'EXPENSE', // Fee Metode A
            amount: 6_500n,
            date: new Date('2026-11-07'),
            splits: [],
          },
          {
            type: 'TRANSFER',
            amount: 500_000n,
            date: new Date('2026-11-07'),
            splits: [],
          },
          {
            type: 'ADJUSTMENT',
            amount: -20_000n,
            date: new Date('2026-11-08'),
            splits: [],
          },
        ]);

        const summary = await service.getSummary('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
        });

        expect(summary.income).toBe(5_000_000);
        expect(summary.expense).toBe(1_206_500);
        expect(summary.net).toBe(3_793_500);
        expect(summary.adjustment_net).toBe(-20_000);
        expect(summary.transfer_total).toBe(500_000);
      });

      it('AC-6: supports category filter with 1-level rollup and split transactions', async () => {
        // Parent: cat-food, Child: cat-resto
        prismaMock.category.findMany.mockResolvedValue([
          { id: 'cat-food', parent_id: null },
          { id: 'cat-resto', parent_id: 'cat-food' },
          { id: 'cat-transport', parent_id: null },
        ]);

        prismaMock.transaction.findMany.mockResolvedValue([
          {
            type: 'EXPENSE',
            amount: 50_000n,
            splits: [
              { category_id: 'cat-resto', amount: 30_000n },
              { category_id: 'cat-transport', amount: 20_000n },
            ],
          },
          {
            type: 'ADJUSTMENT',
            amount: 10_000n,
            splits: [],
          },
          {
            type: 'TRANSFER',
            amount: 100_000n,
            splits: [],
          },
        ]);

        const summary = await service.getSummary('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
          category_id: ['cat-food'],
        });

        expect(summary.expense).toBe(30_000); // Only cat-resto (child of cat-food)
        expect(summary.adjustment_net).toBe(0); // 0 when category filter active
        expect(summary.transfer_total).toBe(0); // 0 when category filter active
      });
    });

    describe('getCashFlow', () => {
      it('AC-7: returns ordered months with 0 for empty months', async () => {
        prismaMock.userPreference.findFirst.mockResolvedValue({
          timezone: 'Asia/Jakarta',
        });

        // Misal hanya ada transaksi di bulan berjalan
        prismaMock.transaction.findMany.mockResolvedValue([
          {
            type: 'INCOME',
            amount: 1_000_000n,
            date: new Date(),
          },
        ]);

        const result = await service.getCashFlow('user-123', 3);

        expect(result.items.length).toBe(3);
        // Terurut naik
        expect(result.items[0].month < result.items[1].month).toBe(true);
        expect(result.items[1].month < result.items[2].month).toBe(true);
        // Bulan kosong bernilai 0
        expect(result.items[0].income).toBe(0);
        expect(result.items[0].expense).toBe(0);
        expect(result.items[0].net).toBe(0);
      });
    });

    describe('getCategoryBreakdown', () => {
      const mockCategories = [
        {
          id: 'cat-makanan',
          name: 'Makanan',
          parent_id: null,
          icon: 'utensils',
          color: '#ff0000',
          archived: false,
        },
        {
          id: 'cat-kopi',
          name: 'Makanan > Kopi',
          parent_id: 'cat-makanan',
          icon: 'coffee',
          color: '#773300',
          archived: false,
        },
        {
          id: 'cat-transport',
          name: 'Transport',
          parent_id: null,
          icon: 'car',
          color: '#0000ff',
          archived: false,
        },
        {
          id: 'cat-belanja',
          name: 'Belanja',
          parent_id: null,
          icon: 'shopping-bag',
          color: '#00ff00',
          archived: false,
        },
        {
          id: 'cat-hiburan',
          name: 'Hiburan',
          parent_id: null,
          icon: 'film',
          color: '#ffff00',
          archived: false,
        },
        {
          id: 'cat-arsip',
          name: 'Langganan Lama',
          parent_id: null,
          icon: 'archive',
          color: '#888888',
          archived: true,
        },
        {
          id: 'cat-transfer-fee',
          name: 'Biaya Transfer',
          parent_id: null,
          icon: 'arrow-right-left',
          color: '#333333',
          archived: false,
        },
      ];

      it('AC-1: Rollup 1 level: Makanan 300k, subkategori Makanan > Kopi 50k, Transport 150k -> Makanan 350k (7000 bp), Transport 150k (3000 bp)', async () => {
        prismaMock.category.findMany.mockResolvedValue(mockCategories);
        prismaMock.transaction.findMany.mockResolvedValue([
          {
            type: 'EXPENSE',
            amount: 300_000n,
            category_id: 'cat-makanan',
            splits: [],
          },
          {
            type: 'EXPENSE',
            amount: 50_000n,
            category_id: 'cat-kopi',
            splits: [],
          },
          {
            type: 'EXPENSE',
            amount: 150_000n,
            category_id: 'cat-transport',
            splits: [],
          },
        ]);

        const result = await service.getCategoryBreakdown('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
        });

        expect(result.total).toBe(500_000);
        expect(result.items.length).toBe(2);

        expect(result.items[0]).toEqual({
          category_id: 'cat-makanan',
          name: 'Makanan',
          icon: 'utensils',
          color: '#ff0000',
          archived: false,
          amount: 350_000,
          percent_bp: 7000,
        });

        expect(result.items[1]).toEqual({
          category_id: 'cat-transport',
          name: 'Transport',
          icon: 'car',
          color: '#0000ff',
          archived: false,
          amount: 150_000,
          percent_bp: 3000,
        });
      });

      it('AC-2: Split-aware: 100k split into Belanja 60k + Hiburan 40k -> no double counting', async () => {
        prismaMock.category.findMany.mockResolvedValue(mockCategories);
        prismaMock.transaction.findMany.mockResolvedValue([
          {
            type: 'EXPENSE',
            amount: 100_000n,
            category_id: 'cat-belanja',
            splits: [
              { category_id: 'cat-belanja', amount: 60_000n },
              { category_id: 'cat-hiburan', amount: 40_000n },
            ],
          },
        ]);

        const result = await service.getCategoryBreakdown('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
        });

        expect(result.total).toBe(100_000);
        expect(result.items.length).toBe(2);
        expect(result.items[0].category_id).toBe('cat-belanja');
        expect(result.items[0].amount).toBe(60_000);
        expect(result.items[0].percent_bp).toBe(6000);
        expect(result.items[1].category_id).toBe('cat-hiburan');
        expect(result.items[1].amount).toBe(40_000);
        expect(result.items[1].percent_bp).toBe(4000);
      });

      it('AC-3: Invariant C-07: sum(items.amount) === total === getSummary.expense', async () => {
        prismaMock.category.findMany.mockResolvedValue(mockCategories);
        const txs = [
          {
            type: 'EXPENSE',
            amount: 200_000n,
            category_id: 'cat-makanan',
            splits: [],
          },
          {
            type: 'EXPENSE',
            amount: 100_000n,
            category_id: 'cat-belanja',
            splits: [
              { category_id: 'cat-belanja', amount: 70_000n },
              { category_id: 'cat-hiburan', amount: 30_000n },
            ],
          },
          {
            type: 'INCOME',
            amount: 500_000n,
            category_id: 'cat-income',
            splits: [],
          },
        ];
        prismaMock.transaction.findMany.mockResolvedValue(txs);

        const breakdown = await service.getCategoryBreakdown('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
        });
        const summary = await service.getSummary('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
        });

        const itemsSum = breakdown.items.reduce((acc, it) => acc + it.amount, 0);
        expect(itemsSum).toBe(breakdown.total);
        expect(breakdown.total).toBe(summary.expense);
        expect(breakdown.total).toBe(300_000);
      });

      it('AC-5: Archived category with expenses in period appears with archived: true', async () => {
        prismaMock.category.findMany.mockResolvedValue(mockCategories);
        prismaMock.transaction.findMany.mockResolvedValue([
          {
            type: 'EXPENSE',
            amount: 50_000n,
            category_id: 'cat-arsip',
            splits: [],
          },
        ]);

        const result = await service.getCategoryBreakdown('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
        });

        expect(result.items.length).toBe(1);
        expect(result.items[0]).toEqual({
          category_id: 'cat-arsip',
          name: 'Langganan Lama',
          icon: 'archive',
          color: '#888888',
          archived: true,
          amount: 50_000,
          percent_bp: 10000,
        });
      });

      it('AC-6: Transfer Method A fee appears under Biaya Transfer; Transfer Method B does not appear', async () => {
        prismaMock.category.findMany.mockResolvedValue(mockCategories);
        prismaMock.transaction.findMany.mockResolvedValue([
          {
            type: 'EXPENSE',
            amount: 6_500n,
            category_id: 'cat-transfer-fee',
            splits: [],
          },
          {
            type: 'TRANSFER',
            amount: 500_000n,
            category_id: null,
            splits: [],
          },
        ]);

        const result = await service.getCategoryBreakdown('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
        });

        expect(result.total).toBe(6_500);
        expect(result.items.length).toBe(1);
        expect(result.items[0].name).toBe('Biaya Transfer');
        expect(result.items[0].amount).toBe(6_500);
      });

      it('AC-7: Empty period returns total: 0 and items: []', async () => {
        prismaMock.category.findMany.mockResolvedValue(mockCategories);
        prismaMock.transaction.findMany.mockResolvedValue([]);

        const result = await service.getCategoryBreakdown('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
        });

        expect(result.total).toBe(0);
        expect(result.items).toEqual([]);
      });

      it('handles transactions without category_id into Tanpa Kategori bucket', async () => {
        prismaMock.category.findMany.mockResolvedValue(mockCategories);
        prismaMock.transaction.findMany.mockResolvedValue([
          {
            type: 'EXPENSE',
            amount: 25_000n,
            category_id: null,
            splits: [],
          },
        ]);

        const result = await service.getCategoryBreakdown('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
        });

        expect(result.total).toBe(25_000);
        expect(result.items.length).toBe(1);
        expect(result.items[0]).toEqual({
          category_id: null,
          name: 'Tanpa Kategori',
          icon: null,
          color: null,
          archived: false,
          amount: 25_000,
          percent_bp: 10000,
        });
      });
    });

    describe('getBalanceTrend', () => {
      it('AC-6: 30-day range returns 30 points with granularity "day"', async () => {
        prismaMock.account.findMany.mockResolvedValue([
          {
            id: 'acc-1',
            opening_balance: 1_000_000n,
            opening_date: new Date('2026-11-01T00:00:00.000Z'),
          },
        ]);
        prismaMock.transaction.findMany.mockResolvedValue([]);

        const result = await service.getBalanceTrend('user-123', {
          from: '2026-11-01',
          to: '2026-11-30',
        });

        expect(result.from).toBe('2026-11-01');
        expect(result.to).toBe('2026-11-30');
        expect(result.granularity).toBe('day');
        expect(result.points.length).toBe(30);
        expect(result.points[0]).toEqual({
          date: '2026-11-01',
          ledger_balance: 1_000_000,
        });
        expect(result.points[29]).toEqual({
          date: '2026-11-30',
          ledger_balance: 1_000_000,
        });
      });

      it('AC-6: 12-month range returns month-end points with granularity "month" and last point = to', async () => {
        prismaMock.account.findMany.mockResolvedValue([
          {
            id: 'acc-1',
            opening_balance: 500_000n,
            opening_date: new Date('2026-01-01T00:00:00.000Z'),
          },
        ]);
        prismaMock.transaction.findMany.mockResolvedValue([]);

        const result = await service.getBalanceTrend('user-123', {
          from: '2026-01-01',
          to: '2026-12-31',
        });

        expect(result.granularity).toBe('month');
        expect(result.points.length).toBe(12);
        expect(result.points[0].date).toBe('2026-01-31');
        expect(result.points[1].date).toBe('2026-02-28');
        expect(result.points[11].date).toBe('2026-12-31');
        expect(result.points[11].ledger_balance).toBe(500_000);
      });

      it('AC-3: Account with opening_date after D does not contribute to D', async () => {
        prismaMock.account.findMany.mockResolvedValue([
          {
            id: 'acc-1',
            opening_balance: 1_000_000n,
            opening_date: new Date('2026-11-05T00:00:00.000Z'),
          },
        ]);
        prismaMock.transaction.findMany.mockResolvedValue([]);

        const result = await service.getBalanceTrend('user-123', {
          from: '2026-11-01',
          to: '2026-11-10',
        });

        expect(result.points.length).toBe(10);
        // 2026-11-01 to 2026-11-04 should be 0
        expect(result.points[0]).toEqual({ date: '2026-11-01', ledger_balance: 0 });
        expect(result.points[3]).toEqual({ date: '2026-11-04', ledger_balance: 0 });
        // 2026-11-05 onwards should be 1_000_000
        expect(result.points[4]).toEqual({ date: '2026-11-05', ledger_balance: 1_000_000 });
        expect(result.points[9]).toEqual({ date: '2026-11-10', ledger_balance: 1_000_000 });
      });

      it('AC-4 (C-05): Expense on day 5 reversed on day 10 dips between 5-9 and recovers on day 10', async () => {
        prismaMock.account.findMany.mockResolvedValue([
          {
            id: 'acc-1',
            opening_balance: 1_000_000n,
            opening_date: new Date('2026-11-01T00:00:00.000Z'),
          },
        ]);
        prismaMock.transaction.findMany.mockResolvedValue([
          {
            id: 'tx-1',
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
            id: 'tx-rev-1',
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

        const result = await service.getBalanceTrend('user-123', {
          from: '2026-11-01',
          to: '2026-11-15',
        });

        // Day 1 to 4: 1_000_000
        expect(result.points[0].ledger_balance).toBe(1_000_000);
        expect(result.points[3].ledger_balance).toBe(1_000_000);
        // Day 5 to 9: 900_000
        expect(result.points[4].ledger_balance).toBe(900_000);
        expect(result.points[8].ledger_balance).toBe(900_000);
        // Day 10 onwards: 1_000_000
        expect(result.points[9].ledger_balance).toBe(1_000_000);
        expect(result.points[14].ledger_balance).toBe(1_000_000);
      });

      it('correctly includes transactions before "from" into opening balance', async () => {
        prismaMock.account.findMany.mockResolvedValue([
          {
            id: 'acc-1',
            opening_balance: 1_000_000n,
            opening_date: new Date('2026-10-01T00:00:00.000Z'),
          },
        ]);
        prismaMock.transaction.findMany.mockResolvedValue([
          {
            id: 'tx-old',
            type: 'INCOME',
            amount: 250_000n,
            account_id: 'acc-1',
            to_account_id: null,
            transfer_fee: 0n,
            fee_mode: null,
            date: new Date('2026-10-15T00:00:00.000Z'),
            parent: null,
          },
        ]);

        const result = await service.getBalanceTrend('user-123', {
          from: '2026-11-01',
          to: '2026-11-05',
        });

        expect(result.points[0].ledger_balance).toBe(1_250_000);
        expect(result.points[4].ledger_balance).toBe(1_250_000);
      });

      it('supports filtering by account_id', async () => {
        prismaMock.account.findMany.mockResolvedValue([
          {
            id: 'acc-1',
            opening_balance: 500_000n,
            opening_date: new Date('2026-11-01T00:00:00.000Z'),
          },
        ]);
        prismaMock.transaction.findMany.mockResolvedValue([]);

        const result = await service.getBalanceTrend('user-123', {
          from: '2026-11-01',
          to: '2026-11-05',
          account_id: ['acc-1'],
        });

        expect(prismaMock.account.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: { in: ['acc-1'] },
            }),
          }),
        );
        expect(result.points[0].ledger_balance).toBe(500_000);
      });
    });
  });
});
