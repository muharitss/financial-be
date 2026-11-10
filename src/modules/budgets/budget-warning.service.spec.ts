import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { BudgetWarningService } from './budget-warning.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BudgetsService } from './budgets.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NotFoundException } from '@nestjs/common';

describe('BudgetWarningService Unit Tests', () => {
  let service: BudgetWarningService;
  let prismaMock: any;
  let budgetsServiceMock: any;
  let notificationsServiceMock: any;

  const userId = '018f0000-0000-7000-8000-000000000001';
  const period = '2026-11';
  const budgetId = '018f0000-0000-7000-8000-000000000002';

  beforeEach(async () => {
    prismaMock = {
      notificationPreference: {
        findUnique: jest.fn(),
      },
      asSystem: jest.fn().mockReturnThis(),
      $transaction: jest.fn(async (cb) => {
        return cb(prismaMock);
      }),
      $executeRaw: jest.fn().mockResolvedValue(1),
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
    };

    budgetsServiceMock = {
      computeUsageForPeriod: jest.fn(),
    };

    notificationsServiceMock = {
      dispatch: jest.fn(async (dto, _tx) => ({
        id: 'notif-1',
        user_id: dto.userId,
        type: dto.type,
        title: dto.title,
        body: dto.body,
        data: dto.data,
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetWarningService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: BudgetsService, useValue: budgetsServiceMock },
        { provide: NotificationsService, useValue: notificationsServiceMock },
      ],
    }).compile();

    service = module.get<BudgetWarningService>(BudgetWarningService);
  });

  describe('evaluateForPeriod', () => {
    it('returns immediately without calculation or lock if both budget_warning_80 & 100 are false', async () => {
      prismaMock.notificationPreference.findUnique.mockResolvedValueOnce({
        budget_warning_80: false,
        budget_warning_100: false,
      });

      const res = await service.evaluateForPeriod(userId, period);

      expect(res).toEqual([]);
      expect(budgetsServiceMock.computeUsageForPeriod).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('returns empty array if user has no financial profile (NotFoundException)', async () => {
      prismaMock.notificationPreference.findUnique.mockResolvedValueOnce(null);
      budgetsServiceMock.computeUsageForPeriod.mockRejectedValueOnce(
        new NotFoundException('Profil tidak ditemukan'),
      );

      const res = await service.evaluateForPeriod(userId, period);

      expect(res).toEqual([]);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('AC-1: dispatches BUDGET_WARNING_80 at 80% and does not resend at 85%', async () => {
      // Default preferences (both true)
      prismaMock.notificationPreference.findUnique.mockResolvedValue(null);

      // Usage at 80% (800k / 1M)
      budgetsServiceMock.computeUsageForPeriod.mockResolvedValueOnce({
        period,
        category_budgets: [
          {
            id: budgetId,
            type: 'CATEGORY',
            category_name: 'Makanan',
            effective_amount: 1000000,
            spent_amount: 800000,
            usage_percent: 80,
          },
        ],
      });

      prismaMock.notification.findMany.mockResolvedValueOnce([]);

      const res80 = await service.evaluateForPeriod(userId, period);

      expect(res80.length).toBe(1);
      expect(notificationsServiceMock.dispatch).toHaveBeenCalledTimes(1);
      const callArg = notificationsServiceMock.dispatch.mock.calls[0][0];
      expect(callArg.type).toBe('BUDGET_WARNING_80');
      expect(callArg.title).toBe('Anggaran Makanan mencapai 80%');
      expect(callArg.body).toBe('Anggaran Makanan telah mencapai 80% pada periode 2026-11.');
      expect(callArg.data).toEqual({
        budget_id: budgetId,
        period,
        threshold: 80,
        budget_type: 'CATEGORY',
        usage_percent: 80,
      });
      // No currency in title or body
      expect(callArg.title).not.toMatch(/Rp|\d{3}\.\d{3}/);
      expect(callArg.body).not.toMatch(/Rp|\d{3}\.\d{3}/);

      // Advisory lock was acquired
      expect(prismaMock.$executeRaw).toHaveBeenCalled();

      // Next check at 85% (850k / 1M): notification already exists
      notificationsServiceMock.dispatch.mockClear();
      budgetsServiceMock.computeUsageForPeriod.mockResolvedValueOnce({
        period,
        category_budgets: [
          {
            id: budgetId,
            type: 'CATEGORY',
            category_name: 'Makanan',
            effective_amount: 1000000,
            spent_amount: 850000,
            usage_percent: 85,
          },
        ],
      });

      prismaMock.notification.findMany.mockResolvedValueOnce([
        {
          type: 'BUDGET_WARNING_80',
          data: { budget_id: budgetId, period, threshold: 80 },
        },
      ]);

      const res85 = await service.evaluateForPeriod(userId, period);

      expect(res85.length).toBe(0);
      expect(notificationsServiceMock.dispatch).not.toHaveBeenCalled();
    });

    it('AC-2: dispatches BUDGET_WARNING_100 at 100% and does not resend at 110%', async () => {
      prismaMock.notificationPreference.findUnique.mockResolvedValue(null);

      // Already sent 80%
      prismaMock.notification.findMany.mockResolvedValueOnce([
        {
          type: 'BUDGET_WARNING_80',
          data: { budget_id: budgetId, period, threshold: 80 },
        },
      ]);

      // At 100% (1M / 1M)
      budgetsServiceMock.computeUsageForPeriod.mockResolvedValueOnce({
        period,
        category_budgets: [
          {
            id: budgetId,
            type: 'CATEGORY',
            category_name: 'Makanan',
            effective_amount: 1000000,
            spent_amount: 1000000,
            usage_percent: 100,
          },
        ],
      });

      const res100 = await service.evaluateForPeriod(userId, period);

      expect(res100.length).toBe(1);
      expect(notificationsServiceMock.dispatch).toHaveBeenCalledTimes(1);
      const callArg = notificationsServiceMock.dispatch.mock.calls[0][0];
      expect(callArg.type).toBe('BUDGET_WARNING_100');
      expect(callArg.title).toBe('Anggaran Makanan mencapai 100%');
      expect(callArg.data.threshold).toBe(100);

      // Next check at 110%: 100% already recorded
      notificationsServiceMock.dispatch.mockClear();
      prismaMock.notification.findMany.mockResolvedValueOnce([
        {
          type: 'BUDGET_WARNING_80',
          data: { budget_id: budgetId, period, threshold: 80 },
        },
        {
          type: 'BUDGET_WARNING_100',
          data: { budget_id: budgetId, period, threshold: 100 },
        },
      ]);

      budgetsServiceMock.computeUsageForPeriod.mockResolvedValueOnce({
        period,
        category_budgets: [
          {
            id: budgetId,
            type: 'CATEGORY',
            category_name: 'Makanan',
            effective_amount: 1000000,
            spent_amount: 1100000,
            usage_percent: 110,
          },
        ],
      });

      const res110 = await service.evaluateForPeriod(userId, period);

      expect(res110.length).toBe(0);
      expect(notificationsServiceMock.dispatch).not.toHaveBeenCalled();
    });

    it('AC-3: direct jump from 0% to 105% sends ONLY BUDGET_WARNING_100; reversal to 85% sends no 80%', async () => {
      prismaMock.notificationPreference.findUnique.mockResolvedValue(null);

      // Direct jump to 1.050.000 / 1.000.000 (105%)
      budgetsServiceMock.computeUsageForPeriod.mockResolvedValueOnce({
        period,
        category_budgets: [
          {
            id: budgetId,
            type: 'CATEGORY',
            category_name: 'Makanan',
            effective_amount: 1000000,
            spent_amount: 1050000,
            usage_percent: 105,
          },
        ],
      });

      prismaMock.notification.findMany.mockResolvedValueOnce([]);

      const resJump = await service.evaluateForPeriod(userId, period);

      expect(resJump.length).toBe(1);
      expect(notificationsServiceMock.dispatch).toHaveBeenCalledTimes(1);
      expect(notificationsServiceMock.dispatch.mock.calls[0][0].type).toBe(
        'BUDGET_WARNING_100',
      );

      // Reversal drops spending to 85% (850k / 1M)
      // Because BUDGET_WARNING_100 was already sent, BUDGET_WARNING_80 must NOT be sent
      notificationsServiceMock.dispatch.mockClear();
      prismaMock.notification.findMany.mockResolvedValueOnce([
        {
          type: 'BUDGET_WARNING_100',
          data: { budget_id: budgetId, period, threshold: 100 },
        },
      ]);

      budgetsServiceMock.computeUsageForPeriod.mockResolvedValueOnce({
        period,
        category_budgets: [
          {
            id: budgetId,
            type: 'CATEGORY',
            category_name: 'Makanan',
            effective_amount: 1000000,
            spent_amount: 850000,
            usage_percent: 85,
          },
        ],
      });

      const resAfterReversal = await service.evaluateForPeriod(userId, period);

      expect(resAfterReversal.length).toBe(0);
      expect(notificationsServiceMock.dispatch).not.toHaveBeenCalled();

      // Subsequent jump back to 105% also sends nothing duplicate
      prismaMock.notification.findMany.mockResolvedValueOnce([
        {
          type: 'BUDGET_WARNING_100',
          data: { budget_id: budgetId, period, threshold: 100 },
        },
      ]);
      budgetsServiceMock.computeUsageForPeriod.mockResolvedValueOnce({
        period,
        category_budgets: [
          {
            id: budgetId,
            type: 'CATEGORY',
            category_name: 'Makanan',
            effective_amount: 1000000,
            spent_amount: 1050000,
            usage_percent: 105,
          },
        ],
      });

      const resBackTo105 = await service.evaluateForPeriod(userId, period);
      expect(resBackTo105.length).toBe(0);
      expect(notificationsServiceMock.dispatch).not.toHaveBeenCalled();
    });

    it('AC-4: honors budget_warning_80 = false by skipping 80% warning', async () => {
      prismaMock.notificationPreference.findUnique.mockResolvedValue({
        budget_warning_80: false,
        budget_warning_100: true,
      });

      // At 80%
      budgetsServiceMock.computeUsageForPeriod.mockResolvedValueOnce({
        period,
        category_budgets: [
          {
            id: budgetId,
            type: 'CATEGORY',
            category_name: 'Makanan',
            effective_amount: 1000000,
            spent_amount: 800000,
            usage_percent: 80,
          },
        ],
      });
      prismaMock.notification.findMany.mockResolvedValueOnce([]);

      const res80 = await service.evaluateForPeriod(userId, period);
      expect(res80.length).toBe(0);
      expect(notificationsServiceMock.dispatch).not.toHaveBeenCalled();

      // Reaching 100% still sends BUDGET_WARNING_100
      budgetsServiceMock.computeUsageForPeriod.mockResolvedValueOnce({
        period,
        category_budgets: [
          {
            id: budgetId,
            type: 'CATEGORY',
            category_name: 'Makanan',
            effective_amount: 1000000,
            spent_amount: 1000000,
            usage_percent: 100,
          },
        ],
      });
      prismaMock.notification.findMany.mockResolvedValueOnce([]);

      const res100 = await service.evaluateForPeriod(userId, period);
      expect(res100.length).toBe(1);
      expect(notificationsServiceMock.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'BUDGET_WARNING_100' }),
        expect.anything(),
      );
    });

    it('evaluates total_budget when present', async () => {
      prismaMock.notificationPreference.findUnique.mockResolvedValue(null);

      budgetsServiceMock.computeUsageForPeriod.mockResolvedValueOnce({
        period,
        total_budget: {
          id: 'total-budget-id',
          type: 'TOTAL',
          effective_amount: 5000000,
          spent_amount: 4000000,
          usage_percent: 80,
        },
        category_budgets: [],
      });
      prismaMock.notification.findMany.mockResolvedValueOnce([]);

      const res = await service.evaluateForPeriod(userId, period);

      expect(res.length).toBe(1);
      expect(notificationsServiceMock.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'BUDGET_WARNING_80',
          title: 'Anggaran Total mencapai 80%',
          data: expect.objectContaining({
            budget_type: 'TOTAL',
            threshold: 80,
          }),
        }),
        expect.anything(),
      );
    });
  });
});
