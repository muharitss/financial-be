import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BudgetsService } from './budgets.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { Notification, NotificationType } from '@prisma/client';

export interface BudgetWarningData {
  budget_id: string;
  period: string;
  threshold: 80 | 100;
  budget_type: 'TOTAL' | 'CATEGORY';
  usage_percent: number;
}

@Injectable()
export class BudgetWarningService {
  private readonly logger = new Logger(BudgetWarningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly budgetsService: BudgetsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async evaluateForPeriod(
    userId: string,
    period: string,
  ): Promise<Notification[]> {
    const pref = await this.prisma.notificationPreference.findUnique({
      where: { user_id: userId },
    });

    const warn80 = pref?.budget_warning_80 ?? true;
    const warn100 = pref?.budget_warning_100 ?? true;

    if (!warn80 && !warn100) {
      return [];
    }

    let overview;
    try {
      overview = await this.budgetsService.computeUsageForPeriod(userId, period);
    } catch (err: any) {
      if (err instanceof NotFoundException) {
        return [];
      }
      throw err;
    }

    const candidateBudgets: Array<{
      id: string;
      type: 'TOTAL' | 'CATEGORY';
      name: string;
      effective: bigint;
      spent: bigint;
    }> = [];

    if (overview.total_budget) {
      candidateBudgets.push({
        id: overview.total_budget.id,
        type: 'TOTAL',
        name: 'Anggaran Total',
        effective: BigInt(overview.total_budget.effective_amount),
        spent: BigInt(overview.total_budget.spent_amount),
      });
    }

    if (overview.category_budgets) {
      for (const cb of overview.category_budgets) {
        candidateBudgets.push({
          id: cb.id,
          type: 'CATEGORY',
          name: cb.category_name ? `Anggaran ${cb.category_name}` : 'Anggaran Kategori',
          effective: BigInt(cb.effective_amount),
          spent: BigInt(cb.spent_amount),
        });
      }
    }

    const dispatched: Notification[] = [];

    for (const b of candidateBudgets) {
      if (b.effective <= 0n) {
        continue;
      }

      const meets100 = b.spent >= b.effective;
      const meets80 = b.spent * 100n >= b.effective * 80n;

      if (!meets80 && !meets100) {
        continue;
      }

      await this.prisma.asSystem().$transaction(async (tx) => {
        const lockKey = `budget_warn:${b.id}:${period}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        const existingNotifications = await tx.notification.findMany({
          where: {
            user_id: userId,
            type: { in: ['BUDGET_WARNING_80', 'BUDGET_WARNING_100'] },
          },
          select: {
            type: true,
            data: true,
          },
        });

        const matching = existingNotifications.filter((n) => {
          const d = n.data as any;
          return d && d.budget_id === b.id && d.period === period;
        });

        const hasWarned80 = matching.some(
          (n) => n.type === 'BUDGET_WARNING_80' || (n.data as any)?.threshold === 80,
        );
        const hasWarned100 = matching.some(
          (n) => n.type === 'BUDGET_WARNING_100' || (n.data as any)?.threshold === 100,
        );

        let thresholdToSend: 80 | 100 | null = null;
        if (meets100) {
          if (warn100 && !hasWarned100) {
            thresholdToSend = 100;
          }
        } else if (meets80) {
          if (warn80 && !hasWarned80 && !hasWarned100) {
            thresholdToSend = 80;
          }
        }

        if (!thresholdToSend) {
          return;
        }

        const usagePercent = Number((b.spent * 100n) / b.effective);
        const type: NotificationType =
          thresholdToSend === 100 ? 'BUDGET_WARNING_100' : 'BUDGET_WARNING_80';

        const data: BudgetWarningData = {
          budget_id: b.id,
          period,
          threshold: thresholdToSend,
          budget_type: b.type,
          usage_percent: usagePercent,
        };

        const title = `${b.name} mencapai ${thresholdToSend}%`;
        const body = `${b.name} telah mencapai ${usagePercent}% pada periode ${period}.`;

        const notif = await this.notificationsService.dispatch(
          {
            userId,
            type,
            title,
            body,
            data,
          },
          tx,
        );

        dispatched.push(notif);
      });
    }

    return dispatched;
  }
}
