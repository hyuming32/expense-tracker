import type { Category, Transaction } from '../db/types';
import { shiftMonth } from './format';

export interface CategoryBreakdownItem {
  categoryId: string;
  name: string;
  icon: string;
  amount: number;
  percentage: number;
}

export interface MonthlyTrendItem {
  month: string;
  income: number;
  expense: number;
}

/**
 * 依第一層分類彙總指定月份（YYYY-MM）的支出（子分類併入父分類，排除轉帳與已刪除）。
 */
export function categoryBreakdown(
  transactions: readonly Transaction[],
  categories: readonly Category[],
  month: string,
): CategoryBreakdownItem[] {
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const totals = new Map<string, { categoryId: string; name: string; icon: string; amount: number }>();
  let totalExpense = 0;

  for (const tx of transactions) {
    if (tx.deleted || tx.kind !== 'expense' || !tx.date.startsWith(month)) {
      continue;
    }

    const category = tx.categoryId ? categoryMap.get(tx.categoryId) : undefined;
    const parent = category?.parentId ? categoryMap.get(category.parentId) : undefined;
    const topCategory = parent ?? category;

    const key = topCategory?.id ?? 'uncategorized';
    const name = topCategory?.name ?? '未分類';
    const icon = topCategory?.icon ?? '📝';

    const existing = totals.get(key);
    if (existing) {
      existing.amount += tx.amount;
    } else {
      totals.set(key, { categoryId: key, name, icon, amount: tx.amount });
    }
    totalExpense += tx.amount;
  }

  return Array.from(totals.values())
    .map((item) => ({
      ...item,
      percentage: totalExpense > 0 ? Math.round((item.amount / totalExpense) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * 計算包含 endMonth 在內往前推算共 months 個月的每月收支趨勢（無資料月份補 0，排除轉帳與已刪除）。
 */
export function monthlyTrend(
  transactions: readonly Transaction[],
  endMonth: string,
  months = 12,
): MonthlyTrendItem[] {
  const count = Math.max(0, Math.trunc(months));
  const result: MonthlyTrendItem[] = [];
  const monthMap = new Map<string, MonthlyTrendItem>();

  for (let i = count - 1; i >= 0; i -= 1) {
    const month = shiftMonth(endMonth, -i);
    const entry: MonthlyTrendItem = { month, income: 0, expense: 0 };
    result.push(entry);
    monthMap.set(month, entry);
  }

  for (const tx of transactions) {
    if (tx.deleted || tx.kind === 'transfer') {
      continue;
    }
    const txMonth = tx.date.slice(0, 7);
    const entry = monthMap.get(txMonth);
    if (!entry) {
      continue;
    }
    if (tx.kind === 'income') {
      entry.income += tx.amount;
    } else if (tx.kind === 'expense') {
      entry.expense += tx.amount;
    }
  }

  return result;
}
