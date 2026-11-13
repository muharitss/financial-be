import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsScheduler } from './notifications.scheduler.js';
import { NotificationsService } from './notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('NotificationsScheduler (AC-4)', () => {
  let scheduler: NotificationsScheduler;
  let notificationsService: any;
  let prisma: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    notificationsService = {
      dispatch: jest.fn().mockImplementation((args: any) =>
        Promise.resolve({ id: 'dispatched-notif', ...args }),
      ),
      flushDeferredPush: jest.fn().mockResolvedValue(undefined as never),
    };

    prisma = {
      asSystem: jest.fn().mockReturnThis(),
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
      $executeRaw: jest.fn().mockResolvedValue(1 as never),
      user: {
        findMany: jest.fn(),
      },
      transaction: {
        findMany: jest.fn(),
      },
      notification: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsScheduler,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: NotificationsService,
          useValue: notificationsService,
        },
      ],
    }).compile();

    scheduler = module.get<NotificationsScheduler>(NotificationsScheduler);
  });

  describe('SCHEDULED_REMINDER (FR-NOTIF-003)', () => {
    it('membuat tepat 1 reminder untuk transaksi H-1 tanpa nominal Rupiah di title/body, dan idempoten saat cron jalan ulang', async () => {
      // Jam 08:00 WIB hari ini (2026-11-14 08:00 WIB -> UTC 2026-11-14 01:00)
      const now = new Date('2026-11-14T01:00:00.000Z');

      prisma.user.findMany.mockResolvedValueOnce([
        {
          id: 'user-1',
          status: 'ACTIVE',
          preferences: { timezone: 'Asia/Jakarta' },
          notification_preference: { scheduled_reminder: true },
        },
      ]);

      // Transaksi besok (2026-11-15)
      prisma.transaction.findMany.mockResolvedValueOnce([
        {
          id: 'tx-scheduled-1',
          user_id: 'user-1',
          amount: 500000n,
          status: 'SCHEDULED',
          date: new Date('2026-11-15T00:00:00.000Z'),
        },
      ]);

      // Belum ada notifikasi sebelumnya
      prisma.notification.findMany.mockResolvedValueOnce([]);

      await scheduler.evaluateDaily0800Jobs(now);

      expect(notificationsService.dispatch).toHaveBeenCalledTimes(1);
      const callArg = notificationsService.dispatch.mock.calls[0][0];

      expect(callArg.type).toBe('SCHEDULED_REMINDER');
      expect(callArg.data).toEqual({ transaction_id: 'tx-scheduled-1' });
      // Wajib tanpa nominal Rupiah
      expect(callArg.title).not.toMatch(/Rp|\d+/);
      expect(callArg.body).not.toMatch(/Rp|500000/);

      // Jalankan ulang cron: sekarang notifikasi sudah ada
      notificationsService.dispatch.mockClear();
      prisma.user.findMany.mockResolvedValueOnce([
        {
          id: 'user-1',
          status: 'ACTIVE',
          preferences: { timezone: 'Asia/Jakarta' },
          notification_preference: { scheduled_reminder: true },
        },
      ]);
      prisma.transaction.findMany.mockResolvedValueOnce([
        {
          id: 'tx-scheduled-1',
          user_id: 'user-1',
          amount: 500000n,
          status: 'SCHEDULED',
          date: new Date('2026-11-15T00:00:00.000Z'),
        },
      ]);
      prisma.notification.findMany.mockResolvedValueOnce([
        {
          data: { transaction_id: 'tx-scheduled-1' },
        },
      ]);

      await scheduler.evaluateDaily0800Jobs(now);

      // Tidak ada dispatch kedua (deduplikasi berhasil)
      expect(notificationsService.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('WEEKLY_SUMMARY (FR-NOTIF-006)', () => {
    it('menghormati weekly_summary = false secara default (tidak mengirim)', async () => {
      // Senin 08:00 WIB (2026-11-16 01:00 UTC)
      const monday8am = new Date('2026-11-16T01:00:00.000Z');

      prisma.user.findMany.mockResolvedValueOnce([
        {
          id: 'user-1',
          status: 'ACTIVE',
          preferences: { timezone: 'Asia/Jakarta' },
          notification_preference: { weekly_summary: false },
        },
      ]);
      prisma.transaction.findMany.mockResolvedValueOnce([]);

      await scheduler.evaluateDaily0800Jobs(monday8am);

      expect(notificationsService.dispatch).not.toHaveBeenCalled();
    });

    it('mengirim WEEKLY_SUMMARY setiap Senin jika weekly_summary = true dan idempoten', async () => {
      // Senin 08:00 WIB (2026-11-16 01:00 UTC)
      const monday8am = new Date('2026-11-16T01:00:00.000Z');

      prisma.user.findMany.mockResolvedValueOnce([
        {
          id: 'user-1',
          status: 'ACTIVE',
          preferences: { timezone: 'Asia/Jakarta' },
          notification_preference: { weekly_summary: true },
        },
      ]);
      prisma.transaction.findMany.mockResolvedValueOnce([]);
      prisma.notification.findMany.mockResolvedValueOnce([]);

      await scheduler.evaluateDaily0800Jobs(monday8am);

      expect(notificationsService.dispatch).toHaveBeenCalledTimes(1);
      const callArg = notificationsService.dispatch.mock.calls[0][0];
      expect(callArg.type).toBe('WEEKLY_SUMMARY');
      expect(callArg.data).toEqual({ iso_week: '2026-W47' });
    });
  });

  describe('MONTHLY_SUMMARY (FR-NOTIF-007)', () => {
    it('mengirim MONTHLY_SUMMARY pada tanggal 1 pukul 08:00 tanpa nominal Rupiah', async () => {
      // Tanggal 1 Desember 2026 08:00 WIB (2026-12-01 01:00 UTC)
      const dec1st8am = new Date('2026-12-01T01:00:00.000Z');

      prisma.user.findMany.mockResolvedValueOnce([
        {
          id: 'user-1',
          status: 'ACTIVE',
          preferences: { timezone: 'Asia/Jakarta' },
          notification_preference: { monthly_summary: true },
        },
      ]);
      prisma.transaction.findMany.mockResolvedValueOnce([]);
      prisma.notification.findMany.mockResolvedValueOnce([]);

      await scheduler.evaluateDaily0800Jobs(dec1st8am);

      expect(notificationsService.dispatch).toHaveBeenCalledTimes(1);
      const callArg = notificationsService.dispatch.mock.calls[0][0];
      expect(callArg.type).toBe('MONTHLY_SUMMARY');
      expect(callArg.data).toEqual({ period: '2026-12' });
      expect(callArg.title).not.toMatch(/Rp|\d+/);
      expect(callArg.body).not.toMatch(/Rp/);
    });
  });
});
