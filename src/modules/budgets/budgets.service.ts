import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, BudgetType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { todayInTz } from '../../common/utils/date.js';
import type { CreateBudgetDto, UpdateBudgetDto } from './dto/budget.dto.js';

export interface BudgetResponse {
  id: string;
  financial_profile_id: string;
  type: BudgetType;
  category_id: string | null;
  scope_account_ids: string[];
  period: string;
  period_id: string;
  amount: number;
  base_amount: number;
  carryover_amount: number;
  effective_amount: number;
  rollover_enabled: boolean;
  locked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type BudgetStatusLevel = 'NORMAL' | 'WARNING_80' | 'EXCEEDED_100';

export interface BudgetUsageItem {
  id: string;
  period_id: string;
  period: string;
  type: string;
  category_id: string | null;
  category_name: string | null;
  scope_account_ids: string[];
  base_amount: number;
  carryover_amount: number;
  effective_amount: number;
  spent_amount: number;
  remaining_amount: number;
  usage_percent: number;
  rollover_enabled: boolean;
  locked_at: Date | null;
  status_level: BudgetStatusLevel;
}

export interface ExpenseCategoryItem {
  id: string;
  name: string;
  parent_id: string | null;
  icon?: string | null;
  color?: string | null;
}

export interface BudgetOverviewResponse {
  period: string;
  is_locked: boolean;
  available_periods: string[];
  expense_categories: ExpenseCategoryItem[];
  total_budget: BudgetUsageItem | null;
  category_budgets: BudgetUsageItem[];
}

export function toBudgetResponse(
  budget: {
    id: string;
    financial_profile_id: string;
    type: BudgetType;
    category_id: string | null;
    scope_account_ids: string[];
    created_at: Date;
    updated_at: Date;
  },
  period: {
    id: string;
    period: string;
    base_amount: bigint | number;
    carryover_amount?: bigint | number;
    locked_at?: Date | null;
    categories?: Array<{
      amount?: bigint | number;
      rollover_enabled?: boolean;
      carryover_amount?: bigint | number;
    }>;
  },
): BudgetResponse {
  const rolloverEnabled =
    budget.type === 'CATEGORY'
      ? Boolean(period.categories?.[0]?.rollover_enabled)
      : false;

  const baseAmountNum = Number(period.base_amount);
  const carryoverAmountNum = Number(period.carryover_amount ?? 0);

  return {
    id: budget.id,
    financial_profile_id: budget.financial_profile_id,
    type: budget.type,
    category_id: budget.category_id,
    scope_account_ids: budget.scope_account_ids,
    period: period.period,
    period_id: period.id,
    amount: baseAmountNum,
    base_amount: baseAmountNum,
    carryover_amount: carryoverAmountNum,
    effective_amount: baseAmountNum + carryoverAmountNum,
    rollover_enabled: rolloverEnabled,
    locked_at: period.locked_at ?? null,
    created_at: budget.created_at,
    updated_at: budget.updated_at,
  };
}

@Injectable()
export class BudgetsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwnedBudget(userId: string, budgetId: string) {
    const budget = await this.prisma.budget.findFirst({
      where: {
        id: budgetId,
        user_id: userId,
      },
    });

    if (!budget) {
      throw new NotFoundException({
        code: 'BUDGET_NOT_FOUND',
        message: 'Anggaran tidak ditemukan',
      });
    }

    return budget;
  }

