import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { currentPeriodInTz } from '../../common/utils/date.js';

@Injectable()
export class BudgetPeriodLockService {
  constructor(private readonly prisma: PrismaService) {}

  async lockPeriodInTx(
    tx: Prisma.TransactionClient,
    budgetPeriodId: string,
    actorUserId: string,
    lockedAt: Date = new Date(),
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        budget_id: string;
        period: string;
        base_amount: bigint;
        carryover_amount: bigint;
        locked_at: Date | null;
      }>
    >`SELECT id, budget_id, period, base_amount, carryover_amount, locked_at FROM budget_periods WHERE id = ${budgetPeriodId}::uuid AND locked_at IS NULL FOR UPDATE SKIP LOCKED`;

    if (rows.length === 0) {
      return false;
    }

    const row = rows[0];
    await tx.budgetPeriod.update({
      where: { id: budgetPeriodId },
      data: { locked_at: lockedAt },
    });

    await tx.auditLog.create({
      data: {
        action: 'BUDGET_PERIOD_LOCK',
        resource_type: 'budget_period',
        resource_id: budgetPeriodId,
        actor_user_id: actorUserId,
        actor_role: 'SYSTEM',
        before: { locked_at: null },
        after: {
          period: row.period,
          locked_at: lockedAt,
          carryover_amount: Number(row.carryover_amount),
        },
      },
    });

    return true;
  }

  async lockExpiredPeriodsForUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<{ lockedCount: number }> {
    const pref = await this.prisma.asSystem().userPreference.findFirst({
      where: { user_id: userId },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const currentPeriod = currentPeriodInTz(tz, now);

    const expiredPeriods = await this.prisma.asSystem().budgetPeriod.findMany({
      where: {
        budget: { user_id: userId },
        period: { lt: currentPeriod },
        locked_at: null,
      },
      select: { id: true },
      orderBy: { period: 'asc' },
    });

    let lockedCount = 0;
    for (const p of expiredPeriods) {
      const locked = await this.prisma.asSystem().$transaction(async (tx) => {
        return this.lockPeriodInTx(tx, p.id, userId, now);
      });
      if (locked) {
        lockedCount++;
      }
    }

    return { lockedCount };
  }
}
