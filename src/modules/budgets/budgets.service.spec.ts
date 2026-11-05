import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BudgetsService, toBudgetResponse } from './budgets.service.js';

describe('BudgetsService', () => {
  let service: BudgetsService;
  let prisma: any;

  const user = { userId: '11111111-1111-1111-1111-111111111111', role: 'USER' };
  const mockProfile = {
    id: '22222222-2222-2222-2222-222222222222',
    user_id: user.userId,
    is_default: true,
  };
  const mockUserPref = {
    id: 'pref-1',
    user_id: user.userId,
    timezone: 'Asia/Jakarta',
  };
  const mockCategory = {
    id: '33333333-3333-3333-3333-333333333333',
    user_id: user.userId,
    type: 'EXPENSE',
    archived: false,
    name: 'Makanan',
  };
  const mockAccountA = {
    id: '44444444-4444-4444-4444-444444444444',
    user_id: user.userId,
    archived: false,
    name: 'BCA',
  };
  const mockAccountB = {
    id: '55555555-5555-5555-5555-555555555555',
    user_id: user.userId,
    archived: false,
    name: 'Mandiri',
  };

  beforeEach(() => {
    prisma = {
      budget: {
        findFirst: jest.fn<any>(),
        findMany: jest.fn<any>(),
        create: jest.fn<any>(),
        update: jest.fn<any>(),
      },
      budgetPeriod: {
        findFirst: jest.fn<any>(),
        create: jest.fn<any>(),
        update: jest.fn<any>(),
      },
      budgetCategory: {
        create: jest.fn<any>(),
        update: jest.fn<any>(),
      },
      rolloverConfig: {
        create: jest.fn<any>(),
        update: jest.fn<any>(),
      },
      category: {
        findFirst: jest.fn<any>(),
        findMany: jest.fn<any>(),
      },
      account: {
        findMany: jest.fn<any>(),
      },
      transaction: {
        findMany: jest.fn<any>(),
      },
      financialProfile: {
        findFirst: jest.fn<any>().mockResolvedValue(mockProfile),
      },
      userPreference: {
        findFirst: jest.fn<any>().mockResolvedValue(mockUserPref),
      },
      auditLog: {
        create: jest.fn<any>().mockResolvedValue({ id: 'audit-1' }),
      },
      $queryRaw: jest.fn<any>().mockResolvedValue([]),
      $transaction: jest.fn<any>(async (fn: any) => fn(prisma)),
    };

    service = new BudgetsService(prisma);
  });

  describe('toBudgetResponse', () => {
    it('mengonversi BigInt ke number dan menghitung effective_amount dengan benar', () => {
      const budget = {
        id: 'b-1',
        financial_profile_id: mockProfile.id,
        type: 'CATEGORY',
        category_id: mockCategory.id,
        scope_account_ids: [],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      };
      const period = {
        id: 'bp-1',
        period: '2026-11',
        base_amount: 1500000n,
        carryover_amount: 200000n,
        locked_at: null,
        categories: [
          {
            amount: 1500000n,
            rollover_enabled: true,
            carryover_amount: 200000n,
          },
        ],
      };

      const res = toBudgetResponse(budget, period);
      expect(res).toEqual({
        id: 'b-1',
        financial_profile_id: mockProfile.id,
        type: 'CATEGORY',
        category_id: mockCategory.id,
        scope_account_ids: [],
        period: '2026-11',
        period_id: 'bp-1',
        amount: 1500000,
        base_amount: 1500000,
        carryover_amount: 200000,
        effective_amount: 1700000,
        rollover_enabled: true,
        locked_at: null,
        created_at: budget.created_at,
        updated_at: budget.updated_at,
      });
    });
  });

  describe('create', () => {
    it('menolak rollover_enabled: true pada budget TOTAL dengan 422 ROLLOVER_TOTAL_NOT_ALLOWED', async () => {
      await expect(
        service.create(user, {
          type: 'TOTAL',
          amount: 3000000,
          rollover_enabled: true,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('melempar PROFILE_NOT_FOUND jika default profile tidak ada', async () => {
      prisma.financialProfile.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.create(user, {
          type: 'TOTAL',
          amount: 3000000,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('menolak periode lampau dengan 409 BUDGET_PERIOD_LOCKED', async () => {
      await expect(
        service.create(user, {
          type: 'TOTAL',
          amount: 3000000,
          period: '2020-01',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('menolak jika kategori tidak ditemukan (404 CATEGORY_NOT_FOUND)', async () => {
      prisma.category.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.create(user, {
          type: 'CATEGORY',
          category_id: '99999999-9999-9999-9999-999999999999',
          amount: 1000000,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('menolak jika kategori diarsipkan (422 CATEGORY_ARCHIVED)', async () => {
      prisma.category.findFirst.mockResolvedValueOnce({
        ...mockCategory,
        archived: true,
      });

      await expect(
        service.create(user, {
          type: 'CATEGORY',
          category_id: mockCategory.id,
          amount: 1000000,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('menolak jika kategori bukan EXPENSE (400 INVALID_CATEGORY_TYPE)', async () => {
      prisma.category.findFirst.mockResolvedValueOnce({
        ...mockCategory,
        type: 'INCOME',
      });

      await expect(
        service.create(user, {
          type: 'CATEGORY',
          category_id: mockCategory.id,
          amount: 1000000,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('menolak jika akun dalam scope_account_ids tidak ditemukan (404 ACCOUNT_NOT_FOUND)', async () => {
      prisma.account.findMany.mockResolvedValueOnce([mockAccountA]);

      await expect(
        service.create(user, {
          type: 'TOTAL',
          amount: 3000000,
          scope_account_ids: [mockAccountA.id, '99999999-9999-9999-9999-999999999999'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('menolak jika akun dalam scope_account_ids diarsipkan (409 ACCOUNT_ARCHIVED)', async () => {
      prisma.account.findMany.mockResolvedValueOnce([
        { ...mockAccountA, archived: true },
      ]);

      await expect(
        service.create(user, {
          type: 'TOTAL',
          amount: 3000000,
          scope_account_ids: [mockAccountA.id],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('berhasil membuat budget TOTAL dan BudgetPeriod serta AuditLog', async () => {
      const createdBudget = {
        id: 'b-total',
        financial_profile_id: mockProfile.id,
        user_id: user.userId,
        type: 'TOTAL',
        category_id: null,
        scope_account_ids: [],
        created_at: new Date(),
        updated_at: new Date(),
      };
      const createdPeriod = {
        id: 'bp-1',
        budget_id: createdBudget.id,
        period: '2026-11',
        base_amount: 3000000n,
        carryover_amount: 0n,
        locked_at: null,
      };

      prisma.budget.findFirst.mockResolvedValueOnce(null);
      prisma.budget.create.mockResolvedValueOnce(createdBudget);
      prisma.budgetPeriod.create.mockResolvedValueOnce(createdPeriod);

      const res = await service.create(user, {
        type: 'TOTAL',
        amount: 3000000,
        period: '2026-11',
      });

      expect(res.type).toBe('TOTAL');
      expect(res.amount).toBe(3000000);
      expect(res.carryover_amount).toBe(0);
      expect(prisma.budgetCategory.create).not.toHaveBeenCalled();
      expect(prisma.rolloverConfig.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'BUDGET_CREATE',
            resource_type: 'budget',
            resource_id: createdBudget.id,
          }),
        }),
      );
    });

    it('berhasil membuat budget CATEGORY beserta BudgetCategory dan RolloverConfig', async () => {
      prisma.category.findFirst.mockResolvedValueOnce(mockCategory);
      prisma.account.findMany.mockResolvedValueOnce([mockAccountA, mockAccountB]);

      const createdBudget = {
        id: 'b-cat',
        financial_profile_id: mockProfile.id,
        user_id: user.userId,
        type: 'CATEGORY',
        category_id: mockCategory.id,
        scope_account_ids: [mockAccountA.id, mockAccountB.id],
        created_at: new Date(),
        updated_at: new Date(),
      };
      const createdPeriod = {
        id: 'bp-cat-1',
        budget_id: createdBudget.id,
        period: '2026-11',
        base_amount: 1500000n,
        carryover_amount: 0n,
        locked_at: null,
      };
      const createdCategory = {
        id: 'bc-1',
        budget_period_id: createdPeriod.id,
        category_id: mockCategory.id,
        amount: 1500000n,
        rollover_enabled: true,
        carryover_amount: 0n,
      };

      prisma.budget.findFirst.mockResolvedValueOnce(null);
      prisma.budget.create.mockResolvedValueOnce(createdBudget);
      prisma.budgetPeriod.create.mockResolvedValueOnce(createdPeriod);
      prisma.budgetCategory.create.mockResolvedValueOnce(createdCategory);
      prisma.rolloverConfig.create.mockResolvedValueOnce({ id: 'rc-1' });

      const res = await service.create(user, {
        type: 'CATEGORY',
        category_id: mockCategory.id,
        amount: 1500000,
        period: '2026-11',
        rollover_enabled: true,
        scope_account_ids: [mockAccountA.id, mockAccountB.id],
      });

      expect(res.type).toBe('CATEGORY');
      expect(res.rollover_enabled).toBe(true);
      expect(prisma.budgetCategory.create).toHaveBeenCalled();
      expect(prisma.rolloverConfig.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            budget_category_id: createdCategory.id,
            enabled: true,
          }),
        }),
      );
    });

    it('menolak pembuatan budget duplikat pada periode yang sama (409 BUDGET_ALREADY_EXISTS)', async () => {
      const existingBudget = {
        id: 'b-total',
        type: 'TOTAL',
        category_id: null,
      };
      prisma.budget.findFirst.mockResolvedValueOnce(existingBudget);
      prisma.budgetPeriod.findFirst.mockResolvedValueOnce({
        id: 'bp-1',
        budget_id: existingBudget.id,
        period: '2026-11',
      });

      await expect(
        service.create(user, {
          type: 'TOTAL',
          amount: 2500000,
          period: '2026-11',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('mereuse Budget induk jika budget sudah ada tapi periode baru belum ada', async () => {
      const existingBudget = {
        id: 'b-total',
        financial_profile_id: mockProfile.id,
        user_id: user.userId,
        type: 'TOTAL',
        category_id: null,
        scope_account_ids: [],
        created_at: new Date(),
        updated_at: new Date(),
      };
      const createdPeriod = {
        id: 'bp-2',
        budget_id: existingBudget.id,
        period: '2026-12',
        base_amount: 3500000n,
        carryover_amount: 0n,
        locked_at: null,
      };

      prisma.budget.findFirst.mockResolvedValueOnce(existingBudget);
      prisma.budgetPeriod.findFirst.mockResolvedValueOnce(null);
      prisma.budgetPeriod.create.mockResolvedValueOnce(createdPeriod);

      const res = await service.create(user, {
        type: 'TOTAL',
        amount: 3500000,
        period: '2026-12',
      });

      expect(prisma.budget.create).not.toHaveBeenCalled();
      expect(res.period).toBe('2026-12');
      expect(res.amount).toBe(3500000);
    });

    it('menangani P2002 race condition dengan 409 BUDGET_ALREADY_EXISTS', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.0.0',
      });
      prisma.budget.findFirst.mockResolvedValueOnce(null);
      prisma.budget.create.mockRejectedValueOnce(p2002Error);

      await expect(
        service.create(user, {
          type: 'TOTAL',
          amount: 3000000,
          period: '2026-11',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('menolak update budget jika tidak ditemukan (404 BUDGET_NOT_FOUND)', async () => {
      prisma.budget.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.update(user, 'non-existent-id', { amount: 1800000 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('menolak rollover_enabled: true pada update budget TOTAL dengan 422 ROLLOVER_TOTAL_NOT_ALLOWED', async () => {
      prisma.budget.findFirst.mockResolvedValueOnce({
        id: 'b-total',
        type: 'TOTAL',
        user_id: user.userId,
      });

      await expect(
        service.update(user, 'b-total', { rollover_enabled: true }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('menolak update pada periode lampau (409 BUDGET_PERIOD_LOCKED)', async () => {
      prisma.budget.findFirst.mockResolvedValueOnce({
        id: 'b-total',
        type: 'TOTAL',
        user_id: user.userId,
      });

      await expect(
        service.update(user, 'b-total', {
          amount: 2000000,
          period: '2020-01',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('menolak update jika periode anggaran sudah dikunci (locked_at !== null)', async () => {
      const mockBudget = {
        id: 'b-cat',
        type: 'CATEGORY',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        category_id: mockCategory.id,
        scope_account_ids: [],
        created_at: new Date(),
        updated_at: new Date(),
      };
      prisma.budget.findFirst.mockResolvedValueOnce(mockBudget);
      prisma.budgetPeriod.findFirst.mockResolvedValueOnce({
        id: 'bp-1',
        budget_id: mockBudget.id,
        period: '2026-11',
        base_amount: 1500000n,
        carryover_amount: 0n,
        locked_at: new Date(),
        categories: [],
      });

      await expect(
        service.update(user, mockBudget.id, {
          amount: 2000000,
          period: '2026-11',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('berhasil mengupdate amount dan rollover_enabled pada budget CATEGORY', async () => {
      const mockBudget = {
        id: 'b-cat',
        type: 'CATEGORY',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        category_id: mockCategory.id,
        scope_account_ids: [],
        created_at: new Date(),
        updated_at: new Date(),
      };
      const initialPeriod = {
        id: 'bp-1',
        budget_id: mockBudget.id,
        period: '2026-11',
        base_amount: 1500000n,
        carryover_amount: 100000n,
        locked_at: null,
        categories: [
          {
            id: 'bc-1',
            budget_period_id: 'bp-1',
            category_id: mockCategory.id,
            amount: 1500000n,
            rollover_enabled: false,
            carryover_amount: 100000n,
            rollover_config: {
              id: 'rc-1',
              budget_category_id: 'bc-1',
              enabled: false,
            },
          },
        ],
      };
      const updatedPeriod = {
        ...initialPeriod,
        base_amount: 1800000n,
        categories: [
          {
            ...initialPeriod.categories[0],
            amount: 1800000n,
            rollover_enabled: true,
          },
        ],
      };

      prisma.budget.findFirst.mockResolvedValueOnce(mockBudget);
      prisma.budgetPeriod.findFirst.mockResolvedValueOnce(initialPeriod);
      prisma.budgetPeriod.update.mockResolvedValueOnce(updatedPeriod);
      prisma.budgetCategory.update.mockResolvedValueOnce(updatedPeriod.categories[0]);
      prisma.rolloverConfig.update.mockResolvedValueOnce({ id: 'rc-1', enabled: true });

      const res = await service.update(user, mockBudget.id, {
        amount: 1800000,
        rollover_enabled: true,
        period: '2026-11',
      });

      expect(res.amount).toBe(1800000);
      expect(res.rollover_enabled).toBe(true);
      expect(res.carryover_amount).toBe(100000);
      expect(prisma.budgetPeriod.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: initialPeriod.id },
          data: { base_amount: 1800000n },
        }),
      );
      expect(prisma.budgetCategory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: initialPeriod.categories[0].id },
          data: { amount: 1800000n, rollover_enabled: true },
        }),
      );
      expect(prisma.rolloverConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rc-1' },
          data: { enabled: true },
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'BUDGET_UPDATE',
            resource_type: 'budget',
            resource_id: mockBudget.id,
          }),
        }),
      );
    });
  });

  describe('getOwnedBudget', () => {
    it('mengembalikan budget jika ditemukan', async () => {
      const mockBudget = { id: 'b-1', user_id: user.userId };
      prisma.budget.findFirst.mockResolvedValueOnce(mockBudget);

      const res = await service.getOwnedBudget(user.userId, 'b-1');
      expect(res).toEqual(mockBudget);
      expect(prisma.budget.findFirst).toHaveBeenCalledWith({
        where: { id: 'b-1', user_id: user.userId },
      });
    });

    it('melempar 404 BUDGET_NOT_FOUND jika budget tidak ditemukan', async () => {
      prisma.budget.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.getOwnedBudget(user.userId, 'b-missing'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('computeUsageForPeriod & getOverview', () => {
    const catMakanan = {
      id: 'cat-makanan',
      user_id: user.userId,
      name: 'Makanan',
      parent_id: null,
      type: 'EXPENSE',
      archived: false,
    };
    const catMakanSiang = {
      id: 'cat-makansiang',
      user_id: user.userId,
      name: 'Makan Siang',
      parent_id: 'cat-makanan',
      type: 'EXPENSE',
      archived: false,
    };
    const catTransport = {
      id: 'cat-transport',
      user_id: user.userId,
      name: 'Transportasi',
      parent_id: null,
      type: 'EXPENSE',
      archived: false,
    };

    it('AC-1: Rollup 1 level subkategori dan perhitungan budget total serta kategori', async () => {
      const budgetTotal = {
        id: 'b-total',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        type: 'TOTAL',
        category_id: null,
        scope_account_ids: [],
        periods: [
          {
            id: 'bp-total-1',
            budget_id: 'b-total',
            period: '2026-11',
            base_amount: 1000000n,
            carryover_amount: 0n,
            locked_at: null,
            categories: [],
          },
        ],
      };

      const budgetMakanan = {
        id: 'b-makanan',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        type: 'CATEGORY',
        category_id: 'cat-makanan',
        scope_account_ids: [],
        periods: [
          {
            id: 'bp-makanan-1',
            budget_id: 'b-makanan',
            period: '2026-11',
            base_amount: 500000n,
            carryover_amount: 100000n,
            locked_at: null,
            categories: [{ amount: 500000n, rollover_enabled: true, carryover_amount: 100000n }],
          },
        ],
      };

      prisma.budget.findMany.mockResolvedValueOnce([budgetTotal, budgetMakanan]);
      prisma.category.findMany.mockResolvedValueOnce([catMakanan, catMakanSiang, catTransport]);
      prisma.transaction.findMany.mockResolvedValueOnce([
        {
          id: 'tx-1',
          account_id: mockAccountA.id,
          category_id: 'cat-makanan',
          amount: 150000n,
          type: 'EXPENSE',
          status: 'POSTED',
          splits: [],
        },
        {
          id: 'tx-2',
          account_id: mockAccountA.id,
          category_id: 'cat-makansiang',
          amount: 90000n,
          type: 'EXPENSE',
          status: 'POSTED',
          splits: [],
        },
      ]);

      const res = await service.getOverview(user.userId, '2026-11');

      expect(res.period).toBe('2026-11');
      expect(res.total_budget).not.toBeNull();
      expect(res.total_budget!.base_amount).toBe(1000000);
      expect(res.total_budget!.effective_amount).toBe(1000000);
      expect(res.total_budget!.spent_amount).toBe(240000);
      expect(res.total_budget!.remaining_amount).toBe(760000);
      expect(res.total_budget!.usage_percent).toBe(24);
      expect(res.total_budget!.status_level).toBe('NORMAL');

      expect(res.category_budgets.length).toBe(1);
      const makananItem = res.category_budgets[0];
      expect(makananItem.category_name).toBe('Makanan');
      expect(makananItem.base_amount).toBe(500000);
      expect(makananItem.carryover_amount).toBe(100000);
      expect(makananItem.effective_amount).toBe(600000);
      expect(makananItem.spent_amount).toBe(240000);
      expect(makananItem.remaining_amount).toBe(360000);
      expect(makananItem.usage_percent).toBe(40);
      expect(makananItem.status_level).toBe('NORMAL');
    });

    it('AC-2: Split kategori dijumlahkan sesuai kategori dan budget Total satu kali', async () => {
      const budgetTotal = {
        id: 'b-total',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        type: 'TOTAL',
        category_id: null,
        scope_account_ids: [],
        periods: [
          {
            id: 'bp-total-1',
            budget_id: 'b-total',
            period: '2026-11',
            base_amount: 1000000n,
            carryover_amount: 0n,
            locked_at: null,
            categories: [],
          },
        ],
      };

      const budgetMakanan = {
        id: 'b-makanan',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        type: 'CATEGORY',
        category_id: 'cat-makanan',
        scope_account_ids: [],
        periods: [
          {
            id: 'bp-makanan-1',
            budget_id: 'b-makanan',
            period: '2026-11',
            base_amount: 500000n,
            carryover_amount: 0n,
            locked_at: null,
            categories: [{ amount: 500000n, rollover_enabled: false, carryover_amount: 0n }],
          },
        ],
      };

      const budgetTransport = {
        id: 'b-transport',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        type: 'CATEGORY',
        category_id: 'cat-transport',
        scope_account_ids: [],
        periods: [
          {
            id: 'bp-trans-1',
            budget_id: 'b-transport',
            period: '2026-11',
            base_amount: 300000n,
            carryover_amount: 0n,
            locked_at: null,
            categories: [{ amount: 300000n, rollover_enabled: false, carryover_amount: 0n }],
          },
        ],
      };

      prisma.budget.findMany.mockResolvedValueOnce([budgetTotal, budgetMakanan, budgetTransport]);
      prisma.category.findMany.mockResolvedValueOnce([catMakanan, catMakanSiang, catTransport]);
      prisma.transaction.findMany.mockResolvedValueOnce([
        {
          id: 'tx-split-1',
          account_id: mockAccountA.id,
          amount: 100000n,
          type: 'EXPENSE',
          status: 'POSTED',
          splits: [
            { category_id: 'cat-makanan', amount: 40000n },
            { category_id: 'cat-transport', amount: 60000n },
          ],
        },
      ]);

      const res = await service.getOverview(user.userId, '2026-11');

      expect(res.total_budget!.spent_amount).toBe(100000);
      const makananItem = res.category_budgets.find((b) => b.category_id === 'cat-makanan');
      const transportItem = res.category_budgets.find((b) => b.category_id === 'cat-transport');
      expect(makananItem!.spent_amount).toBe(40000);
      expect(transportItem!.spent_amount).toBe(60000);
    });

    it('AC-5: Budget dengan scope akun mengabaikan transaksi di luar cakupan', async () => {
      const budgetScoped = {
        id: 'b-scoped',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        type: 'TOTAL',
        category_id: null,
        scope_account_ids: [mockAccountA.id],
        periods: [
          {
            id: 'bp-1',
            budget_id: 'b-scoped',
            period: '2026-11',
            base_amount: 1000000n,
            carryover_amount: 0n,
            locked_at: null,
            categories: [],
          },
        ],
      };

      prisma.budget.findMany.mockResolvedValueOnce([budgetScoped]);
      prisma.category.findMany.mockResolvedValueOnce([catMakanan]);
      prisma.transaction.findMany.mockResolvedValueOnce([
        {
          id: 'tx-1',
          account_id: mockAccountA.id, // In scope
          amount: 50000n,
          type: 'EXPENSE',
          status: 'POSTED',
          splits: [],
        },
        {
          id: 'tx-2',
          account_id: mockAccountB.id, // Out of scope
          amount: 70000n,
          type: 'EXPENSE',
          status: 'POSTED',
          splits: [],
        },
      ]);

      const res = await service.getOverview(user.userId, '2026-11');
      expect(res.total_budget!.spent_amount).toBe(50000);
    });

    it('Subkategori spesifik tidak menghitung transaksi dari induk', async () => {
      const budgetSubcat = {
        id: 'b-sub',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        type: 'CATEGORY',
        category_id: 'cat-makansiang', // subkategori
        scope_account_ids: [],
        periods: [
          {
            id: 'bp-1',
            budget_id: 'b-sub',
            period: '2026-11',
            base_amount: 200000n,
            carryover_amount: 0n,
            locked_at: null,
            categories: [{ amount: 200000n, rollover_enabled: false, carryover_amount: 0n }],
          },
        ],
      };

      prisma.budget.findMany.mockResolvedValueOnce([budgetSubcat]);
      prisma.category.findMany.mockResolvedValueOnce([catMakanan, catMakanSiang]);
      prisma.transaction.findMany.mockResolvedValueOnce([
        {
          id: 'tx-1',
          account_id: mockAccountA.id,
          category_id: 'cat-makanan', // Parent - should be ignored
          amount: 50000n,
          type: 'EXPENSE',
          status: 'POSTED',
          splits: [],
        },
        {
          id: 'tx-2',
          account_id: mockAccountA.id,
          category_id: 'cat-makansiang', // Match
          amount: 30000n,
          type: 'EXPENSE',
          status: 'POSTED',
          splits: [],
        },
      ]);

      const res = await service.getOverview(user.userId, '2026-11');
      expect(res.category_budgets[0].spent_amount).toBe(30000);
    });

    it('Status levels: mengembalikan WARNING_80 dan EXCEEDED_100 secara tepat', async () => {
      const budget1 = {
        id: 'b-1',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        type: 'TOTAL',
        category_id: null,
        scope_account_ids: [],
        periods: [
          {
            id: 'bp-1',
            budget_id: 'b-1',
            period: '2026-11',
            base_amount: 100000n,
            carryover_amount: 0n,
            locked_at: null,
            categories: [],
          },
        ],
      };

      prisma.budget.findMany.mockResolvedValueOnce([budget1]);
      prisma.category.findMany.mockResolvedValueOnce([]);
      prisma.transaction.findMany.mockResolvedValueOnce([
        {
          id: 'tx-1',
          account_id: mockAccountA.id,
          amount: 80000n,
          type: 'EXPENSE',
          status: 'POSTED',
          splits: [],
        },
      ]);

      const res80 = await service.getOverview(user.userId, '2026-11');
      expect(res80.total_budget!.status_level).toBe('WARNING_80');

      // EXCEEDED_100
      prisma.budget.findMany.mockResolvedValueOnce([budget1]);
      prisma.category.findMany.mockResolvedValueOnce([]);
      prisma.transaction.findMany.mockResolvedValueOnce([
        {
          id: 'tx-1',
          account_id: mockAccountA.id,
          amount: 100000n,
          type: 'EXPENSE',
          status: 'POSTED',
          splits: [],
        },
      ]);

      const res100 = await service.getOverview(user.userId, '2026-11');
      expect(res100.total_budget!.status_level).toBe('EXCEEDED_100');
    });

    it('melewatkan query transaksi jika tidak ada BudgetPeriod pada targetPeriod', async () => {
      prisma.budget.findMany.mockResolvedValueOnce([]);
      prisma.category.findMany.mockResolvedValueOnce([]);

      const res = await service.getOverview(user.userId, '2026-11');

      expect(prisma.transaction.findMany).not.toHaveBeenCalled();
      expect(res.total_budget).toBeNull();
      expect(res.category_budgets).toEqual([]);
    });
  });

  describe('getSingleUsage', () => {
    it('mengembalikan usage item untuk budget yang diminta', async () => {
      const budget = {
        id: 'b-single',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        type: 'TOTAL',
        category_id: null,
        scope_account_ids: [],
        periods: [
          {
            id: 'bp-1',
            budget_id: 'b-single',
            period: '2026-11',
            base_amount: 1000000n,
            carryover_amount: 0n,
            locked_at: null,
            categories: [],
          },
        ],
      };

      prisma.budget.findFirst.mockResolvedValueOnce(budget);
      prisma.budget.findMany.mockResolvedValueOnce([budget]);
      prisma.category.findMany.mockResolvedValueOnce([]);
      prisma.transaction.findMany.mockResolvedValueOnce([]);

      const res = await service.getSingleUsage(user.userId, 'b-single', '2026-11');
      expect(res.id).toBe('b-single');
      expect(res.base_amount).toBe(1000000);
    });

    it('melempar 404 BUDGET_NOT_FOUND jika budget tidak memiliki BudgetPeriod pada periode tersebut', async () => {
      const budget = {
        id: 'b-single',
        user_id: user.userId,
        financial_profile_id: mockProfile.id,
        type: 'TOTAL',
        category_id: null,
        scope_account_ids: [],
        periods: [],
      };

      prisma.budget.findFirst.mockResolvedValueOnce(budget);
      prisma.budget.findMany.mockResolvedValueOnce([budget]);
      prisma.category.findMany.mockResolvedValueOnce([]);

      await expect(
        service.getSingleUsage(user.userId, 'b-single', '2026-11'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
