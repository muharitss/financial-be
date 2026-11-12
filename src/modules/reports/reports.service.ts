import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { balanceEffects } from '../dashboard/balance-effects.js';
import { previousPeriod, currentPeriodInTz } from '../../common/utils/date.js';
import type { ReportFilter } from '../dashboard/dto/dashboard.dto.js';
import type {
  BalanceChangesResponse,
  BalanceChangeItem,
  MonthlyComparisonResponse,
  MonthlyComparisonCategoryItem,
} from './dto/reports.dto.js';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboardService: DashboardService,
  ) {}

  async getBalanceChanges(
    userId: string,
    filter?: ReportFilter,
  ): Promise<BalanceChangesResponse> {
    const { from, to } = await this.dashboardService.resolveRange(
      userId,
      filter?.from,
      filter?.to,
    );

    const accountFilter = filter?.account_id;
    const hasAccountFilter = Boolean(accountFilter && accountFilter.length > 0);

    const accounts = await this.prisma.account.findMany({
      where: {
        user_id: userId,
        archived: false,
        ...(hasAccountFilter ? { id: { in: accountFilter } } : {}),
      },
      select: {
        id: true,
        name: true,
        type: true,
        opening_balance: true,
        opening_date: true,
      },
      orderBy: { name: 'asc' },
    });

    const targetAccountIds = new Set(accounts.map((a) => a.id));
    if (targetAccountIds.size === 0) {
      return {
        from,
        to,
        items: [],
        totals: { opening: 0, inflow: 0, outflow: 0, closing: 0 },
      };
    }

    // shortcut: memuat seluruh histori transaksi s.d. 'to', ganti ke snapshot saldo harian bila histori > 50k baris (TASK-115)
    const [toYearStr, toMonthStr, toDayStr] = to.split('-');
    const toYear = parseInt(toYearStr, 10);
    const toMonth = parseInt(toMonthStr, 10);
    const toDay = parseInt(toDayStr, 10);
    const endDate = new Date(Date.UTC(toYear, toMonth - 1, toDay));

    const transactions = await this.prisma.transaction.findMany({
      where: {
        user_id: userId,
        status: { in: ['POSTED', 'REVERSED'] },
        date: { lte: endDate },
        OR: [
          { account_id: { in: Array.from(targetAccountIds) } },
          { to_account_id: { in: Array.from(targetAccountIds) } },
        ],
      },
      select: {
        id: true,
        type: true,
        amount: true,
        account_id: true,
        to_account_id: true,
        transfer_fee: true,
        fee_mode: true,
        date: true,
        parent: {
          select: {
            type: true,
          },
        },
      },
    });

    const accountStats = new Map<
      string,
      { opening: bigint; inflow: bigint; outflow: bigint }
    >();

    for (const acc of accounts) {
      accountStats.set(acc.id, { opening: 0n, inflow: 0n, outflow: 0n });
    }

    const [fromYearStr, fromMonthStr, fromDayStr] = from.split('-');
    const fromYear = parseInt(fromYearStr, 10);
    const fromMonth = parseInt(fromMonthStr, 10);
    const fromDay = parseInt(fromDayStr, 10);
    const startDate = new Date(Date.UTC(fromYear, fromMonth - 1, fromDay));

    for (const tx of transactions) {
      const txEffects = balanceEffects(tx);
      const isBeforePeriod = tx.date < startDate;

      for (const eff of txEffects) {
        if (!targetAccountIds.has(eff.account_id)) {
          continue;
        }
        const stat = accountStats.get(eff.account_id)!;

        if (isBeforePeriod) {
          stat.opening += eff.delta;
        } else {
          if (eff.delta > 0n) {
            stat.inflow += eff.delta;
          } else if (eff.delta < 0n) {
            stat.outflow += -eff.delta;
          }
        }
      }
    }

    const items: BalanceChangeItem[] = [];
    let totalOpening = 0n;
    let totalInflow = 0n;
    let totalOutflow = 0n;
    let totalClosing = 0n;

    for (const acc of accounts) {
      const stat = accountStats.get(acc.id)!;
      let opening = stat.opening;
      if (acc.opening_date < startDate) {
        opening += acc.opening_balance;
      } else if (acc.opening_date <= endDate) {
        if (acc.opening_balance > 0n) {
          stat.inflow += acc.opening_balance;
        } else if (acc.opening_balance < 0n) {
          stat.outflow += -acc.opening_balance;
        }
      }

      const closing = opening + stat.inflow - stat.outflow;

      totalOpening += opening;
      totalInflow += stat.inflow;
      totalOutflow += stat.outflow;
      totalClosing += closing;

      items.push({
        account_id: acc.id,
        name: acc.name,
        type: acc.type,
        opening: Number(opening),
        inflow: Number(stat.inflow),
        outflow: Number(stat.outflow),
        closing: Number(closing),
      });
    }

    return {
      from,
      to,
      items,
      totals: {
        opening: Number(totalOpening),
        inflow: Number(totalInflow),
        outflow: Number(totalOutflow),
        closing: Number(totalClosing),
      },
    };
  }

  async getMonthlyComparison(
    userId: string,
    targetMonth?: string,
  ): Promise<MonthlyComparisonResponse> {
    let month = targetMonth;
    if (!month) {
      const pref = await this.prisma.userPreference.findFirst({
        where: { user_id: userId },
      });
      const tz = pref?.timezone ?? 'Asia/Jakarta';
      month = currentPeriodInTz(tz);
    }

    const prevMonth = previousPeriod(month);

    const [currentYear, currentMonthNum] = month.split('-').map(Number);
    const lastDayCurrent = new Date(Date.UTC(currentYear, currentMonthNum, 0)).getUTCDate();
    const currentFrom = `${month}-01`;
    const currentTo = `${month}-${String(lastDayCurrent).padStart(2, '0')}`;

    const [prevYear, prevMonthNum] = prevMonth.split('-').map(Number);
    const lastDayPrev = new Date(Date.UTC(prevYear, prevMonthNum, 0)).getUTCDate();
    const prevFrom = `${prevMonth}-01`;
    const prevTo = `${prevMonth}-${String(lastDayPrev).padStart(2, '0')}`;

    const [currentSummary, prevSummary, currentCatBreakdown, prevCatBreakdown] =
      await Promise.all([
        this.dashboardService.getSummary(userId, { from: currentFrom, to: currentTo }),
        this.dashboardService.getSummary(userId, { from: prevFrom, to: prevTo }),
        this.dashboardService.getCategoryBreakdown(userId, {
          from: currentFrom,
          to: currentTo,
        }),
        this.dashboardService.getCategoryBreakdown(userId, {
          from: prevFrom,
          to: prevTo,
        }),
      ]);

    const deltaIncome = currentSummary.income - prevSummary.income;
    const deltaExpense = currentSummary.expense - prevSummary.expense;
    const deltaNet = currentSummary.net - prevSummary.net;

    const calcDeltaBp = (delta: number, previous: number): number | null => {
      if (previous === 0) return null;
      return Number((BigInt(delta) * 10000n) / BigInt(Math.abs(previous)));
    };

    const categoriesMap = new Map<
      string,
      { category_id: string | null; name: string; current: number; previous: number }
    >();

    for (const item of currentCatBreakdown.items) {
      const key = item.category_id ?? item.name;
      categoriesMap.set(key, {
        category_id: item.category_id,
        name: item.name,
        current: item.total,
        previous: 0,
      });
    }

    for (const item of prevCatBreakdown.items) {
      const key = item.category_id ?? item.name;
      const existing = categoriesMap.get(key);
      if (existing) {
        existing.previous = item.total;
      } else {
        categoriesMap.set(key, {
          category_id: item.category_id,
          name: item.name,
          current: 0,
          previous: item.total,
        });
      }
    }

    const categories: MonthlyComparisonCategoryItem[] = Array.from(
      categoriesMap.values(),
    )
      .map((c) => ({
        category_id: c.category_id,
        name: c.name,
        current: c.current,
        previous: c.previous,
        delta: c.current - c.previous,
      }))
      .sort((a, b) => b.current - a.current);

    return {
      month,
      previous_month: prevMonth,
      current: {
        income: currentSummary.income,
        expense: currentSummary.expense,
        net: currentSummary.net,
        adjustment_net: currentSummary.adjustment_net,
      },
      previous: {
        income: prevSummary.income,
        expense: prevSummary.expense,
        net: prevSummary.net,
        adjustment_net: prevSummary.adjustment_net,
      },
      delta: {
        income: deltaIncome,
        expense: deltaExpense,
        net: deltaNet,
      },
      delta_bp: {
        income: calcDeltaBp(deltaIncome, prevSummary.income),
        expense: calcDeltaBp(deltaExpense, prevSummary.expense),
        net: calcDeltaBp(deltaNet, prevSummary.net),
      },
      categories,
    };
  }
}
