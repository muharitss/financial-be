import { z } from 'zod';

const emptyToUndefined = (val: unknown) => (val === '' ? undefined : val);

const toArrayHelper = (val: unknown): string[] | undefined => {
  if (val === undefined || val === null || val === '') return undefined;
  if (Array.isArray(val)) {
    return val.flatMap((v) =>
      typeof v === 'string'
        ? v.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
    );
  }
  if (typeof val === 'string') {
    return val.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
};

export const dateRangeSchema = z
  .object({
    from: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    to: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  })
  .refine(
    (data) => {
      if (data.from && data.to) {
        return data.from <= data.to;
      }
      return true;
    },
    {
      message: 'Tanggal awal (from) tidak boleh lebih besar dari tanggal akhir (to)',
      path: ['from'],
    },
  );

export type DateRangeDto = z.infer<typeof dateRangeSchema>;

export const reportFilterSchema = z
  .object({
    from: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    to: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    account_id: z.preprocess(
      toArrayHelper,
      z.array(z.string().uuid()).optional(),
    ),
    category_id: z.preprocess(
      toArrayHelper,
      z.array(z.string().uuid()).optional(),
    ),
  })
  .refine(
    (data) => {
      if (data.from && data.to) {
        return data.from <= data.to;
      }
      return true;
    },
    {
      message: 'Tanggal awal (from) tidak boleh lebih besar dari tanggal akhir (to)',
      path: ['from'],
    },
  );

export type ReportFilter = z.infer<typeof reportFilterSchema>;

export const cashFlowQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(12).default(6),
});

export type CashFlowQueryDto = z.infer<typeof cashFlowQuerySchema>;

export interface DashboardSummaryResponse {
  from: string;
  to: string;
  income: number;
  expense: number;
  net: number;
  adjustment_net: number;
  transfer_total: number;
}

export interface CashFlowItem {
  month: string;
  income: number;
  expense: number;
  net: number;
}

export interface DashboardCashFlowResponse {
  items: CashFlowItem[];
}

export interface CategoryBreakdownItem {
  category_id: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  archived: boolean;
  amount: number;
  percent_bp: number;
}

export interface DashboardCategoryBreakdownResponse {
  from: string;
  to: string;
  total: number;
  items: CategoryBreakdownItem[];
}

export interface BalanceTrendPoint {
  date: string;
  ledger_balance: number;
}

export interface DashboardBalanceTrendResponse {
  from: string;
  to: string;
  granularity: 'day' | 'month';
  points: BalanceTrendPoint[];
}

