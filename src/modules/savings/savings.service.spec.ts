import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SavingsGoalStatus } from '@prisma/client';
import {
  SavingsService,
  toSavingsGoalResponse,
  toAllocationResponse,
} from './savings.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('SavingsService', () => {
  let service: SavingsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      financialProfile: {
        findFirst: jest.fn(),
      },
      userPreference: {
        findFirst: jest.fn(),
      },
      savingsGoal: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      savingsAllocation: {
        create: jest.fn(),
        aggregate: jest.fn(),
        count: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      $queryRaw: jest.fn(),
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavingsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<SavingsService>(SavingsService);
  });

  describe('toSavingsGoalResponse', () => {
    it('mengonversi BigInt ke number, memformat target_date YYYY-MM-DD, dan menghitung progress_percent integer tanpa float', () => {
      const mockGoal = {
        id: 'goal-1',
        name: 'Dana Darurat',
        target_amount: 10000000n,
        target_date: new Date('2027-06-01T00:00:00.000Z'),
        note: 'Untuk darurat',
        status: SavingsGoalStatus.ACTIVE,
        achieved_at: null,
        created_at: new Date('2026-11-04T10:00:00.000Z'),
        updated_at: new Date('2026-11-04T10:00:00.000Z'),
      };

      const res = toSavingsGoalResponse(mockGoal, 2500000n);
      expect(res).toEqual({
        id: 'goal-1',
        name: 'Dana Darurat',
        target_amount: 10000000,
        current_amount: 2500000,
        remaining_amount: 7500000,
        progress_percent: 25,
        target_date: '2027-06-01',
        note: 'Untuk darurat',
        status: 'ACTIVE',
        achieved_at: null,
        created_at: mockGoal.created_at,
        updated_at: mockGoal.updated_at,
      });
    });

    it('menghandle target_date null dan remaining_amount 0 saat alokasi melebihi target', () => {
      const mockGoal = {
        id: 'goal-2',
        name: 'Liburan',
        target_amount: 5000000n,
        target_date: null,
        note: null,
        status: SavingsGoalStatus.ACHIEVED,
        achieved_at: new Date('2026-11-05T10:00:00.000Z'),
        created_at: new Date('2026-11-04T10:00:00.000Z'),
        updated_at: new Date('2026-11-05T10:00:00.000Z'),
      };

      const res = toSavingsGoalResponse(mockGoal, 6000000n);
      expect(res.remaining_amount).toBe(0);
      expect(res.progress_percent).toBe(120);
      expect(res.target_date).toBeNull();
    });
  });

  describe('createGoal', () => {
    const user = { userId: 'user-1', role: 'USER' };
    const defaultProfile = { id: 'prof-1', user_id: 'user-1', is_default: true };

    it('AC-1: berhasil membuat target tabungan dengan status ACTIVE dan audit log SAVINGS_GOAL_CREATE', async () => {
      prisma.financialProfile.findFirst.mockResolvedValue(defaultProfile);
      prisma.userPreference.findFirst.mockResolvedValue({ timezone: 'Asia/Jakarta' });

      const createdGoal = {
        id: 'goal-123',
        user_id: user.userId,
        financial_profile_id: defaultProfile.id,
        name: 'Dana Darurat',
        target_amount: 5000000n,
        target_date: new Date('2027-06-01T00:00:00.000Z'),
        note: null,
        status: SavingsGoalStatus.ACTIVE,
        achieved_at: null,
        created_at: new Date('2026-11-11T10:00:00.000Z'),
        updated_at: new Date('2026-11-11T10:00:00.000Z'),
      };

      prisma.savingsGoal.create.mockResolvedValue(createdGoal);

      const res = await service.createGoal(user, {
        name: 'Dana Darurat',
        target_amount: 5000000,
        target_date: '2027-06-01',
      });

      expect(res).toEqual({
        id: 'goal-123',
        name: 'Dana Darurat',
        target_amount: 5000000,
        current_amount: 0,
        remaining_amount: 5000000,
        progress_percent: 0,
        target_date: '2027-06-01',
        note: null,
        status: 'ACTIVE',
        achieved_at: null,
        created_at: createdGoal.created_at,
        updated_at: createdGoal.updated_at,
      });

      expect(prisma.savingsGoal.create).toHaveBeenCalledWith({
        data: {
          user_id: user.userId,
          financial_profile_id: defaultProfile.id,
          name: 'Dana Darurat',
          target_amount: 5000000n,
          target_date: new Date('2027-06-01T00:00:00.000Z'),
          note: null,
        },
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SAVINGS_GOAL_CREATE',
          resource_type: 'savings_goal',
          resource_id: 'goal-123',
          actor_user_id: user.userId,
          actor_role: 'USER',
        }),
      });
    });

    it('AC-3: melempar 400 VALIDATION_ERROR jika target_date di masa lalu saat create', async () => {
      prisma.financialProfile.findFirst.mockResolvedValue(defaultProfile);
      prisma.userPreference.findFirst.mockResolvedValue({ timezone: 'Asia/Jakarta' });

      await expect(
        service.createGoal(user, {
          name: 'Dana Liburan',
          target_amount: 1000000,
          target_date: '2020-01-01',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('melempar 404 PROFILE_NOT_FOUND jika profil keuangan default tidak ditemukan', async () => {
      prisma.financialProfile.findFirst.mockResolvedValue(null);

      await expect(
        service.createGoal(user, {
          name: 'Dana Darurat',
          target_amount: 5000000,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateGoal', () => {
    const user = { userId: 'user-1', role: 'USER' };
    const goalId = 'goal-123';

    it('AC-4: berhasil memperbarui goal dan mencatat audit log SAVINGS_GOAL_UPDATE', async () => {
      prisma.userPreference.findFirst.mockResolvedValue({ timezone: 'Asia/Jakarta' });

      const existingGoal = {
        id: goalId,
        financial_profile_id: 'prof-1',
        user_id: user.userId,
        name: 'Target Lama',
        target_amount: 5000000n,
        target_date: new Date('2027-06-01T00:00:00.000Z'),
        note: 'Catatan lama',
        status: SavingsGoalStatus.ACTIVE,
        achieved_at: null,
        created_at: new Date('2026-11-04T10:00:00.000Z'),
        updated_at: new Date('2026-11-04T10:00:00.000Z'),
      };

      prisma.$queryRaw.mockResolvedValue([existingGoal]);
      prisma.savingsAllocation.aggregate.mockResolvedValue({ _sum: { amount: 1000000n } });

      const updatedGoal = {
        ...existingGoal,
        name: 'Target Baru',
        target_amount: 6000000n,
        note: 'Catatan baru',
        updated_at: new Date('2026-11-11T10:00:00.000Z'),
      };
      prisma.savingsGoal.update.mockResolvedValue(updatedGoal);

      const res = await service.updateGoal(user, goalId, {
        name: 'Target Baru',
        target_amount: 6000000,
        note: 'Catatan baru',
      });

      expect(res.name).toBe('Target Baru');
      expect(res.target_amount).toBe(6000000);
      expect(res.current_amount).toBe(1000000);
      expect(res.remaining_amount).toBe(5000000);
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SAVINGS_GOAL_UPDATE',
          resource_type: 'savings_goal',
          resource_id: goalId,
          actor_user_id: user.userId,
        }),
      });
    });

    it('AC-4: melempar 409 GOAL_ARCHIVED jika target sudah diarsipkan', async () => {
      const archivedGoal = {
        id: goalId,
        financial_profile_id: 'prof-1',
        user_id: user.userId,
        name: 'Target Arsip',
        target_amount: 5000000n,
        target_date: null,
        note: null,
        status: SavingsGoalStatus.ARCHIVED,
        achieved_at: null,
        created_at: new Date('2026-11-04T10:00:00.000Z'),
        updated_at: new Date('2026-11-04T10:00:00.000Z'),
      };

      prisma.$queryRaw.mockResolvedValue([archivedGoal]);

      await expect(
        service.updateGoal(user, goalId, {
          name: 'Coba Edit',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('melempar 404 GOAL_NOT_FOUND jika goal tidak ditemukan', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(
        service.updateGoal(user, 'goal-non-existent', {
          name: 'Coba Edit',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('melempar 400 VALIDATION_ERROR jika target_date yang diupdate di masa lalu', async () => {
      prisma.userPreference.findFirst.mockResolvedValue({ timezone: 'Asia/Jakarta' });

      await expect(
        service.updateGoal(user, goalId, {
          target_date: '2020-01-01',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('mengubah status ke ACHIEVED saat target_amount diturunkan ke <= current_amount', async () => {
      const existingGoal = {
        id: goalId,
        financial_profile_id: 'prof-1',
        user_id: user.userId,
        name: 'Target Mobil',
        target_amount: 10000000n,
        target_date: null,
        note: null,
        status: SavingsGoalStatus.ACTIVE,
        achieved_at: null,
        created_at: new Date('2026-11-04T10:00:00.000Z'),
        updated_at: new Date('2026-11-04T10:00:00.000Z'),
      };

      prisma.$queryRaw.mockResolvedValue([existingGoal]);
      prisma.savingsAllocation.aggregate.mockResolvedValue({ _sum: { amount: 5000000n } });

      const updatedGoal = {
        ...existingGoal,
        target_amount: 5000000n,
      };
      prisma.savingsGoal.update
        .mockResolvedValueOnce(updatedGoal) // update input
        .mockResolvedValueOnce({
          ...updatedGoal,
          status: SavingsGoalStatus.ACHIEVED,
          achieved_at: new Date('2026-11-11T10:00:00.000Z'),
        }); // reconcile status

      const res = await service.updateGoal(user, goalId, {
        target_amount: 5000000,
      });

      expect(res.status).toBe('ACHIEVED');
      expect(res.achieved_at).not.toBeNull();
    });
  });

  describe('archiveGoal', () => {
    const user = { userId: 'user-1', role: 'USER' };
    const goalId = 'goal-123';

    it('AC-5: berhasil mengarsipkan target tanpa alokasi aktif dan mencatat audit log SAVINGS_GOAL_ARCHIVE', async () => {
      const existingGoal = {
        id: goalId,
        financial_profile_id: 'prof-1',
        user_id: user.userId,
        name: 'Target Siap Arsip',
        target_amount: 5000000n,
        target_date: null,
        note: null,
        status: SavingsGoalStatus.ACTIVE,
        achieved_at: null,
        created_at: new Date('2026-11-04T10:00:00.000Z'),
        updated_at: new Date('2026-11-04T10:00:00.000Z'),
      };

      prisma.$queryRaw.mockResolvedValue([existingGoal]);
      prisma.savingsAllocation.count.mockResolvedValue(0);

      const archivedGoal = {
        ...existingGoal,
        status: SavingsGoalStatus.ARCHIVED,
      };
      prisma.savingsGoal.update.mockResolvedValue(archivedGoal);

      const res = await service.archiveGoal(user, goalId);

      expect(res.status).toBe('ARCHIVED');
      expect(prisma.savingsGoal.update).toHaveBeenCalledWith({
        where: {
          id: goalId,
          user_id: user.userId,
        },
        data: {
          status: 'ARCHIVED',
        },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SAVINGS_GOAL_ARCHIVE',
          resource_type: 'savings_goal',
          resource_id: goalId,
          actor_user_id: user.userId,
        }),
      });
    });

    it('AC-5: idempoten jika sudah berstatus ARCHIVED: return tanpa update/audit ulang', async () => {
      const archivedGoal = {
        id: goalId,
        financial_profile_id: 'prof-1',
        user_id: user.userId,
        name: 'Target Sudah Arsip',
        target_amount: 5000000n,
        target_date: null,
        note: null,
        status: SavingsGoalStatus.ARCHIVED,
        achieved_at: null,
        created_at: new Date('2026-11-04T10:00:00.000Z'),
        updated_at: new Date('2026-11-04T10:00:00.000Z'),
      };

      prisma.$queryRaw.mockResolvedValue([archivedGoal]);
      prisma.savingsAllocation.aggregate.mockResolvedValue({ _sum: { amount: 0n } });

      const res = await service.archiveGoal(user, goalId);

      expect(res.status).toBe('ARCHIVED');
      expect(prisma.savingsGoal.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('AC-5: melempar 409 GOAL_HAS_ACTIVE_ALLOCATIONS jika alokasi aktif > 0', async () => {
      const activeGoal = {
        id: goalId,
        financial_profile_id: 'prof-1',
        user_id: user.userId,
        name: 'Target Ada Alokasi',
        target_amount: 5000000n,
        target_date: null,
        note: null,
        status: SavingsGoalStatus.ACTIVE,
        achieved_at: null,
        created_at: new Date('2026-11-04T10:00:00.000Z'),
        updated_at: new Date('2026-11-04T10:00:00.000Z'),
      };

      prisma.$queryRaw.mockResolvedValue([activeGoal]);
      prisma.savingsAllocation.count.mockResolvedValue(2);

      await expect(service.archiveGoal(user, goalId)).rejects.toThrow(ConflictException);
      expect(prisma.savingsGoal.update).not.toHaveBeenCalled();
    });

    it('melempar 404 GOAL_NOT_FOUND jika goal tidak ditemukan', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.archiveGoal(user, 'unknown-goal')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getOwnedGoal', () => {
    it('mengembalikan goal jika ditemukan milik user', async () => {
      const mockGoal = {
        id: 'goal-1',
        user_id: 'user-1',
        name: 'Target 1',
      };
      prisma.savingsGoal.findFirst.mockResolvedValue(mockGoal);

      const res = await service.getOwnedGoal('user-1', 'goal-1');
      expect(res).toBe(mockGoal);
    });

    it('melempar 404 GOAL_NOT_FOUND jika goal tidak ditemukan', async () => {
      prisma.savingsGoal.findFirst.mockResolvedValue(null);

      await expect(service.getOwnedGoal('user-1', 'goal-missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('reconcileGoalStatusTx', () => {
    const now = new Date('2026-11-11T12:00:00.000Z');

    it('tidak mengubah apa pun jika status ARCHIVED', async () => {
      const goal = {
        id: 'goal-1',
        user_id: 'user-1',
        target_amount: 1000000n,
        status: SavingsGoalStatus.ARCHIVED,
        achieved_at: null,
      };

      const res = await service.reconcileGoalStatusTx(prisma, goal, 2000000n, now);
      expect(res).toBe(goal);
      expect(prisma.savingsGoal.update).not.toHaveBeenCalled();
    });

    it('mengubah status ACTIVE ke ACHIEVED jika currentAmount >= target_amount', async () => {
      const goal = {
        id: 'goal-1',
        user_id: 'user-1',
        target_amount: 1000000n,
        status: SavingsGoalStatus.ACTIVE,
        achieved_at: null,
      };

      prisma.savingsGoal.update.mockResolvedValue({
        ...goal,
        status: SavingsGoalStatus.ACHIEVED,
        achieved_at: now,
      });

      const res = await service.reconcileGoalStatusTx(prisma, goal, 1000000n, now);
      expect(res.status).toBe(SavingsGoalStatus.ACHIEVED);
      expect(prisma.savingsGoal.update).toHaveBeenCalledWith({
        where: { id: 'goal-1', user_id: 'user-1' },
        data: { status: 'ACHIEVED', achieved_at: now },
      });
    });

    it('mengembalikan status ACHIEVED ke ACTIVE jika currentAmount < target_amount', async () => {
      const goal = {
        id: 'goal-1',
        user_id: 'user-1',
        target_amount: 2000000n,
        status: SavingsGoalStatus.ACHIEVED,
        achieved_at: new Date('2026-11-01T00:00:00.000Z'),
      };

      prisma.savingsGoal.update.mockResolvedValue({
        ...goal,
        status: SavingsGoalStatus.ACTIVE,
        achieved_at: null,
      });

      const res = await service.reconcileGoalStatusTx(prisma, goal, 1500000n, now);
      expect(res.status).toBe(SavingsGoalStatus.ACTIVE);
      expect(prisma.savingsGoal.update).toHaveBeenCalledWith({
        where: { id: 'goal-1', user_id: 'user-1' },
        data: { status: 'ACTIVE', achieved_at: null },
      });
    });
  });

  describe('toAllocationResponse', () => {
    it('mengonversi nominal bigint ke number', () => {
      const mockAlloc = {
        id: 'alloc-1',
        savings_goal_id: 'goal-1',
        account_id: 'acc-1',
        amount: 500000n,
        status: 'ACTIVE',
        allocated_at: new Date('2026-11-11T10:00:00.000Z'),
        released_at: null,
        release_reason: null,
      };

      const res = toAllocationResponse(mockAlloc);
      expect(res).toEqual({
        id: 'alloc-1',
        savings_goal_id: 'goal-1',
        account_id: 'acc-1',
        amount: 500000,
        status: 'ACTIVE',
        allocated_at: mockAlloc.allocated_at,
        released_at: null,
        release_reason: null,
      });
    });
  });

  describe('allocate', () => {
    const user = { userId: 'user-1', role: 'USER' };
    const goalId = 'goal-1';
    const accountId = 'acc-1';

    const mockGoalRow = {
      id: goalId,
      financial_profile_id: 'prof-1',
      user_id: user.userId,
      name: 'Dana Darurat',
      target_amount: 2000000n,
      target_date: null,
      note: null,
      status: SavingsGoalStatus.ACTIVE,
      achieved_at: null,
      created_at: new Date('2026-11-04T10:00:00.000Z'),
      updated_at: new Date('2026-11-04T10:00:00.000Z'),
    };

    const mockAccountRow = {
      id: accountId,
      name: 'BCA',
      type: 'BANK',
      balance: 1000000n,
      archived: false,
    };

    it('AC-1: berhasil membuat alokasi, menghitung account_available, tanpa mutasi balance akun & mencatat audit log', async () => {
      // Mock goal lock & account lock
      prisma.$queryRaw
        .mockResolvedValueOnce([mockGoalRow])
        .mockResolvedValueOnce([mockAccountRow]);

      // Mock account reserved calculation: 0n reserved
      prisma.savingsAllocation.aggregate
        .mockResolvedValueOnce({ _sum: { amount: null } }) // account reserved
        .mockResolvedValueOnce({ _sum: { amount: 400000n } }); // newGoalSum

      const createdAllocation = {
        id: 'alloc-1',
        savings_goal_id: goalId,
        account_id: accountId,
        amount: 400000n,
        status: 'ACTIVE',
        allocated_at: new Date('2026-11-11T10:00:00.000Z'),
        released_at: null,
        release_reason: null,
      };
      prisma.savingsAllocation.create.mockResolvedValue(createdAllocation);

      const res = await service.allocate(user, goalId, {
        account_id: accountId,
        amount: 400000,
      });

      expect(res.allocation).toEqual({
        id: 'alloc-1',
        savings_goal_id: goalId,
        account_id: accountId,
        amount: 400000,
        status: 'ACTIVE',
        allocated_at: createdAllocation.allocated_at,
        released_at: null,
        release_reason: null,
      });
      expect(res.account_available).toBe(600000);
      expect(res.goal.current_amount).toBe(400000);
      expect(res.goal.remaining_amount).toBe(1600000);

      expect(prisma.savingsAllocation.create).toHaveBeenCalledWith({
        data: {
          savings_goal_id: goalId,
          account_id: accountId,
          amount: 400000n,
          status: 'ACTIVE',
        },
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SAVINGS_ALLOCATE',
          resource_type: 'savings_allocation',
          resource_id: 'alloc-1',
          actor_user_id: user.userId,
          after: expect.objectContaining({
            account_balance_unchanged: 1000000,
          }),
        }),
      });
    });

    it('AC-2: melempar 409 INSUFFICIENT_AVAILABLE_BALANCE jika amount > available', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([mockGoalRow])
        .mockResolvedValueOnce([mockAccountRow]);

      // Reserved 400.000 -> available = 600.000
      prisma.savingsAllocation.aggregate.mockResolvedValueOnce({
        _sum: { amount: 400000n },
      });

      await expect(
        service.allocate(user, goalId, {
          account_id: accountId,
          amount: 700000,
        }),
      ).rejects.toThrow(ConflictException);

      expect(prisma.savingsAllocation.create).not.toHaveBeenCalled();
    });

    it('AC-3: melempar 409 INSUFFICIENT_AVAILABLE_BALANCE jika saldo akun <= 0', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([mockGoalRow])
        .mockResolvedValueOnce([{ ...mockAccountRow, balance: -50000n }]);

      prisma.savingsAllocation.aggregate.mockResolvedValueOnce({
        _sum: { amount: 0n },
      });

      await expect(
        service.allocate(user, goalId, {
          account_id: accountId,
          amount: 100000,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('AC-3: melempar 409 ACCOUNT_ARCHIVED jika akun berstatus archived', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([mockGoalRow])
        .mockResolvedValueOnce([{ ...mockAccountRow, archived: true }]);

      await expect(
        service.allocate(user, goalId, {
          account_id: accountId,
          amount: 100000,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('AC-3: melempar 422 ACCOUNT_TYPE_NOT_ALLOCATABLE jika akun tipe INVESTMENT atau RECEIVABLE', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([mockGoalRow])
        .mockResolvedValueOnce([{ ...mockAccountRow, type: 'INVESTMENT' }]);

      await expect(
        service.allocate(user, goalId, {
          account_id: accountId,
          amount: 100000,
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      prisma.$queryRaw
        .mockResolvedValueOnce([mockGoalRow])
        .mockResolvedValueOnce([{ ...mockAccountRow, type: 'RECEIVABLE' }]);

      await expect(
        service.allocate(user, goalId, {
          account_id: accountId,
          amount: 100000,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('AC-3: melempar 409 GOAL_ARCHIVED jika goal sudah berstatus ARCHIVED', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { ...mockGoalRow, status: SavingsGoalStatus.ARCHIVED },
      ]);

      await expect(
        service.allocate(user, goalId, {
          account_id: accountId,
          amount: 100000,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('AC-3: melempar 404 GOAL_NOT_FOUND jika goal tidak ditemukan', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(
        service.allocate(user, 'missing-goal', {
          account_id: accountId,
          amount: 100000,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('AC-3: melempar 404 ACCOUNT_NOT_FOUND jika account tidak ditemukan', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([mockGoalRow])
        .mockResolvedValueOnce([]);

      await expect(
        service.allocate(user, goalId, {
          account_id: 'missing-account',
          amount: 100000,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('AC-4: otomatis mengubah status goal menjadi ACHIEVED saat total alokasi >= target_amount', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([mockGoalRow])
        .mockResolvedValueOnce([{ ...mockAccountRow, balance: 3000000n }]);

      prisma.savingsAllocation.aggregate
        .mockResolvedValueOnce({ _sum: { amount: 0n } }) // account reserved
        .mockResolvedValueOnce({ _sum: { amount: 2000000n } }); // newGoalSum reaches 2.000.000 target

      const createdAllocation = {
        id: 'alloc-2',
        savings_goal_id: goalId,
        account_id: accountId,
        amount: 2000000n,
        status: 'ACTIVE',
        allocated_at: new Date('2026-11-11T10:00:00.000Z'),
        released_at: null,
        release_reason: null,
      };
      prisma.savingsAllocation.create.mockResolvedValue(createdAllocation);

      prisma.savingsGoal.update.mockResolvedValueOnce({
        ...mockGoalRow,
        status: SavingsGoalStatus.ACHIEVED,
        achieved_at: new Date('2026-11-11T10:00:00.000Z'),
      });

      const res = await service.allocate(user, goalId, {
        account_id: accountId,
        amount: 2000000,
      });

      expect(res.goal.status).toBe('ACHIEVED');
      expect(res.goal.achieved_at).not.toBeNull();
      expect(res.goal.progress_percent).toBe(100);
      expect(res.goal.remaining_amount).toBe(0);
    });
  });
});
