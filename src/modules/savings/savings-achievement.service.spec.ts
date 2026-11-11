import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { SavingsAchievementService } from './savings-achievement.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

describe('SavingsAchievementService', () => {
  let service: SavingsAchievementService;
  let prisma: any;
  let notificationsService: any;

  beforeEach(async () => {
    prisma = {
      notificationPreference: {
        findUnique: jest.fn(),
      },
      asSystem: jest.fn().mockReturnValue({
        $transaction: jest.fn(async (cb: any) => cb(prisma)),
      }),
      $executeRaw: jest.fn(),
      notification: {
        findMany: jest.fn(),
      },
    };

    notificationsService = {
      dispatch: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavingsAchievementService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notificationsService },
      ],
    }).compile();

    service = module.get<SavingsAchievementService>(SavingsAchievementService);
  });

  it('mengirim notifikasi SAVINGS_ACHIEVED saat pertama kali tercapai dan preferensi aktif', async () => {
    prisma.notificationPreference.findUnique.mockResolvedValue(null); // default true
    prisma.notification.findMany.mockResolvedValue([]);

    await service.notifyIfFirstTimeAchieved('user-1', { id: 'goal-1', name: 'Liburan' }, 100);

    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(notificationsService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        type: 'SAVINGS_ACHIEVED',
        title: 'Target Tabungan Tercapai!',
        body: 'Selamat! Target tabungan "Liburan" telah mencapai 100%.',
        data: {
          savings_goal_id: 'goal-1',
          progress_percent: 100,
        },
      }),
      expect.anything(),
    );
    // Verifikasi privasi: body dan title tidak memuat simbol Rp atau angka nominal
    const callArgs = (notificationsService.dispatch as jest.Mock).mock.calls[0][0] as any;
    expect(callArgs.title).not.toMatch(/Rp/);
    expect(callArgs.body).not.toMatch(/Rp/);
  });

  it('tidak mengirim notifikasi jika sudah pernah dikirim untuk goal tersebut (deduplikasi sekali seumur hidup target)', async () => {
    prisma.notificationPreference.findUnique.mockResolvedValue({ savings_achieved: true });
    prisma.notification.findMany.mockResolvedValue([
      { data: { savings_goal_id: 'goal-1', progress_percent: 100 } },
    ]);

    await service.notifyIfFirstTimeAchieved('user-1', { id: 'goal-1', name: 'Liburan' }, 100);

    expect(notificationsService.dispatch).not.toHaveBeenCalled();
  });

  it('tidak mengirim notifikasi jika preferensi savings_achieved = false', async () => {
    prisma.notificationPreference.findUnique.mockResolvedValue({ savings_achieved: false });

    await service.notifyIfFirstTimeAchieved('user-1', { id: 'goal-1', name: 'Liburan' }, 100);

    expect(prisma.asSystem).not.toHaveBeenCalled();
    expect(notificationsService.dispatch).not.toHaveBeenCalled();
  });

  it('menangkap error dispatch tanpa melempar exception ke pemanggil', async () => {
    prisma.notificationPreference.findUnique.mockResolvedValue({ savings_achieved: true });
    prisma.notification.findMany.mockResolvedValue([]);
    notificationsService.dispatch.mockRejectedValue(new Error('Dispatch failure'));

    await expect(
      service.notifyIfFirstTimeAchieved('user-1', { id: 'goal-1', name: 'Liburan' }, 100),
    ).resolves.not.toThrow();
  });
});
