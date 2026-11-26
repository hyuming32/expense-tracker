import type { Category, Place, Transaction } from '../db/types';
import { shiftMonth } from './format';

export type PeriodKind = 'month' | 'quarter' | 'year';

export interface PeriodRange {
  kind: PeriodKind;
  start: string;
  end: string;
  label: string;
}

export interface PeriodSummaryResult {
  income: number;
  expense: number;
  net: number;
}

export interface CompareResult {
  diff: number;
  pct: number | null;
}

export interface ClippedPeriodPair {
  range: PeriodRange;
  compareRange: PeriodRange;
  isInProgress: boolean;
}

export interface CategoryCompareSubItem {
  categoryId: string;
  name: string;
  icon: string;
  current: number;
  previous: number;
  diff: number;
  pct: number | null;
}

export interface CategoryCompareItem {
  categoryId: string;
  name: string;
  icon: string;
  current: number;
  previous: number;
  diff: number;
  pct: number | null;
  children: CategoryCompareSubItem[];
}

export interface PeriodTrendItem {
  key: string;
  shortLabel: string;
  label: string;
  income: number;
  expense: number;
  lastYearExpense: number;
}

export interface CategoryBreakdownItem {
  categoryId: string;
  name: string;
  icon: string;
  amount: number;
  percentage: number;
}

export interface PlaceBreakdownItem {
  placeId: string;
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

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function parseYmd(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    year: y || 2026,
    month: m || 1,
    day: d || 1,
  };
}

function formatYmd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function diffDaysInclusiveOffset(startStr: string, endStr: string): number {
  const s = parseYmd(startStr);
  const e = parseYmd(endStr);
  const sUtc = Date.UTC(s.year, s.month - 1, s.day);
  const eUtc = Date.UTC(e.year, e.month - 1, e.day);
  return Math.max(0, Math.round((eUtc - sUtc) / 86400000));
}

