import { z } from 'zod';

const emptyToUndefined = (val: unknown) => (val === '' ? undefined : val);

export const monthlyComparisonQuerySchema = z.object({
  month: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'Format bulan harus YYYY-MM')
      .optional(),
  ),
});

export type MonthlyComparisonQueryDto = z.infer<typeof monthlyComparisonQuerySchema>;

export interface BalanceChangeItem {
  account_id: string;
  name: string;
  type: string;
  opening: number;
  inflow: number;
  outflow: number;
  closing: number;
}

export interface BalanceChangesResponse {
  from: string;
  to: string;
  items: BalanceChangeItem[];
  totals: {
    opening: number;
    inflow: number;
    outflow: number;
    closing: number;
  };
}

export interface MonthlyComparisonCategoryItem {
  category_id: string | null;
  name: string;
  current: number;
  previous: number;
  delta: number;
}

export interface MonthlyComparisonResponse {
  month: string;
  previous_month: string;
  current: {
    income: number;
    expense: number;
    net: number;
    adjustment_net: number;
  };
  previous: {
    income: number;
    expense: number;
    net: number;
    adjustment_net: number;
  };
  delta: {
    income: number;
    expense: number;
    net: number;
  };
  delta_bp: {
    income: number | null;
    expense: number | null;
    net: number | null;
  };
  categories: MonthlyComparisonCategoryItem[];
}
