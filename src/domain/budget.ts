import type { Budget, Category, Transaction } from '../db/types';
import { daysInMonth } from './recurring';

export type BudgetAlertLevel = 'normal' | 'warning' | 'over';

export interface BudgetStatusItem {
  categoryId: string | null;
  budget: number;
  spent: number;
  remaining: number;
  daysLeft: number;
  perDay: number;
  ratio: number;
  status: BudgetAlertLevel;
  statusLabel: '正常' | '快用完' | '已超支';
}

export interface CategoryBudgetStatusItem extends BudgetStatusItem {
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
}

export interface BudgetStatusResult {
  month: string;
  daysLeft: number;
  total: BudgetStatusItem | null;
  categories: CategoryBudgetStatusItem[];
}

/**
 * 依據已用比例判定預算狀態：ratio < 0.8 正常、0.8–1 快用完、> 1 已超支。
 */
export function getBudgetAlertLevel(ratio: number): {
  status: BudgetAlertLevel;
  statusLabel: '正常' | '快用完' | '已超支';
} {
  if (ratio > 1) {
    return { status: 'over', statusLabel: '已超支' };
  }
  if (ratio >= 0.8) {
    return { status: 'warning', statusLabel: '快用完' };
  }
  return { status: 'normal', statusLabel: '正常' };
}

function computeDaysLeftInMonth(today: string): number {
  const [yearStr, monthStr, dayStr] = today.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return 1;
  }
  const totalDays = daysInMonth(year, month);
  return Math.max(1, totalDays - day + 1);
}

function buildStatusItem(
  categoryId: string | null,
  budget: number,
  spent: number,
  daysLeft: number,
): BudgetStatusItem {
  const remaining = budget - spent;
  const perDay = remaining > 0 ? Math.floor(remaining / daysLeft) : 0;
  const ratio = budget > 0 ? spent / budget : 0;
  const { status, statusLabel } = getBudgetAlertLevel(ratio);
  return {
    categoryId,
    budget,
    spent,
    remaining,
    daysLeft,
    perDay,
    ratio,
    status,
    statusLabel,
  };
}

/**
 * 計算指定日期（today: YYYY-MM-DD）所屬月份的總預算與各分類預算執行狀況。
 * 僅計入未刪除且 kind === 'expense' 的當月交易；子分類支出會併入所屬主分類。
 */
export function computeBudgetStatus(
  budgets: readonly Budget[],
  transactions: readonly Transaction[],
  categories: readonly Category[],
  today: string,
): BudgetStatusResult {
  const month = today.slice(0, 7);
  const daysLeft = computeDaysLeftInMonth(today);

  const categoryMap = new Map<string, Category>();
  for (const cat of categories) {
    categoryMap.set(cat.id, cat);
  }

  let totalSpent = 0;
  const spentByRootCategory = new Map<string, number>();

  for (const tx of transactions) {
    if (tx.deleted || tx.kind !== 'expense' || !tx.date.startsWith(month)) {
      continue;
    }
    totalSpent += tx.amount;

    if (tx.categoryId) {
      const cat = categoryMap.get(tx.categoryId);
      const rootId = cat?.parentId ? cat.parentId : tx.categoryId;
      spentByRootCategory.set(rootId, (spentByRootCategory.get(rootId) ?? 0) + tx.amount);
    }
  }

  const activeBudgets = budgets.filter((b) => !b.deleted && b.amount > 0);
  const totalBudgetRecord = activeBudgets.find((b) => b.categoryId === null);
  const total = totalBudgetRecord
    ? buildStatusItem(null, totalBudgetRecord.amount, totalSpent, daysLeft)
    : null;

  const categoryStatuses: CategoryBudgetStatusItem[] = [];
  for (const b of activeBudgets) {
    if (b.categoryId === null) {
      continue;
    }
    const cat = categoryMap.get(b.categoryId);
    const spent = spentByRootCategory.get(b.categoryId) ?? 0;
    const base = buildStatusItem(b.categoryId, b.amount, spent, daysLeft);
    categoryStatuses.push({
      ...base,
      categoryId: b.categoryId,
      categoryName: cat?.name ?? '未分類',
      categoryIcon: cat?.icon ?? '📦',
    });
  }

  categoryStatuses.sort((a, b) => b.ratio - a.ratio);

  return {
    month,
    daysLeft,
    total,
    categories: categoryStatuses,
  };
}
