import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BudgetsService } from './budgets.service.js';
import { BudgetPeriodLockService } from './budget-period-lock.service.js';
import { currentPeriodInTz, previousPeriod, todayInTz } from '../../common/utils/date.js';

export function computeCarryoverAmount(params: {
  type: 'TOTAL' | 'CATEGORY';
  rolloverEnabled: boolean;
  baseAmount: bigint;
  prevCarryover: bigint;
  spent: bigint;
}): bigint {
  if (params.type !== 'CATEGORY' || !params.rolloverEnabled) {
    return 0n;
  }
  const effectivePrev = params.baseAmount + params.prevCarryover;
  const rawRemainder = effectivePrev > params.spent ? effectivePrev - params.spent : 0n;
  return rawRemainder > params.baseAmount ? params.baseAmount : rawRemainder;
}

@Injectable()
export class BudgetRolloverService {
  private readonly logger = new Logger(BudgetRolloverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly budgetsService: BudgetsService,
    private readonly budgetPeriodLockService: BudgetPeriodLockService,
  ) {}

  @Cron('10 0 * * *', { timeZone: 'Asia/Jakarta' })
  async runDailyMonthTurnCheck(now: Date = new Date()): Promise<{
    processedCount: number;
    skippedCount: number;
    errors: number;
  }> {
    const lockRows = await this.prisma.asSystem().$queryRaw<
      Array<{ pg_try_advisory_lock: boolean }>
    >`SELECT pg_try_advisory_lock(5062001)`;

    const acquired = lockRows[0]?.pg_try_advisory_lock;
    if (!acquired) {
      this.logger.log('Daily month turn check already running on another instance, skipping');
      return { processedCount: 0, skippedCount: 0, errors: 0 };
    }

    try {
      this.logger.log('Starting daily month turn check...');

      const usersWithBudgets = await this.prisma.asSystem().budget.findMany({
        where: {
          periods: {
            some: {
              locked_at: null,
            },
          },
        },
        select: {
          user_id: true,
        },
        distinct: ['user_id'],
      });

      let processedCount = 0;
      let skippedCount = 0;
      let errors = 0;

      for (const { user_id } of usersWithBudgets) {
        try {
          const res = await this.processMonthTurnForUser(user_id, now);
          processedCount += res.processedCount;
          skippedCount += res.skippedCount;
          errors += res.errors;
        } catch (err: any) {
          errors++;
          this.logger.error(
            `Failed to process month turn for user ${user_id}: ${err.message}`,
          );
        }
      }

      this.logger.log(
        `Daily month turn check completed. Processed: ${processedCount}, Skipped: ${skippedCount}, Errors: ${errors}`,
      );
      return { processedCount, skippedCount, errors };
    } finally {
      await this.prisma.asSystem().$queryRaw`SELECT pg_advisory_unlock(5062001)`;
    }
  }

