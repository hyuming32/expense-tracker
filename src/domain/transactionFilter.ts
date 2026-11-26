import type { Account, Category, Place, Transaction, TransactionKind } from '../db/types';

export type TransactionFilterRange =
  | { kind: 'month'; month: string }
  | { kind: 'all' }
  | { kind: 'custom'; from: string; to: string };

export type InvoiceFilterOption = 'any' | 'with' | 'without';

export interface TransactionFilterCriteria {
  range: TransactionFilterRange;
  keyword?: string;
  kinds?: readonly TransactionKind[];
  minAmount?: number | null;
  maxAmount?: number | null;
  categoryId?: string;
  accountId?: string;
  placeId?: string;
  tag?: string;
  invoice?: InvoiceFilterOption;
}

export interface TransactionFilterContext {
  categoryMap: ReadonlyMap<string, Category>;
  accountMap: ReadonlyMap<string, Account>;
  placeMap: ReadonlyMap<string, Place>;
}

export interface FilteredSummary {
  expenseTotal: number;
  incomeTotal: number;
  count: number;
}

/**
 * 判斷日期字串（YYYY-MM-DD）是否符合指定的期間條件。
 */
function matchesRange(date: string, range: TransactionFilterRange): boolean {
  if (range.kind === 'all') {
    return true;
  }
  if (range.kind === 'month') {
    return date.startsWith(range.month);
  }
  if (range.from && date < range.from) {
    return false;
  }
  if (range.to && date > range.to) {
    return false;
  }
  return true;
}

/**
 * 判斷交易是否符合關鍵字條件：
 * - `#開頭`：僅比對標籤
 * - 一般關鍵字：比對備註、標籤、分類名稱、地點名稱、帳戶名稱（含轉入帳戶）、發票號碼
 * - 若為純數字（可含逗號）：同時比對金額完全相等
 */
function matchesKeyword(
  tx: Transaction,
  rawKeyword: string,
  ctx: TransactionFilterContext,
): boolean {
  const keyword = rawKeyword.trim().toLowerCase();
  if (!keyword) {
    return true;
  }

  const txTags = tx.tags ?? [];
  if (keyword.startsWith('#')) {
    const tagKeyword = keyword.slice(1).trim();
    return tagKeyword
      ? txTags.some((t) => t.toLowerCase().includes(tagKeyword))
      : txTags.length > 0;
  }

  if ((tx.note ?? '').toLowerCase().includes(keyword)) {
    return true;
  }
  if (txTags.some((t) => t.toLowerCase().includes(keyword))) {
    return true;
  }
  if (tx.categoryId) {
    const category = ctx.categoryMap.get(tx.categoryId);
    const categoryName = category?.name ?? '';
    if (categoryName.toLowerCase().includes(keyword)) {
      return true;
    }
    if (category?.parentId) {
      const parentName = ctx.categoryMap.get(category.parentId)?.name ?? '';
      if (parentName.toLowerCase().includes(keyword)) {
        return true;
      }
    }
  }
  if (tx.placeId) {
    const placeName = ctx.placeMap.get(tx.placeId)?.name ?? '';
    if (placeName.toLowerCase().includes(keyword)) {
      return true;
    }
  }
  const accountName = ctx.accountMap.get(tx.accountId)?.name ?? '';
  if (accountName.toLowerCase().includes(keyword)) {
    return true;
  }
  if (tx.toAccountId) {
    const toAccountName = ctx.accountMap.get(tx.toAccountId)?.name ?? '';
    if (toAccountName.toLowerCase().includes(keyword)) {
      return true;
    }
  }
  if ((tx.invoiceNo ?? '').toLowerCase().includes(keyword)) {
    return true;
  }

  if (/^\d[\d,]*$/.test(keyword)) {
    const numericAmount = Number(keyword.replace(/,/g, ''));
    if (Number.isFinite(numericAmount) && tx.amount === numericAmount) {
      return true;
    }
  }

  return false;
}

/**
 * 依多重條件篩選交易紀錄，一律排除已刪除項目。
 */
export function filterTransactions(
  transactions: readonly Transaction[],
  criteria: TransactionFilterCriteria,
  ctx: TransactionFilterContext,
): Transaction[] {
  const kinds = criteria.kinds ?? [];
  const hasMinAmount =
    criteria.minAmount !== undefined &&
    criteria.minAmount !== null &&
    !Number.isNaN(criteria.minAmount);
  const hasMaxAmount =
    criteria.maxAmount !== undefined &&
    criteria.maxAmount !== null &&
    !Number.isNaN(criteria.maxAmount);
  const targetTag = criteria.tag ? criteria.tag.toLowerCase() : '';
  const invoiceOption = criteria.invoice ?? 'any';

  return transactions.filter((tx) => {
    if (tx.deleted) {
      return false;
    }
    if (!matchesRange(tx.date, criteria.range)) {
      return false;
    }
    if (criteria.keyword && !matchesKeyword(tx, criteria.keyword, ctx)) {
      return false;
    }
    if (kinds.length > 0 && !kinds.includes(tx.kind)) {
      return false;
    }
    if (hasMinAmount && tx.amount < (criteria.minAmount as number)) {
      return false;
    }
    if (hasMaxAmount && tx.amount > (criteria.maxAmount as number)) {
      return false;
    }
    if (criteria.categoryId) {
      const txCat = tx.categoryId ? ctx.categoryMap.get(tx.categoryId) : undefined;
      const matchesCat =
        tx.categoryId === criteria.categoryId || txCat?.parentId === criteria.categoryId;
      if (!matchesCat) {
        return false;
      }
    }
    if (criteria.accountId) {
      const matchesAcc =
        tx.accountId === criteria.accountId || tx.toAccountId === criteria.accountId;
      if (!matchesAcc) {
        return false;
      }
    }
    if (criteria.placeId && tx.placeId !== criteria.placeId) {
      return false;
    }
    if (targetTag && !(tx.tags ?? []).some((t) => t.toLowerCase() === targetTag)) {
      return false;
    }
    if (invoiceOption === 'with') {
      if (!tx.invoiceNo || !tx.invoiceNo.trim()) {
        return false;
      }
    } else if (invoiceOption === 'without') {
      if (tx.invoiceNo && tx.invoiceNo.trim()) {
        return false;
      }
    }
    return true;
  });
}

/**
 * 計算篩選結果的支出合計、收入合計與總筆數（排除已刪除，轉帳不計入收支合計但計入筆數）。
 */
export function summarizeFiltered(list: readonly Transaction[]): FilteredSummary {
  let expenseTotal = 0;
  let incomeTotal = 0;
  let count = 0;

  for (const tx of list) {
    if (tx.deleted) {
      continue;
    }
    count += 1;
    if (tx.kind === 'expense') {
      expenseTotal += tx.amount;
    } else if (tx.kind === 'income') {
      incomeTotal += tx.amount;
    }
  }

  return {
    expenseTotal,
    incomeTotal,
    count,
  };
}
