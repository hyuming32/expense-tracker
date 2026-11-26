import type { Category, Transaction } from '../db/types';
import { compareTransactionsByDateTimeDesc } from './places';
import type { CategoryBreakdownItem } from './reports';

export const TAG_MAX_LENGTH = 20;
export const MAX_TAGS_PER_TRANSACTION = 5;
export const DEFAULT_RECENT_TAGS_LIMIT = 8;

export interface TagDateRange {
  start: string;
  end: string;
}

export interface TagSummary {
  tag: string;
  expenseTotal: number;
  incomeTotal: number;
  count: number;
  dateRange: TagDateRange | null;
  categoryBreakdown: CategoryBreakdownItem[];
}

export interface TagOverviewItem {
  tag: string;
  expenseTotal: number;
  incomeTotal: number;
  count: number;
  lastDate: string;
}

/**
 * 正規化單一標籤：全形空白轉半形、去前後空白、移除開頭 #，限制最長 20 字，空字串回傳 null。
 */
export function normalizeTag(raw: string): string | null {
  const halfSpace = raw.replace(/\u3000/g, ' ').trim();
  const stripped = halfSpace.replace(/^[#＃]+/, '').trim();
  if (!stripped) {
    return null;
  }
  const truncated = stripped.slice(0, TAG_MAX_LENGTH).trim();
  return truncated.length > 0 ? truncated : null;
}

/**
 * 正規化標籤清單：過濾無效值、不分大小寫去重（保留第一次出現的寫法），最多保留 5 個。
 */
export function normalizeTags(rawTags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawTags) {
    const normalized = normalizeTag(raw);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= MAX_TAGS_PER_TRANSACTION) {
      break;
    }
  }

  return result;
}

/**
 * 依交易時間由新到舊蒐集最近使用過的標籤（排除已刪除交易，不分大小寫去重）。
 */
export function collectRecentTags(
  transactions: readonly Transaction[],
  limit = DEFAULT_RECENT_TAGS_LIMIT,
): string[] {
  const maxCount = Math.max(0, Math.trunc(limit));
  if (maxCount === 0) {
    return [];
  }

  const sorted = transactions
    .filter((tx) => !tx.deleted && Array.isArray(tx.tags) && tx.tags.length > 0)
    .sort(compareTransactionsByDateTimeDesc);

  const seen = new Set<string>();
  const result: string[] = [];

  for (const tx of sorted) {
    for (const rawTag of tx.tags ?? []) {
      const normalized = normalizeTag(rawTag);
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(normalized);
      if (result.length >= maxCount) {
        return result;
      }
    }
  }

  return result;
}

/**
 * 統計指定標籤在全部未刪除交易中的支出合計、收入合計、筆數、日期範圍與支出主分類分布。
 */
export function summarizeByTag(
  transactions: readonly Transaction[],
  tag: string,
  categories: readonly Category[],
): TagSummary {
  const target = normalizeTag(tag);
  if (!target) {
    return {
      tag: '',
      expenseTotal: 0,
      incomeTotal: 0,
      count: 0,
      dateRange: null,
      categoryBreakdown: [],
    };
  }

  const targetKey = target.toLowerCase();
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const categoryTotals = new Map<string, { categoryId: string; name: string; icon: string; amount: number }>();

  let expenseTotal = 0;
  let incomeTotal = 0;
  let count = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const tx of transactions) {
    if (tx.deleted || !Array.isArray(tx.tags) || tx.tags.length === 0) {
      continue;
    }

    const hasTag = tx.tags.some((t) => {
      const norm = normalizeTag(t);
      return norm !== null && norm.toLowerCase() === targetKey;
    });
    if (!hasTag) {
      continue;
    }

    count += 1;
    if (minDate === null || tx.date < minDate) {
      minDate = tx.date;
    }
    if (maxDate === null || tx.date > maxDate) {
      maxDate = tx.date;
    }

    if (tx.kind === 'expense') {
      expenseTotal += tx.amount;

      const category = tx.categoryId ? categoryMap.get(tx.categoryId) : undefined;
      const parent = category?.parentId ? categoryMap.get(category.parentId) : undefined;
      const topCategory = parent ?? category;

      const key = topCategory?.id ?? 'uncategorized';
      const name = topCategory?.name ?? '未分類';
      const icon = topCategory?.icon ?? '📝';

      const existing = categoryTotals.get(key);
      if (existing) {
        existing.amount += tx.amount;
      } else {
        categoryTotals.set(key, { categoryId: key, name, icon, amount: tx.amount });
      }
    } else if (tx.kind === 'income') {
      incomeTotal += tx.amount;
    }
  }

  const categoryBreakdown: CategoryBreakdownItem[] = Array.from(categoryTotals.values())
    .sort((a, b) => b.amount - a.amount)
    .map((item) => ({
      ...item,
      percentage: expenseTotal > 0 ? Math.round((item.amount / expenseTotal) * 1000) / 10 : 0,
    }));

  return {
    tag: target,
    expenseTotal,
    incomeTotal,
    count,
    dateRange: minDate && maxDate ? { start: minDate, end: maxDate } : null,
    categoryBreakdown,
  };
}

/**
 * 彙整所有未刪除交易中的標籤總支出、總收入與筆數（依總支出由高到低排序）。
 */
export function summarizeAllTags(transactions: readonly Transaction[]): TagOverviewItem[] {
  const buckets = new Map<string, TagOverviewItem>();

  for (const tx of transactions) {
    if (tx.deleted || !Array.isArray(tx.tags) || tx.tags.length === 0) {
      continue;
    }

    const seenInTx = new Set<string>();
    for (const rawTag of tx.tags) {
      const normalized = normalizeTag(rawTag);
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seenInTx.has(key)) {
        continue;
      }
      seenInTx.add(key);

      let item = buckets.get(key);
      if (!item) {
        item = {
          tag: normalized,
          expenseTotal: 0,
          incomeTotal: 0,
          count: 0,
          lastDate: tx.date,
        };
        buckets.set(key, item);
      }

      item.count += 1;
      if (tx.date > item.lastDate) {
        item.lastDate = tx.date;
      }
      if (tx.kind === 'expense') {
        item.expenseTotal += tx.amount;
      } else if (tx.kind === 'income') {
        item.incomeTotal += tx.amount;
      }
    }
  }

  return Array.from(buckets.values()).sort((a, b) => {
    if (b.expenseTotal !== a.expenseTotal) {
      return b.expenseTotal - a.expenseTotal;
    }
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return b.lastDate.localeCompare(a.lastDate);
  });
}