  async create(
    user: { userId: string; role?: string },
    dto: CreateBudgetDto,
  ): Promise<BudgetResponse> {
    if (dto.type === 'TOTAL' && dto.rollover_enabled === true) {
      throw new UnprocessableEntityException({
        code: 'ROLLOVER_TOTAL_NOT_ALLOWED',
        message: 'Rollover hanya berlaku untuk anggaran kategori',
      });
    }

    const defaultProfile = await this.prisma.financialProfile.findFirst({
      where: {
        user_id: user.userId,
        is_default: true,
      },
    });

    if (!defaultProfile) {
      throw new NotFoundException({
        code: 'PROFILE_NOT_FOUND',
        message: 'Profil keuangan tidak ditemukan',
      });
    }

    const pref = await this.prisma.userPreference.findFirst({
      where: {
        user_id: user.userId,
      },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const currentPeriod = todayInTz(tz).slice(0, 7);
    const targetPeriod = dto.period ?? currentPeriod;

    if (targetPeriod < currentPeriod) {
      throw new ConflictException({
        code: 'BUDGET_PERIOD_LOCKED',
        message: 'Periode anggaran sudah dikunci dan tidak dapat diubah',
      });
    }

    const rawScopeIds = dto.scope_account_ids ?? [];
    const scopeAccountIds = Array.from(new Set(rawScopeIds));

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM financial_profiles WHERE id = ${defaultProfile.id}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE`;

        if (dto.type === 'CATEGORY') {
          const category = await tx.category.findFirst({
            where: {
              id: dto.category_id,
              user_id: user.userId,
            },
          });

          if (!category) {
            throw new NotFoundException({
              code: 'CATEGORY_NOT_FOUND',
              message: 'Kategori tidak ditemukan',
            });
          }

          if (category.archived) {
            throw new UnprocessableEntityException({
              code: 'CATEGORY_ARCHIVED',
              message: 'Kategori sudah diarsipkan',
            });
          }

          if (category.type !== 'EXPENSE') {
            throw new BadRequestException({
              code: 'INVALID_CATEGORY_TYPE',
              message: 'Anggaran kategori hanya berlaku untuk kategori pengeluaran (EXPENSE)',
            });
          }
        }

        if (scopeAccountIds.length > 0) {
          const accounts = await tx.account.findMany({
            where: {
              id: { in: scopeAccountIds },
              user_id: user.userId,
            },
          });

          if (accounts.length < scopeAccountIds.length) {
            throw new NotFoundException({
              code: 'ACCOUNT_NOT_FOUND',
              message: 'Akun tidak ditemukan',
            });
          }

          if (accounts.some((acc) => acc.archived)) {
            throw new ConflictException({
              code: 'ACCOUNT_ARCHIVED',
              message: 'Akun sudah diarsipkan',
            });
          }
        }

        let budget = await tx.budget.findFirst({
          where: {
            user_id: user.userId,
            financial_profile_id: defaultProfile.id,
            type: dto.type,
            category_id: dto.type === 'TOTAL' ? null : dto.category_id,
          },
        });

        if (budget) {
          const existingPeriod = await tx.budgetPeriod.findFirst({
            where: {
              budget_id: budget.id,
              period: targetPeriod,
            },
          });

          if (existingPeriod) {
            throw new ConflictException({
              code: 'BUDGET_ALREADY_EXISTS',
              message: 'Anggaran untuk periode ini sudah ada',
            });
          }

          if (dto.scope_account_ids !== undefined) {
            budget = await tx.budget.update({
              where: {
                id: budget.id,
                user_id: user.userId,
              },
              data: {
                scope_account_ids: scopeAccountIds,
              },
            });
          }
        } else {
          budget = await tx.budget.create({
            data: {
              user_id: user.userId,
              financial_profile_id: defaultProfile.id,
              type: dto.type,
              category_id: dto.type === 'TOTAL' ? null : dto.category_id,
              scope_account_ids: scopeAccountIds,
            },
          });
        }

        const periodRecord = await tx.budgetPeriod.create({
          data: {
            budget_id: budget.id,
            period: targetPeriod,
            base_amount: BigInt(dto.amount),
            carryover_amount: 0n,
          },
        });

        let categories: any[] = [];
        if (dto.type === 'CATEGORY') {
          const rolloverEnabled = dto.rollover_enabled ?? false;
          const budgetCat = await tx.budgetCategory.create({
            data: {
              budget_period_id: periodRecord.id,
              category_id: dto.category_id!,
              amount: BigInt(dto.amount),
              rollover_enabled: rolloverEnabled,
              carryover_amount: 0n,
            },
          });

          await tx.rolloverConfig.create({
            data: {
              budget_category_id: budgetCat.id,
              enabled: rolloverEnabled,
              last_computed_carryover: 0n,
            },
          });

          categories = [budgetCat];
        }

        const response = toBudgetResponse(budget, {
          ...periodRecord,
          categories,
        });

        await tx.auditLog.create({
          data: {
            action: 'BUDGET_CREATE',
            resource_type: 'budget',
            resource_id: budget.id,
            actor_user_id: user.userId,
            actor_role: user.role ?? 'USER',
            after: response as unknown as Prisma.InputJsonValue,
          },
        });

        return response;
      });
    } catch (error: any) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          code: 'BUDGET_ALREADY_EXISTS',
          message: 'Anggaran untuk periode ini sudah ada',
        });
      }
      throw error;
    }
  }

  async update(
    user: { userId: string; role?: string },
    budgetId: string,
    dto: UpdateBudgetDto,
  ): Promise<BudgetResponse> {
    const budget = await this.getOwnedBudget(user.userId, budgetId);

    if (budget.type === 'TOTAL' && dto.rollover_enabled === true) {
      throw new UnprocessableEntityException({
        code: 'ROLLOVER_TOTAL_NOT_ALLOWED',
        message: 'Rollover hanya berlaku untuk anggaran kategori',
      });
    }

    const pref = await this.prisma.userPreference.findFirst({
      where: {
        user_id: user.userId,
      },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const currentPeriod = todayInTz(tz).slice(0, 7);
    const targetPeriod = dto.period ?? currentPeriod;

    if (targetPeriod < currentPeriod) {
      throw new ConflictException({
        code: 'BUDGET_PERIOD_LOCKED',
        message: 'Periode anggaran sudah dikunci dan tidak dapat diubah',
      });
    }

    let scopeAccountIds: string[] | undefined;
    if (dto.scope_account_ids !== undefined) {
      scopeAccountIds = Array.from(new Set(dto.scope_account_ids));
    }

    return await this.prisma.$transaction(async (tx) => {
      if (scopeAccountIds && scopeAccountIds.length > 0) {
        const accounts = await tx.account.findMany({
          where: {
            id: { in: scopeAccountIds },
            user_id: user.userId,
          },
        });

        if (accounts.length < scopeAccountIds.length) {
          throw new NotFoundException({
            code: 'ACCOUNT_NOT_FOUND',
            message: 'Akun tidak ditemukan',
          });
        }

        if (accounts.some((acc) => acc.archived)) {
          throw new ConflictException({
            code: 'ACCOUNT_ARCHIVED',
            message: 'Akun sudah diarsipkan',
          });
        }
      }

      const periodRecord = await tx.budgetPeriod.findFirst({
        where: {
          budget_id: budget.id,
          period: targetPeriod,
        },
        include: {
          categories: {
            include: {
              rollover_config: true,
            },
          },
        },
      });

      if (!periodRecord) {
        throw new NotFoundException({
          code: 'BUDGET_NOT_FOUND',
          message: 'Periode anggaran tidak ditemukan',
        });
      }

      if (periodRecord.locked_at !== null) {
        throw new ConflictException({
          code: 'BUDGET_PERIOD_LOCKED',
          message: 'Periode anggaran sudah dikunci dan tidak dapat diubah',
        });
      }

      const beforeResponse = toBudgetResponse(budget, periodRecord);

      let updatedBudget = budget;
      if (scopeAccountIds !== undefined) {
        updatedBudget = await tx.budget.update({
          where: {
            id: budget.id,
            user_id: user.userId,
          },
          data: {
            scope_account_ids: scopeAccountIds,
          },
        });
      }

      let updatedPeriod = periodRecord;
      if (dto.amount !== undefined) {
        updatedPeriod = await tx.budgetPeriod.update({
          where: {
            id: periodRecord.id,
          },
          data: {
            base_amount: BigInt(dto.amount),
          },
          include: {
            categories: {
              include: {
                rollover_config: true,
              },
            },
          },
        });
      }

      if (budget.type === 'CATEGORY') {
        const budgetCat = periodRecord.categories[0];
        if (budgetCat) {
          const newAmount =
            dto.amount !== undefined ? BigInt(dto.amount) : budgetCat.amount;
          const newRollover =
            dto.rollover_enabled !== undefined
              ? dto.rollover_enabled
              : budgetCat.rollover_enabled;

          const updatedCat = await tx.budgetCategory.update({
            where: {
              id: budgetCat.id,
            },
            data: {
              amount: newAmount,
              rollover_enabled: newRollover,
            },
            include: {
              rollover_config: true,
            },
          });

          let updatedConfig = updatedCat.rollover_config;
          if (updatedCat.rollover_config) {
            updatedConfig = await tx.rolloverConfig.update({
              where: {
                id: updatedCat.rollover_config.id,
              },
              data: {
                enabled: newRollover,
              },
            });
          } else {
            updatedConfig = await tx.rolloverConfig.create({
              data: {
                budget_category_id: updatedCat.id,
                enabled: newRollover,
              },
            });
          }

          updatedPeriod.categories = [{ ...updatedCat, rollover_config: updatedConfig }];
        }
      }

      const afterResponse = toBudgetResponse(updatedBudget, updatedPeriod);

      await tx.auditLog.create({
        data: {
          action: 'BUDGET_UPDATE',
          resource_type: 'budget',
          resource_id: budget.id,
          actor_user_id: user.userId,
          actor_role: user.role ?? 'USER',
          before: beforeResponse as unknown as Prisma.InputJsonValue,
          after: afterResponse as unknown as Prisma.InputJsonValue,
        },
      });

      return afterResponse;
    });
  }

  async computeUsageForPeriod(
    userId: string,
    period?: string,
    dbClient?: any,
  ): Promise<BudgetOverviewResponse> {
    const client = dbClient ?? this.prisma;

    // 1. Profil default & timezone user
    const defaultProfile = await client.financialProfile.findFirst({
      where: {
        user_id: userId,
        is_default: true,
      },
    });

    if (!defaultProfile) {
      throw new NotFoundException({
        code: 'PROFILE_NOT_FOUND',
        message: 'Profil keuangan tidak ditemukan',
      });
    }

    const pref = await client.userPreference.findFirst({
      where: {
        user_id: userId,
      },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const currentPeriod = todayInTz(tz).slice(0, 7);
    const targetPeriod = period ?? currentPeriod;

    // 2. Ambil daftar Budget milik user_id beserta periods dan categories
    const budgets = await client.budget.findMany({
      where: {
        user_id: userId,
        financial_profile_id: defaultProfile.id,
      },
      include: {
        periods: {
          include: {
            categories: true,
          },
        },
      },
    });

    // available_periods: daftar 'YYYY-MM' historis terurut menurun
    const allPeriodsSet = new Set<string>();
    for (const b of budgets) {
      for (const p of b.periods) {
        allPeriodsSet.add(p.period);
      }
    }
    const available_periods = Array.from(allPeriodsSet).sort((a, b) => b.localeCompare(a));

    // Filter periods pada targetPeriod
    const activePeriods = budgets.flatMap((b: any) =>
      b.periods.filter((p: any) => p.period === targetPeriod),
    );
    const is_locked =
      targetPeriod < currentPeriod || activePeriods.some((p: any) => p.locked_at !== null);

    // 3. Ambil semua Category bertipe 'EXPENSE' milik user_id
    const expenseCategories = await client.category.findMany({
      where: {
        user_id: userId,
        financial_profile_id: defaultProfile.id,
        type: 'EXPENSE',
      },
    });

    const expense_categories: ExpenseCategoryItem[] = expenseCategories
      .filter((c: any) => !c.archived)
      .map((c: any) => ({
        id: c.id,
        name: c.name,
        parent_id: c.parent_id,
        icon: c.icon,
        color: c.color,
      }));

    const categoryMap = new Map<string, any>();
    const childrenMap = new Map<string, string[]>();
    for (const c of expenseCategories) {
      categoryMap.set(c.id, c);
      if (c.parent_id) {
        const list = childrenMap.get(c.parent_id) ?? [];
        list.push(c.id);
        childrenMap.set(c.parent_id, list);
      }
    }

    // 4. Ambil semua Transaction efektif bulan tersebut jika ada BudgetPeriod pada targetPeriod
    let transactions: any[] = [];
    if (activePeriods.length > 0) {
      const [yearStr, monthStr] = targetPeriod.split('-');
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);
      const startDate = new Date(Date.UTC(year, month - 1, 1));
      const nextMonthStart = new Date(Date.UTC(year, month, 1));

      transactions = await client.transaction.findMany({
        where: {
          user_id: userId,
          financial_profile_id: defaultProfile.id,
          type: 'EXPENSE',
          status: 'POSTED',
          reversal: null,
          date: {
            gte: startDate,
            lt: nextMonthStart,
          },
        },
        include: {
          splits: {
            select: {
              category_id: true,
              amount: true,
            },
          },
        },
      });
    }

    let total_budget: BudgetUsageItem | null = null;
    const category_budgets: BudgetUsageItem[] = [];

    for (const b of budgets) {
      const periodRecord = b.periods.find((p: any) => p.period === targetPeriod);
      if (!periodRecord) continue;

      const baseAmountBig = periodRecord.base_amount;
      const carryoverBig = b.type === 'CATEGORY' ? periodRecord.carryover_amount : 0n;
      const effectiveBig = baseAmountBig + carryoverBig;

      // Matching category IDs for rollup subkategori 1 level
      const targetCatIds = new Set<string>();
      if (b.type === 'CATEGORY' && b.category_id) {
        targetCatIds.add(b.category_id);
        const catDef = categoryMap.get(b.category_id);
        const isParent = !catDef?.parent_id;
        if (isParent) {
          const children = childrenMap.get(b.category_id) ?? [];
          for (const childId of children) {
            targetCatIds.add(childId);
          }
        }
      }

      let spentBig = 0n;
      const scopeIds = b.scope_account_ids ?? [];
      const hasScope = scopeIds.length > 0;

      for (const tx of transactions) {
        if (hasScope && !scopeIds.includes(tx.account_id)) {
          continue;
        }

        if (b.type === 'TOTAL') {
          spentBig += tx.amount;
        } else if (b.type === 'CATEGORY') {
          if (tx.splits && tx.splits.length > 0) {
            for (const split of tx.splits) {
              if (targetCatIds.has(split.category_id)) {
                spentBig += split.amount;
              }
            }
          } else if (tx.category_id && targetCatIds.has(tx.category_id)) {
            spentBig += tx.amount;
          }
        }
      }

      const remainingBig = effectiveBig - spentBig;
      const usage_percent =
        effectiveBig > 0n
          ? Number((spentBig * 100n) / effectiveBig)
          : spentBig > 0n
            ? 100
            : 0;

      let status_level: BudgetStatusLevel = 'NORMAL';
      if ((effectiveBig > 0n && spentBig >= effectiveBig) || (effectiveBig === 0n && spentBig > 0n)) {
        status_level = 'EXCEEDED_100';
      } else if (effectiveBig > 0n && spentBig * 100n >= effectiveBig * 80n) {
        status_level = 'WARNING_80';
      } else {
        status_level = 'NORMAL';
      }

      const rolloverEnabled =
        b.type === 'CATEGORY'
          ? Boolean(periodRecord.categories?.[0]?.rollover_enabled)
          : false;

      const categoryName =
        b.type === 'CATEGORY' && b.category_id
          ? (categoryMap.get(b.category_id)?.name ?? null)
          : null;

      const item: BudgetUsageItem = {
        id: b.id,
        period_id: periodRecord.id,
        period: targetPeriod,
        type: b.type,
        category_id: b.category_id,
        category_name: categoryName,
        scope_account_ids: b.scope_account_ids,
        base_amount: Number(baseAmountBig),
        carryover_amount: Number(carryoverBig),
        effective_amount: Number(effectiveBig),
        spent_amount: Number(spentBig),
        remaining_amount: Number(remainingBig),
        usage_percent,
        rollover_enabled: rolloverEnabled,
        locked_at: periodRecord.locked_at,
        status_level,
      };

      if (b.type === 'TOTAL') {
        total_budget = item;
      } else {
        category_budgets.push(item);
      }
    }

    category_budgets.sort((a, b) =>
      (a.category_name ?? '').localeCompare(b.category_name ?? ''),
    );

    return {
      period: targetPeriod,
      is_locked,
      available_periods,
      expense_categories,
      total_budget,
      category_budgets,
    };
  }

  async getOverview(userId: string, period?: string): Promise<BudgetOverviewResponse> {
    return this.computeUsageForPeriod(userId, period);
  }

  async getSingleUsage(
    userId: string,
    budgetId: string,
    period?: string,
  ): Promise<BudgetUsageItem> {
    await this.getOwnedBudget(userId, budgetId);
    const overview = await this.computeUsageForPeriod(userId, period);

    if (overview.total_budget && overview.total_budget.id === budgetId) {
      return overview.total_budget;
    }

    const catBudget = overview.category_budgets.find((b) => b.id === budgetId);
    if (catBudget) {
      return catBudget;
    }

    throw new NotFoundException({
      code: 'BUDGET_NOT_FOUND',
      message: 'Anggaran untuk periode ini tidak ditemukan',
    });
  }
}
