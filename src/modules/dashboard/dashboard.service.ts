import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { todayInTz, currentPeriodInTz, previousPeriod } from '../../common/utils/date.js';
import { AccountsService, AccountResponse } from '../accounts/accounts.service.js';
import { balanceEffects } from './balance-effects.js';
import type {
  DateRangeDto,
  ReportFilter,
  DashboardSummaryResponse,
  DashboardCashFlowResponse,
  CashFlowItem,
  DashboardCategoryBreakdownResponse,
  CategoryBreakdownItem,
  BalanceTrendPoint,
  DashboardBalanceTrendResponse,
} from './dto/dashboard.dto.js';

export interface DashboardBalancesResponse {
  ledger_balance: number;
  reserved_total: number;
  available_balance: number;
  net_worth: number;
  accounts_count: number;
  as_of: string;
}

export function computeBalances(accounts: AccountResponse[]): DashboardBalancesResponse {
  const activeAccounts = accounts.filter((acc) => !acc.archived);

  let ledgerSum = 0n;
  let reservedSum = 0n;
  let liquidSum = 0n;
  let netWorthSum = 0n;

  for (const acc of activeAccounts) {
    const bal = BigInt(acc.balance);
    const res = BigInt(acc.reserved);

    ledgerSum += bal;
    reservedSum += res;

    if (acc.type !== 'INVESTMENT' && acc.type !== 'RECEIVABLE') {
      liquidSum += bal;
    }

    if (bal >= 0n) {
      netWorthSum += bal;
    }
  }

  const availableSum = liquidSum - reservedSum;

  return {
    ledger_balance: Number(ledgerSum),
    reserved_total: Number(reservedSum),
    available_balance: Number(availableSum),
    net_worth: Number(netWorthSum),
    accounts_count: activeAccounts.length,
    as_of: new Date().toISOString(),
  };
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly accountsService: AccountsService,
    private readonly prisma: PrismaService,
  ) {}

  async getBalances(userId: string): Promise<DashboardBalancesResponse> {
    const accounts = await this.accountsService.list(userId);
    return computeBalances(accounts);
  }

  async resolveRange(
    userId: string,
    from?: string,
    to?: string,
  ): Promise<{ from: string; to: string }> {
    let resolvedFrom = from;
    let resolvedTo = to;

    if (!resolvedFrom || !resolvedTo) {
      const pref = await this.prisma.userPreference.findFirst({
        where: { user_id: userId },
      });
      const tz = pref?.timezone ?? 'Asia/Jakarta';
      const today = todayInTz(tz);
      const currentPeriod = today.slice(0, 7);
      const [yearStr, monthStr] = currentPeriod.split('-');
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

      if (!resolvedFrom) {
        resolvedFrom = `${currentPeriod}-01`;
      }
      if (!resolvedTo) {
        resolvedTo = `${currentPeriod}-${String(lastDay).padStart(2, '0')}`;
      }
    }

    if (resolvedFrom > resolvedTo) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Tanggal awal (from) tidak boleh lebih besar dari tanggal akhir (to)',
      });
    }

    const startDate = new Date(`${resolvedFrom}T00:00:00.000Z`);
    const endDate = new Date(`${resolvedTo}T00:00:00.000Z`);
    const diffMs = endDate.getTime() - startDate.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000)) + 1;

    if (diffDays > 366) {
      throw new BadRequestException({
        code: 'DATE_RANGE_TOO_LARGE',
        message: 'Rentang tanggal maksimal 366 hari',
      });
    }

    return { from: resolvedFrom, to: resolvedTo };
  }

  async loadEffectiveTransactions(
    userId: string,
    from: string,
    to: string,
    filter?: ReportFilter,
  ) {
    const startDate = new Date(`${from}T00:00:00.000Z`);
    const [toYearStr, toMonthStr, toDayStr] = to.split('-');
    const toYear = parseInt(toYearStr, 10);
    const toMonth = parseInt(toMonthStr, 10);
    const toDay = parseInt(toDayStr, 10);
    const nextDayDate = new Date(Date.UTC(toYear, toMonth - 1, toDay + 1));

    const where: any = {
      user_id: userId,
      status: 'POSTED',
      type: { in: ['INCOME', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT'] },
      date: {
        gte: startDate,
        lt: nextDayDate,
      },
    };

    if (filter?.account_id && filter.account_id.length > 0) {
      where.OR = [
        { account_id: { in: filter.account_id } },
        { to_account_id: { in: filter.account_id } },
      ];
    }

    return this.prisma.transaction.findMany({
      where,
      include: {
        splits: {
          select: {
            id: true,
            category_id: true,
            amount: true,
          },
        },
      },
      orderBy: { date: 'asc' },
    });
  }

  async getSummary(
    userId: string,
    filter?: ReportFilter,
  ): Promise<DashboardSummaryResponse> {
    const { from, to } = await this.resolveRange(userId, filter?.from, filter?.to);
    const transactions = await this.loadEffectiveTransactions(userId, from, to, filter);

    // shortcut: agregasi in-memory, pindah ke SQL GROUP BY bila p95 > 500ms (TASK-115)
    let incomeSum = 0n;
    let expenseSum = 0n;
    let adjustmentSum = 0n;
    let transferSum = 0n;

    const hasCategoryFilter = Boolean(filter?.category_id && filter.category_id.length > 0);
    let targetCategoryIds: Set<string> | null = null;

    if (hasCategoryFilter) {
      const categories = await this.prisma.category.findMany({
        where: { user_id: userId },
        select: { id: true, parent_id: true },
      });

      targetCategoryIds = new Set<string>();
      for (const catId of filter!.category_id!) {
        targetCategoryIds.add(catId);
        for (const cat of categories) {
          if (cat.parent_id === catId) {
            targetCategoryIds.add(cat.id);
          }
        }
      }
    }

    for (const tx of transactions) {
      if (hasCategoryFilter) {
        if (tx.type !== 'INCOME' && tx.type !== 'EXPENSE') {
          continue;
        }

        if (tx.splits && tx.splits.length > 0) {
          let matchedSplitAmount = 0n;
          for (const split of tx.splits) {
            if (targetCategoryIds!.has(split.category_id)) {
              matchedSplitAmount += split.amount;
            }
          }
          if (tx.type === 'INCOME') {
            incomeSum += matchedSplitAmount;
          } else if (tx.type === 'EXPENSE') {
            expenseSum += matchedSplitAmount;
          }
        } else if (tx.category_id && targetCategoryIds!.has(tx.category_id)) {
          if (tx.type === 'INCOME') {
            incomeSum += tx.amount;
          } else if (tx.type === 'EXPENSE') {
            expenseSum += tx.amount;
          }
        }
      } else {
        if (tx.type === 'INCOME') {
          incomeSum += tx.amount;
        } else if (tx.type === 'EXPENSE') {
          expenseSum += tx.amount;
        } else if (tx.type === 'ADJUSTMENT') {
          adjustmentSum += tx.amount;
        } else if (tx.type === 'TRANSFER') {
          transferSum += tx.amount;
        }
      }
    }

    const netSum = incomeSum - expenseSum;

    return {
      from,
      to,
      income: Number(incomeSum),
      expense: Number(expenseSum),
      net: Number(netSum),
      adjustment_net: Number(adjustmentSum),
      transfer_total: Number(transferSum),
    };
  }

  async getCashFlow(
    userId: string,
    months: number = 6,
  ): Promise<DashboardCashFlowResponse> {
    const pref = await this.prisma.userPreference.findFirst({
      where: { user_id: userId },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const currentMonth = currentPeriodInTz(tz);

    const monthList: string[] = [];
    let curr = currentMonth;
    for (let i = 0; i < months; i++) {
      monthList.push(curr);
      if (i < months - 1) {
        curr = previousPeriod(curr);
      }
    }
    monthList.reverse();

    const startMonth = monthList[0];
    const endMonth = monthList[monthList.length - 1];
    const from = `${startMonth}-01`;

    const [endYearStr, endMonthStr] = endMonth.split('-');
    const endYear = parseInt(endYearStr, 10);
    const endMonthNum = parseInt(endMonthStr, 10);
    const lastDay = new Date(Date.UTC(endYear, endMonthNum, 0)).getUTCDate();
    const to = `${endMonth}-${String(lastDay).padStart(2, '0')}`;

    const transactions = await this.loadEffectiveTransactions(userId, from, to);

    // shortcut: agregasi in-memory, pindah ke SQL GROUP BY bila p95 > 500ms (TASK-115)
    const buckets = new Map<string, { income: bigint; expense: bigint }>();
    for (const m of monthList) {
      buckets.set(m, { income: 0n, expense: 0n });
    }

    for (const tx of transactions) {
      const txDateStr =
        tx.date instanceof Date
          ? tx.date.toISOString().slice(0, 10)
          : String(tx.date).slice(0, 10);
      const m = txDateStr.slice(0, 7);
      const bucket = buckets.get(m);
      if (!bucket) continue;

      if (tx.type === 'INCOME') {
        bucket.income += tx.amount;
      } else if (tx.type === 'EXPENSE') {
        bucket.expense += tx.amount;
      }
    }

    const items: CashFlowItem[] = monthList.map((m) => {
      const b = buckets.get(m)!;
      const inc = Number(b.income);
      const exp = Number(b.expense);
      return {
        month: m,
        income: inc,
        expense: exp,
        net: inc - exp,
      };
    });

    return { items };
  }

  async getCategoryBreakdown(
    userId: string,
    filter?: ReportFilter,
  ): Promise<DashboardCategoryBreakdownResponse> {
    const { from, to } = await this.resolveRange(userId, filter?.from, filter?.to);
    const transactions = await this.loadEffectiveTransactions(userId, from, to, filter);

    const categories = await this.prisma.category.findMany({
      where: { user_id: userId, type: 'EXPENSE' },
      select: {
        id: true,
        name: true,
        parent_id: true,
        icon: true,
        color: true,
        archived: true,
      },
    });

    const categoryMap = new Map<string, (typeof categories)[0]>();
    for (const cat of categories) {
      categoryMap.set(cat.id, cat);
    }

    const getParentCategory = (catId: string | null): (typeof categories)[0] | null => {
      if (!catId) return null;
      const cat = categoryMap.get(catId);
      if (!cat) return null;
      if (cat.parent_id) {
        return categoryMap.get(cat.parent_id) ?? cat;
      }
      return cat;
    };

    const hasCategoryFilter = Boolean(filter?.category_id && filter.category_id.length > 0);
    let targetCategoryIds: Set<string> | null = null;

    if (hasCategoryFilter) {
      targetCategoryIds = new Set<string>();
      for (const catId of filter!.category_id!) {
        targetCategoryIds.add(catId);
        for (const cat of categories) {
          if (cat.parent_id === catId) {
            targetCategoryIds.add(cat.id);
          }
        }
      }
    }

    // shortcut: agregasi in-memory, pindah ke SQL GROUP BY bila p95 > 500ms (TASK-115)
    const sums = new Map<string | null, bigint>();

    const addToCategory = (catId: string | null, amount: bigint) => {
      const target = getParentCategory(catId);
      const key = target ? target.id : null;
      sums.set(key, (sums.get(key) ?? 0n) + amount);
    };

    for (const tx of transactions) {
      if (tx.type !== 'EXPENSE') {
        continue;
      }

      if (hasCategoryFilter) {
        if (tx.splits && tx.splits.length > 0) {
          for (const split of tx.splits) {
            if (targetCategoryIds!.has(split.category_id)) {
              addToCategory(split.category_id, split.amount);
            }
          }
        } else if (tx.category_id && targetCategoryIds!.has(tx.category_id)) {
          addToCategory(tx.category_id, tx.amount);
        }
      } else {
        if (tx.splits && tx.splits.length > 0) {
          for (const split of tx.splits) {
            addToCategory(split.category_id, split.amount);
          }
        } else {
          addToCategory(tx.category_id, tx.amount);
        }
      }
    }

    let totalBig = 0n;
    for (const amount of sums.values()) {
      totalBig += amount;
    }

    if (totalBig <= 0n) {
      return {
        from,
        to,
        total: 0,
        items: [],
      };
    }

    const items: CategoryBreakdownItem[] = [];

    for (const [catId, amountBig] of sums.entries()) {
      if (amountBig <= 0n) continue;

      const percent_bp = Number((amountBig * 10000n) / totalBig);

      if (catId === null) {
        items.push({
          category_id: null,
          name: 'Tanpa Kategori',
          icon: null,
          color: null,
          archived: false,
          amount: Number(amountBig),
          percent_bp,
        });
      } else {
        const cat = categoryMap.get(catId)!;
        items.push({
          category_id: cat.id,
          name: cat.name,
          icon: cat.icon ?? null,
          color: cat.color ?? null,
          archived: cat.archived,
          amount: Number(amountBig),
          percent_bp,
        });
      }
    }

    items.sort((a, b) => {
      if (b.amount !== a.amount) {
        return b.amount - a.amount;
      }
      return a.name.localeCompare(b.name);
    });

    return {
      from,
      to,
      total: Number(totalBig),
      items,
    };
  }

  async getBalanceTrend(
    userId: string,
    filter?: ReportFilter | DateRangeDto,
  ): Promise<DashboardBalanceTrendResponse> {
    const { from, to } = await this.resolveRange(userId, filter?.from, filter?.to);

    const accountFilter = (filter as ReportFilter)?.account_id;
    const hasAccountFilter = Boolean(accountFilter && accountFilter.length > 0);

    const accounts = await this.prisma.account.findMany({
      where: {
        user_id: userId,
        archived: false,
        ...(hasAccountFilter ? { id: { in: accountFilter } } : {}),
      },
      select: {
        id: true,
        opening_balance: true,
        opening_date: true,
      },
    });

    const targetAccountIds = new Set(accounts.map((a) => a.id));

    // shortcut: memuat seluruh histori transaksi s.d. 'to', ganti ke snapshot saldo harian bila histori > 50k baris (TASK-115)
    const [toYearStr, toMonthStr, toDayStr] = to.split('-');
    const toYear = parseInt(toYearStr, 10);
    const toMonth = parseInt(toMonthStr, 10);
    const toDay = parseInt(toDayStr, 10);
    const endDate = new Date(Date.UTC(toYear, toMonth - 1, toDay));

    const txWhere: any = {
      user_id: userId,
      status: { in: ['POSTED', 'REVERSED'] },
      date: { lte: endDate },
    };

    if (hasAccountFilter) {
      txWhere.OR = [
        { account_id: { in: accountFilter } },
        { to_account_id: { in: accountFilter } },
      ];
    }

    const transactions = await this.prisma.transaction.findMany({
      where: txWhere,
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

    const dailyDeltas = new Map<string, bigint>();

    for (const acc of accounts) {
      const d =
        acc.opening_date instanceof Date
          ? acc.opening_date.toISOString().slice(0, 10)
          : String(acc.opening_date).slice(0, 10);
      dailyDeltas.set(d, (dailyDeltas.get(d) ?? 0n) + acc.opening_balance);
    }

    for (const tx of transactions) {
      const txDateStr =
        tx.date instanceof Date
          ? tx.date.toISOString().slice(0, 10)
          : String(tx.date).slice(0, 10);

      const effects = balanceEffects(tx);
      for (const eff of effects) {
        if (targetAccountIds.has(eff.account_id)) {
          dailyDeltas.set(txDateStr, (dailyDeltas.get(txDateStr) ?? 0n) + eff.delta);
        }
      }
    }

    const [fromYearStr, fromMonthStr, fromDayStr] = from.split('-');
    const fromYear = parseInt(fromYearStr, 10);
    const fromMonth = parseInt(fromMonthStr, 10);
    const fromDay = parseInt(fromDayStr, 10);
    const startDate = new Date(Date.UTC(fromYear, fromMonth - 1, fromDay));

    const diffMs = endDate.getTime() - startDate.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000)) + 1;
    const granularity: 'day' | 'month' = diffDays <= 92 ? 'day' : 'month';

    const targetDates: string[] = [];
    if (granularity === 'day') {
      const curr = new Date(Date.UTC(fromYear, fromMonth - 1, fromDay));
      while (curr <= endDate) {
        targetDates.push(curr.toISOString().slice(0, 10));
        curr.setUTCDate(curr.getUTCDate() + 1);
      }
    } else {
      let y = fromYear;
      let m = fromMonth;
      while (y < toYear || (y === toYear && m <= toMonth)) {
        if (y === toYear && m === toMonth) {
          targetDates.push(to);
        } else {
          const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
          targetDates.push(`${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);
        }
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }
    }

    let currentBalance = 0n;
    const inRangeEvents: Array<{ date: string; delta: bigint }> = [];

    for (const [d, delta] of dailyDeltas.entries()) {
      if (d < from) {
        currentBalance += delta;
      } else if (d <= to) {
        inRangeEvents.push({ date: d, delta });
      }
    }

    inRangeEvents.sort((a, b) => a.date.localeCompare(b.date));

    let eventIdx = 0;
    const points: BalanceTrendPoint[] = [];

    for (const targetDate of targetDates) {
      while (eventIdx < inRangeEvents.length && inRangeEvents[eventIdx].date <= targetDate) {
        currentBalance += inRangeEvents[eventIdx].delta;
        eventIdx++;
      }
      points.push({
        date: targetDate,
        ledger_balance: Number(currentBalance),
      });
    }

    return {
      from,
      to,
      granularity,
      points,
    };
  }
}
