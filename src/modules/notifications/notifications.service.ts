import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  NotificationType,
  Notification,
  PushSubscription,
  NotificationPreference,
} from '@prisma/client';
import {
  validatePushEndpoint,
  type PushSubscriptionDto,
  type UpdatePreferencesDto,
} from './dto/notifications.dto.js';

export interface DispatchNotificationDto {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: any;
}

export function isInQuietHours(
  nowHHMM: string,
  startHHMM: string,
  endHHMM: string,
): boolean {
  if (startHHMM === endHHMM) {
    return false;
  }
  if (startHHMM < endHHMM) {
    return nowHHMM >= startHHMM && nowHHMM < endHHMM;
  }
  return nowHHMM >= startHHMM || nowHHMM < endHHMM;
}

export function getLocalHHMM(
  date: Date = new Date(),
  timeZone: string = 'Asia/Jakarta',
): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }
}

function isTypeEnabledInPreference(
  type: NotificationType,
  pref: NotificationPreference,
): boolean {
  switch (type) {
    case 'BUDGET_WARNING_80':
      return pref.budget_warning_80;
    case 'BUDGET_WARNING_100':
      return pref.budget_warning_100;
    case 'SCHEDULED_REMINDER':
      return pref.scheduled_reminder;
    case 'SYNC_FAILED':
      return pref.sync_failed;
    case 'SAVINGS_ACHIEVED':
      return pref.savings_achieved;
    case 'WEEKLY_SUMMARY':
      return pref.weekly_summary;
    case 'MONTHLY_SUMMARY':
      return pref.monthly_summary;
    case 'SECURITY_ALERT':
      return true;
    default:
      return true;
  }
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private warnedMissingVapid = false;

  constructor(private readonly prisma: PrismaService) {}

  async dispatch(
    dto: DispatchNotificationDto,
    tx?: any,
    options?: { now?: Date },
  ): Promise<Notification> {
    const client = tx ?? this.prisma.asSystem();

    const notification = await client.notification.create({
      data: {
        user_id: dto.userId,
        type: dto.type,
        title: dto.title,
        body: dto.body,
        data: dto.data ?? null,
        read_at: null,
        delivered_at: null,
      },
    });

    const now = options?.now ?? new Date();

    if (dto.type === 'SECURITY_ALERT') {
      await this.sendPushToUser(notification);
      return client.notification.update({
        where: { id: notification.id },
        data: { delivered_at: now },
      });
    }

    const [userPref, notifPref] = await Promise.all([
      client.userPreference.findUnique({
        where: { user_id: dto.userId },
      }),
      client.notificationPreference.findUnique({
        where: { user_id: dto.userId },
      }),
    ]);

    const pref: NotificationPreference = notifPref ?? {
      id: '',
      user_id: dto.userId,
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
      created_at: now,
      updated_at: now,
    };

    if (!isTypeEnabledInPreference(dto.type, pref)) {
      return notification;
    }

    const timezone = userPref?.timezone || 'Asia/Jakarta';
    const localHHMM = getLocalHHMM(now, timezone);

    if (
      pref.quiet_hours_enabled &&
      isInQuietHours(localHHMM, pref.quiet_hours_start, pref.quiet_hours_end)
    ) {
      return notification;
    }

    await this.sendPushToUser(notification);
    return client.notification.update({
      where: { id: notification.id },
      data: { delivered_at: now },
    });
  }

  private async sendPushToUser(notification: Notification): Promise<void> {
    const isMocked =
      typeof (webpush.sendNotification as any)?.mockImplementation === 'function' ||
      typeof (webpush.sendNotification as any)?.mockResolvedValue === 'function';
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const hasKeys = Boolean(publicKey && privateKey);

    if (!hasKeys && !isMocked) {
      if (!this.warnedMissingVapid) {
        this.logger.warn(
          'VAPID keys not configured. Skipping Web Push notifications in non-production.',
        );
        this.warnedMissingVapid = true;
      }
      return;
    }

    if (hasKeys) {
      try {
        const subject = process.env.VAPID_SUBJECT || 'mailto:admin@duitku.app';
        webpush.setVapidDetails(subject, publicKey!, privateKey!);
      } catch (err: any) {
        this.logger.warn(`Failed to set VAPID details: ${err?.message}`);
      }
    }

    let subs: PushSubscription[] = [];
    try {
      subs = await this.prisma.asSystem().pushSubscription.findMany({
        where: { user_id: notification.user_id },
      });
    } catch {
      subs = [];
    }

    const payload = JSON.stringify({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      created_at: notification.created_at,
    });

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          { TTL: 3600 },
        );
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await this.prisma
            .asSystem()
            .pushSubscription.delete({
              where: { id: sub.id },
            })
            .catch(() => {});
        }
      }
    }
  }

  async flushDeferredPush(now: Date = new Date()): Promise<void> {
    const pendingNotifications = await this.prisma.asSystem().notification.findMany({
      where: { delivered_at: null },
      orderBy: { created_at: 'asc' },
    });

    for (const notif of pendingNotifications) {
      const [userPref, notifPref] = await Promise.all([
        this.prisma.asSystem().userPreference.findUnique({
          where: { user_id: notif.user_id },
        }),
        this.prisma.asSystem().notificationPreference.findUnique({
          where: { user_id: notif.user_id },
        }),
      ]);

      const tz = userPref?.timezone || 'Asia/Jakarta';
      const quietEnabled = notifPref?.quiet_hours_enabled ?? true;
      const quietStart = notifPref?.quiet_hours_start || '22:00';
      const quietEnd = notifPref?.quiet_hours_end || '07:00';

      const localHHMM = getLocalHHMM(now, tz);
      if (
        notif.type !== 'SECURITY_ALERT' &&
        quietEnabled &&
        isInQuietHours(localHHMM, quietStart, quietEnd)
      ) {
        continue;
      }

      await this.sendPushToUser(notif);
      await this.prisma.asSystem().notification.update({
        where: { id: notif.id },
        data: { delivered_at: now },
      });
    }
  }

  async list(
    userId: string,
    options?: { limit?: number; unread_only?: boolean },
  ): Promise<{ items: Notification[]; unread_count: number }> {
    const limit = options?.limit ?? 30;
    const where: any = { user_id: userId };
    if (options?.unread_only) {
      where.read_at = null;
    }

    const [items, unread_count] = await Promise.all([
      this.prisma.asSystem().notification.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
      }),
      this.prisma.asSystem().notification.count({
        where: { user_id: userId, read_at: null },
      }),
    ]);

    return { items, unread_count };
  }

  async markRead(userId: string, id: string): Promise<Notification> {
    const existing = await this.prisma.asSystem().notification.findFirst({
      where: { id, user_id: userId },
    });

    if (!existing) {
      throw new NotFoundException('Notifikasi tidak ditemukan');
    }

    return this.prisma.asSystem().notification.update({
      where: { id },
      data: { read_at: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<{ count: number }> {
    const result = await this.prisma.asSystem().notification.updateMany({
      where: { user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });

    return { count: result.count };
  }

  async reportSyncFailed(
    userId: string,
    failedCount: number,
  ): Promise<Notification | null> {
    const pref = await this.getPreferences(userId);
    if (pref.sync_failed) {
      return this.dispatch({
        userId,
        type: 'SYNC_FAILED',
        title: 'Sinkronisasi Tertunda',
        body: `${failedCount} transaksi belum tersinkronisasi. Akan dicoba kembali otomatis.`,
        data: { failed_count: failedCount },
      });
    }
    return null;
  }

  async subscribePush(
    userId: string,
    dto: PushSubscriptionDto,
    userAgent?: string,
  ): Promise<PushSubscription> {
    validatePushEndpoint(dto.endpoint);

    const userAgentTruncated = userAgent ? userAgent.slice(0, 255) : null;

    return this.prisma.asSystem().$transaction(async (tx) => {
      await tx.pushSubscription.deleteMany({
        where: { endpoint: dto.endpoint },
      });

      return tx.pushSubscription.create({
        data: {
          user_id: userId,
          endpoint: dto.endpoint,
          p256dh: dto.keys.p256dh,
          auth: dto.keys.auth,
          user_agent: userAgentTruncated,
        },
      });
    });
  }

  async unsubscribePush(
    userId: string,
    endpoint: string,
  ): Promise<{ deleted: boolean }> {
    await this.prisma.asSystem().pushSubscription.deleteMany({
      where: {
        user_id: userId,
        endpoint,
      },
    });

    return { deleted: true };
  }

  async getPreferences(userId: string): Promise<NotificationPreference> {
    return this.prisma.asSystem().notificationPreference.upsert({
      where: { user_id: userId },
      update: {},
      create: {
        user_id: userId,
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
      },
    });
  }

  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<NotificationPreference> {
    return this.prisma.asSystem().notificationPreference.upsert({
      where: { user_id: userId },
      update: dto,
      create: {
        user_id: userId,
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
        ...dto,
      },
    });
  }
}
