import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';

export function getUserLocalDateInfo(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }
  const year = partMap.year;
  const month = partMap.month;
  const day = parseInt(partMap.day, 10);
  const hour = parseInt(partMap.hour, 10);
  const weekday = partMap.weekday;
  const dateStr = `${year}-${month}-${partMap.day}`;
  const yearMonth = `${year}-${month}`;
  return { year, month, day, hour, weekday, dateStr, yearMonth };
}

export function getISOWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Cron('*/15 * * * *')
  async handleFlushQuietHours() {
    this.logger.debug('Running quiet hours flush job...');
    await this.notificationsService.flushDeferredPush();
  }

  @Cron('0 * * * *')
  async handleHourlyNotifications() {
    await this.evaluateDaily0800Jobs();
  }

  async evaluateDaily0800Jobs(now: Date = new Date()): Promise<void> {
    const users = await this.prisma.asSystem().user.findMany({
      where: { status: 'ACTIVE' },
      include: {
        preferences: true,
        notification_preference: true,
      },
    });

    for (const user of users) {
      const tz = user.preferences?.timezone || 'Asia/Jakarta';
      const info = getUserLocalDateInfo(now, tz);

      // Only run when user's local hour is 8 AM
      if (info.hour !== 8) {
        continue;
      }

      await this.runUser0800Jobs(user, now, tz, info);
    }
  }

  async runUser0800Jobs(
    user: any,
    now: Date,
    tz: string,
    info: ReturnType<typeof getUserLocalDateInfo>,
  ): Promise<void> {
    const notifPref = user.notification_preference;
    const scheduledEnabled = notifPref?.scheduled_reminder ?? true;
    const weeklyEnabled = notifPref?.weekly_summary ?? false;
    const monthlyEnabled = notifPref?.monthly_summary ?? true;

    // 1. SCHEDULED_REMINDER: H-1 at 08:00
    if (scheduledEnabled) {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const tomorrowInfo = getUserLocalDateInfo(tomorrow, tz);
      const tomorrowStart = new Date(`${tomorrowInfo.dateStr}T00:00:00.000Z`);
      const tomorrowEnd = new Date(`${tomorrowInfo.dateStr}T23:59:59.999Z`);

      const scheduledTxs = await this.prisma.asSystem().transaction.findMany({
        where: {
          user_id: user.id,
          status: 'SCHEDULED',
          date: {
            gte: tomorrowStart,
            lte: tomorrowEnd,
          },
        },
      });

      for (const t of scheduledTxs) {
        const lockKey = `scheduled_reminder:${t.id}`;
        await this.prisma.asSystem().$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

          const existingNotifications = await tx.notification.findMany({
            where: {
              user_id: user.id,
              type: 'SCHEDULED_REMINDER',
            },
            select: { data: true },
          });

          const alreadySent = existingNotifications.some(
            (n) => (n.data as any)?.transaction_id === t.id,
          );

          if (!alreadySent) {
            await this.notificationsService.dispatch(
              {
                userId: user.id,
                type: 'SCHEDULED_REMINDER',
                title: 'Pengingat Transaksi Terjadwal',
                body: 'Anda memiliki transaksi terjadwal untuk besok.',
                data: { transaction_id: t.id },
              },
              tx,
              { now },
            );
          }
        });
      }
    }

    // 2. WEEKLY_SUMMARY: Every Monday at 08:00, default off
    if (weeklyEnabled && info.weekday === 'Mon') {
      const isoWeek = getISOWeekString(now);
      const lockKey = `weekly_summary:${user.id}:${isoWeek}`;

      await this.prisma.asSystem().$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        const existingNotifications = await tx.notification.findMany({
          where: {
            user_id: user.id,
            type: 'WEEKLY_SUMMARY',
          },
          select: { data: true },
        });

        const alreadySent = existingNotifications.some(
          (n) => (n.data as any)?.iso_week === isoWeek,
        );

        if (!alreadySent) {
          await this.notificationsService.dispatch(
            {
              userId: user.id,
              type: 'WEEKLY_SUMMARY',
              title: 'Ringkasan Mingguan',
              body: 'Ringkasan pengeluaran dan pemasukan Anda minggu ini telah siap.',
              data: { iso_week: isoWeek },
            },
            tx,
            { now },
          );
        }
      });
    }

    // 3. MONTHLY_SUMMARY: Every 1st of month at 08:00, default on
    if (monthlyEnabled && info.day === 1) {
      const period = info.yearMonth;
      const lockKey = `monthly_summary:${user.id}:${period}`;

      await this.prisma.asSystem().$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        const existingNotifications = await tx.notification.findMany({
          where: {
            user_id: user.id,
            type: 'MONTHLY_SUMMARY',
          },
          select: { data: true },
        });

        const alreadySent = existingNotifications.some(
          (n) => (n.data as any)?.period === period,
        );

        if (!alreadySent) {
          await this.notificationsService.dispatch(
            {
              userId: user.id,
              type: 'MONTHLY_SUMMARY',
              title: 'Ringkasan Bulanan',
              body: 'Ringkasan keuangan bulanan Anda telah siap.',
              data: { period },
            },
            tx,
            { now },
          );
        }
      });
    }
  }
}
