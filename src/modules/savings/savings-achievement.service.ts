import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

@Injectable()
export class SavingsAchievementService {
  private readonly logger = new Logger(SavingsAchievementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async notifyIfFirstTimeAchieved(
    userId: string,
    goal: { id: string; name: string },
    progressPercent: number,
  ): Promise<void> {
    try {
      const pref = await this.prisma.notificationPreference.findUnique({
        where: { user_id: userId },
      });

      const enabled = pref?.savings_achieved ?? true;
      if (!enabled) {
        return;
      }

      await this.prisma.asSystem().$transaction(async (tx) => {
        const lockKey = `savings_achieved:${goal.id}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        const existing = await tx.notification.findMany({
          where: {
            user_id: userId,
            type: 'SAVINGS_ACHIEVED',
          },
          select: {
            data: true,
          },
        });

        const alreadySent = existing.some((n) => {
          const d = n.data as any;
          return d && d.savings_goal_id === goal.id;
        });

        if (alreadySent) {
          return;
        }

        await this.notificationsService.dispatch(
          {
            userId,
            type: 'SAVINGS_ACHIEVED',
            title: 'Target Tabungan Tercapai!',
            body: `Selamat! Target tabungan "${goal.name}" telah mencapai 100%.`,
            data: {
              savings_goal_id: goal.id,
              progress_percent: progressPercent,
            },
          },
          tx,
        );
      });
    } catch (err: any) {
      this.logger.warn(
        `Failed to dispatch SAVINGS_ACHIEVED for goal ${goal.id}: ${err.message}`,
      );
    }
  }
}