  async processMonthTurnForUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<{
    processedCount: number;
    skippedCount: number;
    errors: number;
  }> {
    const pref = await this.prisma.asSystem().userPreference.findFirst({
      where: { user_id: userId },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const currentPeriod = currentPeriodInTz(tz, now);
    const prevPeriod = previousPeriod(currentPeriod);
    const dayOfMonth = todayInTz(tz, now).slice(8, 10);

    const budgets = await this.prisma.asSystem().budget.findMany({
      where: { user_id: userId },
      include: {
        periods: {
          where: {
            locked_at: null,
            period: { lt: currentPeriod },
          },
          include: {
            categories: {
              include: {
                rollover_config: true,
              },
            },
          },
          orderBy: { period: 'asc' },
        },
      },
    });

    let processedCount = 0;
    let skippedCount = 0;
    let errors = 0;

    for (const budget of budgets) {
      for (const bp of budget.periods) {
        try {
          if (bp.period < prevPeriod) {
            // Older than 1 month: lock without carryover to prevent multi-month chaining
            const locked = await this.prisma.asSystem().$transaction(async (tx) => {
              return this.budgetPeriodLockService.lockPeriodInTx(tx, bp.id, budget.user_id, now);
            });
            if (locked) {
              processedCount++;
            } else {
              skippedCount++;
            }
            continue;
          }

          if (bp.period === prevPeriod) {
            if (dayOfMonth >= '02') {
              this.logger.warn(
                `Budget rollover lag > 24h detected for budget ${budget.id}, period ${bp.period}`,
              );
            }

            const ok = await this.prisma.asSystem().$transaction(async (tx) => {
              // 1. Lock bp
              const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT id FROM budget_periods
                WHERE id = ${bp.id}::uuid AND locked_at IS NULL
                FOR UPDATE SKIP LOCKED
              `;
              if (lockRows.length === 0) {
                return false;
              }

              // 2. Compute carryoverIn
              const prevCat = bp.categories?.[0];
              const rolloverEnabled =
                budget.type === 'CATEGORY' ? Boolean(prevCat?.rollover_enabled) : false;

              let spentPrev = 0n;
              const overview = await this.budgetsService.computeUsageForPeriod(
                userId,
                bp.period,
                tx,
              );
              if (budget.type === 'TOTAL') {
                spentPrev = BigInt(Math.round(overview.total_budget?.spent_amount ?? 0));
              } else {
                const match = overview.category_budgets.find((c) => c.id === budget.id);
                spentPrev = BigInt(Math.round(match?.spent_amount ?? 0));
              }

              const carryoverIn = computeCarryoverAmount({
                type: budget.type,
                rolloverEnabled,
                baseAmount: bp.base_amount,
                prevCarryover: bp.carryover_amount,
                spent: spentPrev,
              });

              if (budget.type === 'CATEGORY' && prevCat) {
                await tx.rolloverConfig.upsert({
                  where: { budget_category_id: prevCat.id },
                  create: {
                    budget_category_id: prevCat.id,
                    enabled: rolloverEnabled,
                    last_computed_carryover: carryoverIn,
                    last_computed_at: now,
                  },
                  update: {
                    last_computed_carryover: carryoverIn,
                    last_computed_at: now,
                  },
                });
              }

              // 3. Ensure currentPeriod BudgetPeriod exists
              const existingCurrent = await tx.budgetPeriod.findFirst({
                where: {
                  budget_id: budget.id,
                  period: currentPeriod,
                },
              });

              if (existingCurrent) {
                if (existingCurrent.locked_at === null) {
                  await tx.budgetPeriod.update({
                    where: { id: existingCurrent.id },
                    data: { carryover_amount: carryoverIn },
                  });
                  if (budget.type === 'CATEGORY') {
                    await tx.budgetCategory.updateMany({
                      where: { budget_period_id: existingCurrent.id },
                      data: { carryover_amount: carryoverIn },
                    });
                  }
                }
              } else {
                try {
                  const newPeriod = await tx.budgetPeriod.create({
                    data: {
                      budget_id: budget.id,
                      period: currentPeriod,
                      base_amount: bp.base_amount,
                      carryover_amount: carryoverIn,
                    },
                  });

                  if (budget.type === 'CATEGORY') {
                    const categoryId = budget.category_id ?? prevCat?.category_id;
                    if (categoryId) {
                      const newCat = await tx.budgetCategory.create({
                        data: {
                          budget_period_id: newPeriod.id,
                          category_id: categoryId,
                          amount: bp.base_amount,
                          rollover_enabled: prevCat?.rollover_enabled ?? false,
                          carryover_amount: carryoverIn,
                        },
                      });

                      await tx.rolloverConfig.create({
                        data: {
                          budget_category_id: newCat.id,
                          enabled: prevCat?.rollover_enabled ?? false,
                          last_computed_carryover: 0n,
                        },
                      });
                    }
                  }
                } catch (createErr: any) {
                  if (
                    createErr instanceof Prisma.PrismaClientKnownRequestError &&
                    createErr.code === 'P2002'
                  ) {
                    const raceCurrent = await tx.budgetPeriod.findFirst({
                      where: {
                        budget_id: budget.id,
                        period: currentPeriod,
                      },
                    });
                    if (raceCurrent && raceCurrent.locked_at === null) {
                      await tx.budgetPeriod.update({
                        where: { id: raceCurrent.id },
                        data: { carryover_amount: carryoverIn },
                      });
                      if (budget.type === 'CATEGORY') {
                        await tx.budgetCategory.updateMany({
                          where: { budget_period_id: raceCurrent.id },
                          data: { carryover_amount: carryoverIn },
                        });
                      }
                    }
                  } else {
                    throw createErr;
                  }
                }
              }

              // 4. Lock period atomically
              await this.budgetPeriodLockService.lockPeriodInTx(tx, bp.id, budget.user_id, now);

              return true;
            });

            if (ok) {
              processedCount++;
            } else {
              skippedCount++;
            }
          }
        } catch (err: any) {
          errors++;
          this.logger.error(
            `Failed to process month turn for budget ${budget.id}, period ${bp.period}: ${err.message}`,
          );
        }
      }
    }

    return { processedCount, skippedCount, errors };
  }
}
