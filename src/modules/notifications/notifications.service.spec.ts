import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockSendNotification = jest.fn();
const mockSetVapidDetails = jest.fn();

jest.unstable_mockModule('web-push', () => ({
  sendNotification: mockSendNotification,
  setVapidDetails: mockSetVapidDetails,
}));

const { Test } = await import('@nestjs/testing');
const { UnprocessableEntityException, NotFoundException } = await import('@nestjs/common');
const { NotificationsService, isInQuietHours } = await import('./notifications.service.js');
const { PrismaService } = await import('../../prisma/prisma.service.js');
const { NotificationType } = await import('@prisma/client');

describe('NotificationsService', () => {
  let service: any;
  let prisma: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSendNotification.mockReset();
    mockSendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });

    prisma = {
      asSystem: jest.fn().mockReturnThis(),
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
      $executeRaw: jest.fn().mockResolvedValue(1 as never),
      pushSubscription: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'sub-uuid',
            user_id: 'user-1',
            endpoint: 'https://fcm.googleapis.com/fcm/send/token',
            p256dh: 'BNcRdreALRFdj',
            auth: 'tBHItJAhVo',
          },
        ] as never),
        delete: jest.fn().mockResolvedValue({ id: 'sub-uuid' } as never),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 } as never),
        create: jest.fn().mockImplementation((args: any) =>
          Promise.resolve({ id: 'sub-uuid', ...args.data }),
        ),
      },
      userPreference: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-pref-1',
          user_id: 'user-1',
          timezone: 'Asia/Jakarta',
        } as never),
      },
      notificationPreference: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pref-uuid',
          user_id: 'user-1',
          weekly_summary: false,
          budget_warning_80: true,
          budget_warning_100: true,
          scheduled_reminder: true,
          sync_failed: true,
          savings_achieved: true,
          monthly_summary: true,
          quiet_hours_start: '22:00',
          quiet_hours_end: '07:00',
          quiet_hours_enabled: true,
        } as never),
        upsert: jest.fn().mockImplementation((args: any) =>
          Promise.resolve({
            id: 'pref-uuid',
            user_id: args.where.user_id,
            weekly_summary: false,
            budget_warning_80: true,
            budget_warning_100: true,
            scheduled_reminder: true,
            sync_failed: true,
            savings_achieved: true,
            monthly_summary: true,
            quiet_hours_start: '22:00',
            quiet_hours_end: '07:00',
            quiet_hours_enabled: true,
            ...args.update,
          }),
        ),
      },
      notification: {
        create: jest.fn().mockImplementation((args: any) =>
          Promise.resolve({
            id: 'notif-uuid',
            read_at: null,
            delivered_at: null,
            created_at: new Date('2026-11-13T10:00:00.000Z'),
            ...args.data,
          }),
        ),
        update: jest.fn().mockImplementation((args: any) =>
          Promise.resolve({
            id: args.where.id,
            read_at: null,
            delivered_at: null,
            created_at: new Date('2026-11-13T10:00:00.000Z'),
            ...args.data,
          }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 2 } as never),
        findFirst: jest.fn().mockImplementation((args: any) => {
          if (args.where.id === 'notif-1' && args.where.user_id === 'user-1') {
            return Promise.resolve({
              id: 'notif-1',
              user_id: 'user-1',
              read_at: null,
              created_at: new Date(),
            });
          }
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'notif-1',
            user_id: 'user-1',
            type: 'BUDGET_WARNING_80',
            title: 'Alert',
            body: 'Message',
            read_at: null,
            delivered_at: null,
            created_at: new Date(),
          },
        ] as never),
        count: jest.fn().mockResolvedValue(1 as never),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get(NotificationsService);
  });

  describe('isInQuietHours pure function', () => {
    it('mendukung rentang normal di hari yang sama (mis. 01:00 - 05:00)', () => {
      expect(isInQuietHours('02:00', '01:00', '05:00')).toBe(true);
      expect(isInQuietHours('01:00', '01:00', '05:00')).toBe(true);
      expect(isInQuietHours('05:00', '01:00', '05:00')).toBe(false);
      expect(isInQuietHours('06:00', '01:00', '05:00')).toBe(false);
    });

    it('mendukung rentang lintas tengah malam (mis. 22:00 - 07:00)', () => {
      expect(isInQuietHours('23:15', '22:00', '07:00')).toBe(true);
      expect(isInQuietHours('02:00', '22:00', '07:00')).toBe(true);
      expect(isInQuietHours('22:00', '22:00', '07:00')).toBe(true);
      expect(isInQuietHours('06:59', '22:00', '07:00')).toBe(true);
      expect(isInQuietHours('07:00', '22:00', '07:00')).toBe(false);
      expect(isInQuietHours('07:05', '22:00', '07:00')).toBe(false);
      expect(isInQuietHours('15:00', '22:00', '07:00')).toBe(false);
      expect(isInQuietHours('21:59', '22:00', '07:00')).toBe(false);
    });

    it('mengembalikan false jika start sama dengan end', () => {
      expect(isInQuietHours('10:00', '10:00', '10:00')).toBe(false);
    });
  });

  describe('subscribePush', () => {
    it('berhasil menyimpan subscription dengan endpoint https valid', async () => {
      const res = await service.subscribePush(
        'user-1',
        {
          endpoint: 'https://fcm.googleapis.com/fcm/send/sample-token',
          keys: {
            p256dh: 'BNcRdreALRFdj',
            auth: 'tBHItJAhVo',
          },
        },
        'Mozilla/5.0 Chrome/120.0.0.0',
      );

      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint: 'https://fcm.googleapis.com/fcm/send/sample-token' },
      });
      expect(prisma.pushSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          user_id: 'user-1',
          endpoint: 'https://fcm.googleapis.com/fcm/send/sample-token',
          p256dh: 'BNcRdreALRFdj',
          auth: 'tBHItJAhVo',
          user_agent: 'Mozilla/5.0 Chrome/120.0.0.0',
        }),
      });
      expect(res.id).toBe('sub-uuid');
    });

    it('menolak endpoint http:// (Anti-SSRF)', async () => {
      await expect(
        service.subscribePush('user-1', {
          endpoint: 'http://push.service.com/sub',
          keys: { p256dh: 'key', auth: 'auth' },
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('menolak endpoint host localhost (Anti-SSRF)', async () => {
      await expect(
        service.subscribePush('user-1', {
          endpoint: 'https://localhost/push',
          keys: { p256dh: 'key', auth: 'auth' },
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('menolak endpoint host loopback 127.0.0.1 (Anti-SSRF)', async () => {
      await expect(
        service.subscribePush('user-1', {
          endpoint: 'https://127.0.0.1/push',
          keys: { p256dh: 'key', auth: 'auth' },
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('menolak endpoint host cloud metadata 169.254.169.254 (Anti-SSRF)', async () => {
      await expect(
        service.subscribePush('user-1', {
          endpoint: 'https://169.254.169.254/latest/meta-data',
          keys: { p256dh: 'key', auth: 'auth' },
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('menolak endpoint host private IP 192.168.1.1 (Anti-SSRF)', async () => {
      await expect(
        service.subscribePush('user-1', {
          endpoint: 'https://192.168.1.1/push',
          keys: { p256dh: 'key', auth: 'auth' },
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('unsubscribePush', () => {
    it('menghapus subscription sesuai user_id dan endpoint', async () => {
      const res = await service.unsubscribePush('user-1', 'https://fcm.googleapis.com/test');
      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: {
          user_id: 'user-1',
          endpoint: 'https://fcm.googleapis.com/test',
        },
      });
      expect(res).toEqual({ deleted: true });
    });
  });

  describe('getPreferences & updatePreferences', () => {
    it('mengembalikan default preferensi bila belum ada', async () => {
      const prefs = await service.getPreferences('user-1');
      expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: 'user-1' },
          create: expect.objectContaining({
            weekly_summary: false,
            budget_warning_80: true,
            budget_warning_100: true,
            scheduled_reminder: true,
            sync_failed: true,
            savings_achieved: true,
            monthly_summary: true,
            quiet_hours_start: '22:00',
            quiet_hours_end: '07:00',
            quiet_hours_enabled: true,
          }),
        }),
      );
      expect(prefs.weekly_summary).toBe(false);
      expect(prefs.budget_warning_80).toBe(true);
    });

    it('memperbarui preferensi user', async () => {
      const updated = await service.updatePreferences('user-1', {
        weekly_summary: true,
        quiet_hours_start: '21:30',
      });
      expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: 'user-1' },
          update: {
            weekly_summary: true,
            quiet_hours_start: '21:30',
          },
        }),
      );
      expect(updated.weekly_summary).toBe(true);
    });
  });

  describe('dispatch & quiet hours (AC-1, AC-2, AC-3)', () => {
    it('AC-1: saat jam lokal 23:15 (dalam 22:00–07:00), delivered_at = null dan tidak memanggil webpush; saat flushDeferredPush pada 07:05, webpush terkirim TTL: 3600 & delivered_at terisi', async () => {
      // 23:15 WIB (UTC 16:15)
      const date2315 = new Date('2026-11-13T16:15:00.000Z');
      const notif = await service.dispatch(
        {
          userId: 'user-1',
          type: NotificationType.BUDGET_WARNING_80,
          title: 'Budget Alert',
          body: '80% reached',
        },
        undefined,
        { now: date2315 },
      );

      expect(prisma.notification.create).toHaveBeenCalled();
      expect(mockSendNotification).not.toHaveBeenCalled();
      expect(notif.delivered_at).toBeNull();

      // Saat flushDeferredPush dijalankan pada 07:05 WIB (UTC 00:05)
      const date0705 = new Date('2026-11-14T00:05:00.000Z');
      prisma.notification.findMany.mockResolvedValueOnce([
        {
          id: 'notif-uuid',
          user_id: 'user-1',
          type: NotificationType.BUDGET_WARNING_80,
          title: 'Budget Alert',
          body: '80% reached',
          data: null,
          delivered_at: null,
          created_at: date2315,
        },
      ]);

      await service.flushDeferredPush(date0705);

      expect(mockSendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://fcm.googleapis.com/fcm/send/token',
        }),
        expect.any(String),
        { TTL: 3600 },
      );
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'notif-uuid' },
        data: { delivered_at: date0705 },
      });
    });

    it('AC-2: SECURITY_ALERT pada jam 02:00 malam tetap langsung mengirim Web Push dan mengisi delivered_at', async () => {
      // 02:00 WIB (UTC 19:00 prev day)
      const date0200 = new Date('2026-11-13T19:00:00.000Z');
      const notif = await service.dispatch(
        {
          userId: 'user-1',
          type: NotificationType.SECURITY_ALERT,
          title: 'Security Alert',
          body: 'New login detected',
        },
        undefined,
        { now: date0200 },
      );

      expect(mockSendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://fcm.googleapis.com/fcm/send/token',
        }),
        expect.any(String),
        { TTL: 3600 },
      );
      expect(notif.delivered_at).toEqual(date0200);
    });

    it('AC-3: jika webpush melempar statusCode 410, subscription dihapus dan dispatch tetap mengembalikan Notification', async () => {
      mockSendNotification.mockRejectedValueOnce({
        statusCode: 410,
        message: 'Gone',
      });

      // 10:00 siang (di luar quiet hours)
      const date1000 = new Date('2026-11-13T03:00:00.000Z');
      const notif = await service.dispatch(
        {
          userId: 'user-1',
          type: NotificationType.BUDGET_WARNING_80,
          title: 'Alert',
          body: 'Content',
        },
        undefined,
        { now: date1000 },
      );

      expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({
        where: { id: 'sub-uuid' },
      });
      expect(notif.id).toBe('notif-uuid');
    });

    it('Privasi layar kunci: payload Web Push tidak memuat nominal Rupiah', async () => {
      const date1000 = new Date('2026-11-13T03:00:00.000Z');
      await service.dispatch(
        {
          userId: 'user-1',
          type: NotificationType.BUDGET_WARNING_80,
          title: 'Peringatan Anggaran',
          body: 'Pengeluaran telah mencapai 80%',
          data: { budget_id: 'b-1', amount: 500000 },
        },
        undefined,
        { now: date1000 },
      );

      expect(mockSendNotification).toHaveBeenCalled();
      const payloadString = mockSendNotification.mock.calls[0][1];
      const payload = JSON.parse(payloadString);

      expect(payload).toEqual({
        id: 'notif-uuid',
        type: 'BUDGET_WARNING_80',
        title: 'Peringatan Anggaran',
        body: 'Pengeluaran telah mencapai 80%',
        created_at: expect.any(String),
      });
      expect(payloadString).not.toContain('500000');
      expect(payloadString).not.toContain('Rp');
    });
  });

  describe('In-App Notification Center (AC-5)', () => {
    it('list: mengembalikan daftar terurut terbaru dan unread_count', async () => {
      const res = await service.list('user-1', { limit: 10, unread_only: false });

      expect(prisma.notification.findMany).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
        orderBy: { created_at: 'desc' },
        take: 10,
      });
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { user_id: 'user-1', read_at: null },
      });
      expect(res.items).toHaveLength(1);
      expect(res.unread_count).toBe(1);
    });

    it('markRead: menandai notifikasi telah dibaca milik user', async () => {
      const res = await service.markRead('user-1', 'notif-1');
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'notif-1' },
        data: { read_at: expect.any(Date) },
      });
      expect(res.id).toBe('notif-1');
    });

    it('markRead: melempar 404 jika notifikasi milik user lain atau tidak ada (C-01)', async () => {
      await expect(service.markRead('user-2', 'notif-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('markAllRead: menandai semua notifikasi unread milik user', async () => {
      const res = await service.markAllRead('user-1');
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { user_id: 'user-1', read_at: null },
        data: { read_at: expect.any(Date) },
      });
      expect(res.count).toBe(2);
    });

    it('reportSyncFailed: dispatch SYNC_FAILED jika sync_failed aktif', async () => {
      const notif = await service.reportSyncFailed('user-1', 3);
      expect(prisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            user_id: 'user-1',
            type: 'SYNC_FAILED',
            data: { failed_count: 3 },
          }),
        }),
      );
      expect(notif?.id).toBe('notif-uuid');
    });
  });
});
