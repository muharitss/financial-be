import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import puppeteer, { type Browser } from 'puppeteer';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { balanceEffects } from '../dashboard/balance-effects.js';
import { previousPeriod, currentPeriodInTz } from '../../common/utils/date.js';
import { CSV_HEADER, CSV_BOM, transactionToCsvRow } from './csv.js';
import { renderReportHtml, type PdfReportData } from './pdf-template.js';
import type { ReportFilter } from '../dashboard/dto/dashboard.dto.js';
import type {
  BalanceChangesResponse,
  BalanceChangeItem,
  MonthlyComparisonResponse,
  MonthlyComparisonCategoryItem,
  ExportTransactionsCsvQueryDto,
} from './dto/reports.dto.js';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboardService: DashboardService,
    private readonly transactionsService: TransactionsService,
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
      const d =
        acc.opening_date instanceof Date
          ? acc.opening_date.toISOString().slice(0, 10)
          : String(acc.opening_date).slice(0, 10);
      if (d <= from) {
        accountStats.get(acc.id)!.opening += acc.opening_balance;
      } else if (d <= to) {
        if (acc.opening_balance >= 0n) {
          accountStats.get(acc.id)!.inflow += acc.opening_balance;
        } else {
          accountStats.get(acc.id)!.outflow += -acc.opening_balance;
        }
      }
    }

    for (const tx of transactions) {
      const txDateStr =
        tx.date instanceof Date
          ? tx.date.toISOString().slice(0, 10)
          : String(tx.date).slice(0, 10);

      const effects = balanceEffects(tx);
      for (const eff of effects) {
        const stats = accountStats.get(eff.account_id);
        if (!stats) continue;

        if (txDateStr < from) {
          stats.opening += eff.delta;
        } else if (txDateStr <= to) {
          if (eff.delta >= 0n) {
            stats.inflow += eff.delta;
          } else {
            stats.outflow += -eff.delta;
          }
        }
      }
    }

    let totalOpening = 0n;
    let totalInflow = 0n;
    let totalOutflow = 0n;
    let totalClosing = 0n;

    const items: BalanceChangeItem[] = [];

    for (const acc of accounts) {
      const stats = accountStats.get(acc.id)!;
      const closing = stats.opening + stats.inflow - stats.outflow;

      totalOpening += stats.opening;
      totalInflow += stats.inflow;
      totalOutflow += stats.outflow;
      totalClosing += closing;

      items.push({
        account_id: acc.id,
        name: acc.name,
        type: acc.type,
        opening: Number(stats.opening),
        inflow: Number(stats.inflow),
        outflow: Number(stats.outflow),
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
    month?: string,
  ): Promise<MonthlyComparisonResponse> {
    let targetMonth = month;
    if (!targetMonth) {
      const pref = await this.prisma.userPreference.findFirst({
        where: { user_id: userId },
      });
      const tz = pref?.timezone ?? 'Asia/Jakarta';
      targetMonth = currentPeriodInTz(tz);
    }

    const prevMonth = previousPeriod(targetMonth);

    const getMonthRange = (period: string) => {
      const [yStr, mStr] = period.split('-');
      const y = parseInt(yStr, 10);
      const m = parseInt(mStr, 10);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return {
        from: `${period}-01`,
        to: `${period}-${String(lastDay).padStart(2, '0')}`,
      };
    };

    const currentRange = getMonthRange(targetMonth);
    const prevRange = getMonthRange(prevMonth);

    const [currentSummary, prevSummary, currentCatRes, prevCatRes] =
      await Promise.all([
        this.dashboardService.getSummary(userId, currentRange),
        this.dashboardService.getSummary(userId, prevRange),
        this.dashboardService.getCategoryBreakdown(userId, currentRange),
        this.dashboardService.getCategoryBreakdown(userId, prevRange),
      ]);

    const deltaIncome = currentSummary.income - prevSummary.income;
    const deltaExpense = currentSummary.expense - prevSummary.expense;
    const deltaNet = currentSummary.net - prevSummary.net;

    const calcDeltaBp = (delta: number, previous: number): number | null => {
      if (previous === 0) return null;
      const deltaBig = BigInt(delta);
      const prevBig = BigInt(Math.abs(previous));
      return Number((deltaBig * 10000n) / prevBig);
    };

    const catMap = new Map<string, MonthlyComparisonCategoryItem>();

    for (const item of currentCatRes.items) {
      const key = item.category_id ?? '__uncategorized__';
      catMap.set(key, {
        category_id: item.category_id,
        name: item.name,
        current: item.amount,
        previous: 0,
        delta: item.amount,
      });
    }

    for (const item of prevCatRes.items) {
      const key = item.category_id ?? '__uncategorized__';
      const existing = catMap.get(key);
      if (existing) {
        existing.previous = item.amount;
        existing.delta = existing.current - item.amount;
      } else {
        catMap.set(key, {
          category_id: item.category_id,
          name: item.name,
          current: 0,
          previous: item.amount,
          delta: 0 - item.amount,
        });
      }
    }

    const categories = Array.from(catMap.values());
    categories.sort((a, b) => {
      if (b.current !== a.current) {
        return b.current - a.current;
      }
      return a.name.localeCompare(b.name);
    });

    return {
      month: targetMonth,
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

  async streamTransactionsCsv(
    userId: string,
    query: ExportTransactionsCsvQueryDto,
    write: (chunk: string) => void,
  ): Promise<void> {
    const accounts = await this.prisma.account.findMany({
      where: { user_id: userId },
      select: { id: true, name: true },
    });
    const accountMap = new Map(accounts.map((a) => [a.id, a.name]));

    write(`${CSV_BOM}${CSV_HEADER}\r\n`);

    let cursor: string | null = null;
    do {
      const page = await this.transactionsService.list(userId, {
        ...query,
        cursor: cursor ?? undefined,
        limit: 200,
      });

      if (page.items && page.items.length > 0) {
        const rows = page.items
          .map((item) => transactionToCsvRow(item, accountMap))
          .join('\r\n');
        write(`${rows}\r\n`);
      }

      cursor = page.next_cursor;
    } while (cursor);
  }

  async buildPdf(userId: string, filter?: ReportFilter): Promise<Buffer> {
    const { from, to } = await this.dashboardService.resolveRange(
      userId,
      filter?.from,
      filter?.to,
    );

    const pref = await this.prisma.userPreference.findFirst({
      where: { user_id: userId },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const now = new Date();
    const printedAt = new Intl.DateTimeFormat('id-ID', {
      timeZone: tz,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(now);

    let accountNames = 'Semua akun';
    if (filter?.account_id && filter.account_id.length > 0) {
      const accounts = await this.prisma.account.findMany({
        where: { user_id: userId, id: { in: filter.account_id } },
        select: { name: true },
      });
      if (accounts.length > 0) {
        accountNames = accounts.map((a) => a.name).join(', ');
      }
    }

    let categoryNames = 'Semua kategori';
    if (filter?.category_id && filter.category_id.length > 0) {
      const categories = await this.prisma.category.findMany({
        where: {
          id: { in: filter.category_id },
          user_id: userId,
        },
        select: { name: true },
      });
      if (categories.length > 0) {
        categoryNames = categories.map((c) => c.name).join(', ');
      }
    }

    const summary = await this.dashboardService.getSummary(userId, filter);
    const categoryBreakdown = await this.dashboardService.getCategoryBreakdown(
      userId,
      filter,
    );

    const startDate = new Date(`${from}T00:00:00.000Z`);
    const [toYearStr, toMonthStr, toDayStr] = to.split('-');
    const toYear = parseInt(toYearStr, 10);
    const toMonth = parseInt(toMonthStr, 10);
    const toDay = parseInt(toDayStr, 10);
    const nextDayDate = new Date(Date.UTC(toYear, toMonth - 1, toDay + 1));

    const where: any = {
      user_id: userId,
      status: 'POSTED',
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

    if (filter?.category_id && filter.category_id.length > 0) {
      const catConditions = [
        { category_id: { in: filter.category_id } },
        { splits: { some: { category_id: { in: filter.category_id } } } },
      ];
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: catConditions }];
        delete where.OR;
      } else {
        where.OR = catConditions;
      }
    }

    const totalTransactionsCount = await this.prisma.transaction.count({
      where,
    });

    // shortcut: batas 2000 baris di PDF, pindah ke job async bila user butuh PDF penuh
    const maxRows = 2000;
    const txRecords = await this.prisma.transaction.findMany({
      where,
      select: {
        id: true,
        date: true,
        type: true,
        amount: true,
        note: true,
        reason: true,
        account: {
          select: { name: true },
        },
        to_account: {
          select: { name: true },
        },
        category: {
          select: { name: true },
        },
        splits: {
          select: {
            amount: true,
            category: {
              select: { name: true },
            },
          },
        },
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: maxRows,
    });

    const transactions = txRecords.map((tx) => {
      let accountName = tx.account?.name ?? '-';
      if (tx.type === 'TRANSFER' && tx.to_account?.name) {
        accountName = `${tx.account?.name ?? '-'} → ${tx.to_account.name}`;
      }

      let categoryName = tx.category?.name ?? '-';
      if (!tx.category && tx.splits && tx.splits.length > 0) {
        const splitNames = tx.splits
          .map((s) => s.category?.name)
          .filter(Boolean);
        categoryName = splitNames.length > 0 ? splitNames.join(', ') : 'Split';
      }

      return {
        date: tx.date,
        type: tx.type,
        account_name: accountName,
        category_name: categoryName,
        notes: tx.note || tx.reason || '-',
        amount: Number(tx.amount),
      };
    });

    const reportData: PdfReportData = {
      from,
      to,
      accountNames,
      categoryNames,
      printedAt,
      summary: {
        income: summary.income,
        expense: summary.expense,
        net: summary.net,
        adjustment_net: summary.adjustment_net,
        transfer_total: summary.transfer_total,
      },
      categories: categoryBreakdown.items.map((item) => ({
        name: item.name,
        amount: item.amount,
        percent_bp: item.percent_bp,
      })),
      transactions,
      totalTransactionsCount,
    };

    const html = renderReportHtml(reportData);

    // shortcut: launch Chromium per request, ganti ke browser pool bila export > 1 req/detik
    const args: string[] = [];
    if (process.env.PUPPETEER_NO_SANDBOX === 'true') {
      args.push('--no-sandbox');
    }

    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args,
        timeout: 30000,
      });

      const page = await browser.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        void req.abort();
      });

      await page.setContent(html, {
        waitUntil: 'load',
        timeout: 30000,
      });

      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        timeout: 30000,
      });

      return Buffer.from(pdf);
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        throw err;
      }
      this.logger.error('Error generating PDF report', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new HttpException(
        {
          code: 'PDF_GENERATION_FAILED',
          message: 'Gagal membuat PDF, coba lagi atau gunakan ekspor CSV',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    } finally {
      if (browser) {
        await browser.close().catch((closeErr) => {
          this.logger.error('Failed to close browser', {
            error: String(closeErr),
          });
        });
      }
    }
  }
}