function addDays(dateStr: string, days: number): string {
  const { year, month, day } = parseYmd(dateStr);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * 依期間類型與基準日期計算該期間的起訖日期與顯示標題（季為自然季）。
 */
export function periodRange(kind: PeriodKind, anchor: string): PeriodRange {
  const { year, month } = parseYmd(anchor);

  if (kind === 'month') {
    const start = formatYmd(year, month, 1);
    const end = formatYmd(year, month, daysInMonth(year, month));
    return {
      kind,
      start,
      end,
      label: `${year} 年 ${month} 月`,
    };
  }

  if (kind === 'quarter') {
    const quarter = Math.floor((month - 1) / 3) + 1;
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = quarter * 3;
    const start = formatYmd(year, startMonth, 1);
    const end = formatYmd(year, endMonth, daysInMonth(year, endMonth));
    return {
      kind,
      start,
      end,
      label: `${year} 年 第 ${quarter} 季（${startMonth}–${endMonth} 月）`,
    };
  }

  return {
    kind: 'year',
    start: formatYmd(year, 1, 1),
    end: formatYmd(year, 12, 31),
    label: `${year} 年`,
  };
}

/**
 * 將期間往前或往後移動 delta 期（例如 -1 為上一期，+1 為下一期）。
 */
export function shiftPeriod(range: PeriodRange, delta: number): PeriodRange {
  const { year, month } = parseYmd(range.start);

  if (range.kind === 'month') {
    const shifted = new Date(year, month - 1 + delta, 1);
    return periodRange('month', formatYmd(shifted.getFullYear(), shifted.getMonth() + 1, 1));
  }

  if (range.kind === 'quarter') {
    const shifted = new Date(year, month - 1 + delta * 3, 1);
    return periodRange('quarter', formatYmd(shifted.getFullYear(), shifted.getMonth() + 1, 1));
  }

  return periodRange('year', formatYmd(year + delta, 1, 1));
}

/**
 * 取得去年同期的期間範圍（自動處理閏年 2/29 與平年 2/28 差異）。
 */
export function sameLastYear(range: PeriodRange): PeriodRange {
  const { year, month } = parseYmd(range.start);
  return periodRange(range.kind, formatYmd(year - 1, month, 1));
}

/**
 * 若目前期間仍在進行中（today 落於期間內），將本期與比較期裁切為相同已過天數；
 * 若比較期總天數較短（例如 3/31 對 2/28），以較短者為準。
 */
export function clipToElapsed(
  range: PeriodRange,
  compareRange: PeriodRange,
  today: string,
): ClippedPeriodPair {
  if (today < range.start || today > range.end) {
    return { range, compareRange, isInProgress: false };
  }

  const elapsedOffset = diffDaysInclusiveOffset(range.start, today);
  const targetCompareEnd = addDays(compareRange.start, elapsedOffset);
  const clippedCompareEnd =
    targetCompareEnd < compareRange.end ? targetCompareEnd : compareRange.end;

  return {
    range: { ...range, end: today },
    compareRange: { ...compareRange, end: clippedCompareEnd },
    isInProgress: true,
  };
}

/**
 * 計算指定期間內的收入、支出與結餘（排除轉帳與已刪除紀錄）。
 */
export function periodSummary(
  transactions: readonly Transaction[],
  range: Pick<PeriodRange, 'start' | 'end'>,
): PeriodSummaryResult {
  let income = 0;
  let expense = 0;

  for (const tx of transactions) {
    if (tx.deleted || tx.kind === 'transfer') {
      continue;
    }
    if (tx.date < range.start || tx.date > range.end) {
      continue;
    }
    if (tx.kind === 'income') {
      income += tx.amount;
    } else if (tx.kind === 'expense') {
      expense += tx.amount;
    }
  }

  return {
    income,
    expense,
    net: income - expense,
  };
}

/**
 * 比較本期與比較期數值，回傳增減金額與百分比；比較期為 0 時百分比為 null。
 */
export function compareSummary(current: number, previous: number): CompareResult {
  const diff = current - previous;
  if (previous === 0) {
    return { diff, pct: null };
  }
  const pct = Math.round((diff / Math.abs(previous)) * 1000) / 10;
  return { diff, pct };
}

/**
 * 依第一層分類彙總指定期間的支出（子分類併入父分類，排除轉帳與已刪除）。
 */
export function categoryBreakdownInRange(
  transactions: readonly Transaction[],
  categories: readonly Category[],
  range: Pick<PeriodRange, 'start' | 'end'>,
): CategoryBreakdownItem[] {
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const totals = new Map<string, { categoryId: string; name: string; icon: string; amount: number }>();
  let totalExpense = 0;

  for (const tx of transactions) {
    if (
      tx.deleted ||
      tx.kind !== 'expense' ||
      tx.date < range.start ||
      tx.date > range.end
    ) {
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
 * 依第一層分類彙總指定月份（YYYY-MM）的支出（子分類併入父分類，排除轉帳與已刪除）。
 */
export function categoryBreakdown(
  transactions: readonly Transaction[],
  categories: readonly Category[],
  month: string,
): CategoryBreakdownItem[] {
  const range = periodRange('month', `${month}-01`);
  return categoryBreakdownInRange(transactions, categories, range);
}

/**
 * 依地點彙總指定期間的支出（排除轉帳與已刪除）。
 * 有指定地點的項目依金額由大到小取前 limit 名（預設 10 名）；
 * 「未指定地點」若存在則固定排在所有有指定地點的項目之後，且不佔前 limit 名名額。
 */
export function placeBreakdownInRange(
  transactions: readonly Transaction[],
  places: readonly Place[],
  range: Pick<PeriodRange, 'start' | 'end'>,
  limit = 10,
): PlaceBreakdownItem[] {
  const placeMap = new Map(places.map((p) => [p.id, p]));
  const totals = new Map<string, { placeId: string; name: string; icon: string; amount: number }>();
  let totalExpense = 0;

  for (const tx of transactions) {
    if (
      tx.deleted ||
      tx.kind !== 'expense' ||
      tx.date < range.start ||
      tx.date > range.end
    ) {
      continue;
    }

    const place = tx.placeId ? placeMap.get(tx.placeId) : undefined;
    const key = place?.id ?? 'unspecified';
    const name = place?.name ?? '未指定地點';
    const icon = place?.icon ?? '📍';

    const existing = totals.get(key);
    if (existing) {
      existing.amount += tx.amount;
    } else {
      totals.set(key, { placeId: key, name, icon, amount: tx.amount });
    }
    totalExpense += tx.amount;
  }

  const unspecified = totals.get('unspecified');
  const specified = Array.from(totals.values())
    .filter((item) => item.placeId !== 'unspecified')
    .sort((a, b) => b.amount - a.amount)
    .slice(0, Math.max(0, Math.trunc(limit)));

  const ordered = unspecified ? [...specified, unspecified] : specified;

  return ordered.map((item) => ({
    ...item,
    percentage: totalExpense > 0 ? Math.round((item.amount / totalExpense) * 1000) / 10 : 0,
  }));
}

/**
 * 依第一層分類比較本期與比較期的支出變化（含子分類明細，依增減金額絕對值由大到小排序，排除轉帳與已刪除）。
 */
export function categoryCompare(
  transactions: readonly Transaction[],
  categories: readonly Category[],
  range: Pick<PeriodRange, 'start' | 'end'>,
  compareRange: Pick<PeriodRange, 'start' | 'end'>,
): CategoryCompareItem[] {
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  interface MutableBucket {
    categoryId: string;
    name: string;
    icon: string;
    current: number;
    previous: number;
    children: Map<
      string,
      { categoryId: string; name: string; icon: string; current: number; previous: number }
    >;
  }

  const buckets = new Map<string, MutableBucket>();

  function addTxAmount(tx: Transaction, field: 'current' | 'previous'): void {
    const category = tx.categoryId ? categoryMap.get(tx.categoryId) : undefined;
    const parent = category?.parentId ? categoryMap.get(category.parentId) : undefined;
    const topCategory = parent ?? category;
    const subCategory = parent ? category : undefined;

    const topId = topCategory?.id ?? 'uncategorized';
    const topName = topCategory?.name ?? '未分類';
    const topIcon = topCategory?.icon ?? '📝';

    let bucket = buckets.get(topId);
    if (!bucket) {
      bucket = {
        categoryId: topId,
        name: topName,
        icon: topIcon,
        current: 0,
        previous: 0,
        children: new Map(),
      };
      buckets.set(topId, bucket);
    }
    bucket[field] += tx.amount;

    if (subCategory) {
      let sub = bucket.children.get(subCategory.id);
      if (!sub) {
        sub = {
          categoryId: subCategory.id,
          name: subCategory.name,
          icon: subCategory.icon,
          current: 0,
          previous: 0,
        };
        bucket.children.set(subCategory.id, sub);
      }
      sub[field] += tx.amount;
    }
  }

  for (const tx of transactions) {
    if (tx.deleted || tx.kind !== 'expense') {
      continue;
    }
    if (tx.date >= range.start && tx.date <= range.end) {
      addTxAmount(tx, 'current');
    }
    if (tx.date >= compareRange.start && tx.date <= compareRange.end) {
      addTxAmount(tx, 'previous');
    }
  }

  const result: CategoryCompareItem[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.current === 0 && bucket.previous === 0) {
      continue;
    }
    const { diff, pct } = compareSummary(bucket.current, bucket.previous);
    const children: CategoryCompareSubItem[] = Array.from(bucket.children.values())
      .filter((c) => c.current > 0 || c.previous > 0)
      .map((c) => {
        const subCmp = compareSummary(c.current, c.previous);
        return {
          ...c,
          diff: subCmp.diff,
          pct: subCmp.pct,
        };
      })
      .sort((a, b) => {
        const absDiff = Math.abs(b.diff) - Math.abs(a.diff);
        return absDiff !== 0 ? absDiff : b.current - a.current;
      });

    result.push({
      categoryId: bucket.categoryId,
      name: bucket.name,
      icon: bucket.icon,
      current: bucket.current,
      previous: bucket.previous,
      diff,
      pct,
      children,
    });
  }

  return result.sort((a, b) => {
    const absDiff = Math.abs(b.diff) - Math.abs(a.diff);
    return absDiff !== 0 ? absDiff : b.current - a.current;
  });
}

function formatTrendKeyAndShortLabel(range: PeriodRange): { key: string; shortLabel: string } {
  const { year, month } = parseYmd(range.start);
  if (range.kind === 'month') {
    return {
      key: `${year}-${pad2(month)}`,
      shortLabel: `${month}月`,
    };
  }
  if (range.kind === 'quarter') {
    const q = Math.floor((month - 1) / 3) + 1;
    return {
      key: `${year}-Q${q}`,
      shortLabel: `${String(year).slice(-2)} Q${q}`,
    };
  }
  return {
    key: `${year}`,
    shortLabel: `${year}年`,
  };
}

/**
 * 計算包含 endRange 在內往前推算共 count 期的收支趨勢與去年同期支出（排除轉帳與已刪除）。
 */
export function periodTrend(
  transactions: readonly Transaction[],
  kind: PeriodKind,
  endRange: PeriodRange,
  count: number,
): PeriodTrendItem[] {
  const safeCount = Math.max(0, Math.trunc(count));
  const normalizedEnd = periodRange(kind, endRange.start);
  const validTxs = transactions.filter((tx) => !tx.deleted && tx.kind !== 'transfer');

  const items: PeriodTrendItem[] = [];
  for (let i = safeCount - 1; i >= 0; i -= 1) {
    const r = shiftPeriod(normalizedEnd, -i);
    const prevYear = sameLastYear(r);
    const currentSum = periodSummary(validTxs, r);
    const prevYearSum = periodSummary(validTxs, prevYear);
    const { key, shortLabel } = formatTrendKeyAndShortLabel(r);

    items.push({
      key,
      shortLabel,
      label: r.label,
      income: currentSum.income,
      expense: currentSum.expense,
      lastYearExpense: prevYearSum.expense,
    });
  }

  return items;
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
