import type { RecurringFrequency, RecurringRule, TransactionKind } from '../db/types';
import { hasAtMostDecimals } from './currency';

export const MAX_RECURRING_BACKFILL = 24;

const WEEKDAYS_ZH = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParts(dateStr: string): { year: number; month: number; day: number } | null {
  if (!DATE_PATTERN.test(dateStr)) {
    return null;
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) {
    return null;
  }
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) {
    return null;
  }
  return { year: y, month: m, day: d };
}

function formatDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 取得指定西元年與月份（1–12）的總天數。
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function addDays(dateStr: string, days: number): string {
  const parts = parseDateParts(dateStr);
  if (!parts) {
    return dateStr;
  }
  const date = new Date(parts.year, parts.month - 1, parts.day + days);
  return formatDateParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function getWeekday(dateStr: string): number {
  const parts = parseDateParts(dateStr);
  if (!parts) {
    return 0;
  }
  return new Date(parts.year, parts.month - 1, parts.day).getDay();
}

/**
 * 產生決定性的週期交易識別碼，確保多裝置各自產生時不會重複。
 */
export function buildRecurringTransactionId(ruleId: string, occurrenceDate: string): string {
  return `rec-${ruleId}-${occurrenceDate}`;
}

/**
 * 計算規則在 (lastCheckedDate, today] 之間應產生的週期日期清單（最多回傳最近 24 筆）。
 */
export function dueOccurrences(
  rule: RecurringRule,
  lastCheckedDate: string | null,
  today: string,
): string[] {
  if (rule.deleted || rule.paused) {
    return [];
  }
  if (!parseDateParts(rule.startDate) || !parseDateParts(today)) {
    return [];
  }

  const effectiveEnd = rule.endDate && rule.endDate < today ? rule.endDate : today;
  if (effectiveEnd < rule.startDate) {
    return [];
  }
  if (lastCheckedDate && lastCheckedDate >= effectiveEnd) {
    return [];
  }

  const startParts = parseDateParts(rule.startDate)!;
  const endParts = parseDateParts(effectiveEnd)!;
  const results: string[] = [];

  if (rule.frequency === 'monthly') {
    const clampedDay = Math.max(1, Math.min(31, Math.trunc(rule.dayOfMonth)));
    let year = startParts.year;
    let month = startParts.month;

    while (year < endParts.year || (year === endParts.year && month <= endParts.month)) {
      const day = Math.min(clampedDay, daysInMonth(year, month));
      const candidate = formatDateParts(year, month, day);
      if (
        candidate >= rule.startDate &&
        candidate <= effectiveEnd &&
        (!lastCheckedDate || candidate > lastCheckedDate)
      ) {
        results.push(candidate);
      }
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  } else if (rule.frequency === 'yearly') {
    const targetMonth = Math.max(1, Math.min(12, Math.trunc(rule.monthOfYear)));
    const clampedDay = Math.max(1, Math.min(31, Math.trunc(rule.dayOfMonth)));

    for (let year = startParts.year; year <= endParts.year; year++) {
      const day = Math.min(clampedDay, daysInMonth(year, targetMonth));
      const candidate = formatDateParts(year, targetMonth, day);
      if (
        candidate >= rule.startDate &&
        candidate <= effectiveEnd &&
        (!lastCheckedDate || candidate > lastCheckedDate)
      ) {
        results.push(candidate);
      }
    }
  } else {
    const targetWeekday = ((Math.trunc(rule.weekday) % 7) + 7) % 7;
    const minStart =
      lastCheckedDate && lastCheckedDate >= rule.startDate
        ? addDays(lastCheckedDate, 1)
        : rule.startDate;
    const offset = (targetWeekday - getWeekday(minStart) + 7) % 7;
    let cursor = addDays(minStart, offset);

    while (cursor <= effectiveEnd) {
      results.push(cursor);
      cursor = addDays(cursor, 7);
    }
  }

  if (results.length > MAX_RECURRING_BACKFILL) {
    return results.slice(-MAX_RECURRING_BACKFILL);
  }
  return results;
}

/**
 * 計算規則從指定日期起的下一次發生日期；若已暫停、已結束或已刪除則回傳 null。
 */
export function getNextOccurrenceDate(rule: RecurringRule, today: string): string | null {
  if (rule.deleted || rule.paused) {
    return null;
  }
  if (rule.endDate && rule.endDate < today) {
    return null;
  }
  const searchStart = rule.startDate > today ? rule.startDate : today;
  const startParts = parseDateParts(searchStart);
  if (!startParts) {
    return null;
  }

  let candidate: string;
  if (rule.frequency === 'monthly') {
    const clampedDay = Math.max(1, Math.min(31, Math.trunc(rule.dayOfMonth)));
    const thisMonthDay = Math.min(clampedDay, daysInMonth(startParts.year, startParts.month));
    const thisMonthCandidate = formatDateParts(startParts.year, startParts.month, thisMonthDay);
    if (thisMonthCandidate >= searchStart) {
      candidate = thisMonthCandidate;
    } else {
      const nextMonth = startParts.month === 12 ? 1 : startParts.month + 1;
      const nextYear = startParts.month === 12 ? startParts.year + 1 : startParts.year;
      const nextMonthDay = Math.min(clampedDay, daysInMonth(nextYear, nextMonth));
      candidate = formatDateParts(nextYear, nextMonth, nextMonthDay);
    }
  } else if (rule.frequency === 'yearly') {
    const targetMonth = Math.max(1, Math.min(12, Math.trunc(rule.monthOfYear)));
    const clampedDay = Math.max(1, Math.min(31, Math.trunc(rule.dayOfMonth)));
    const thisYearDay = Math.min(clampedDay, daysInMonth(startParts.year, targetMonth));
    const thisYearCandidate = formatDateParts(startParts.year, targetMonth, thisYearDay);
    if (thisYearCandidate >= searchStart) {
      candidate = thisYearCandidate;
    } else {
      const nextYear = startParts.year + 1;
      const nextYearDay = Math.min(clampedDay, daysInMonth(nextYear, targetMonth));
      candidate = formatDateParts(nextYear, targetMonth, nextYearDay);
    }
  } else {
    const targetWeekday = ((Math.trunc(rule.weekday) % 7) + 7) % 7;
    const offset = (targetWeekday - getWeekday(searchStart) + 7) % 7;
    candidate = addDays(searchStart, offset);
  }

  if (rule.endDate && candidate > rule.endDate) {
    return null;
  }
  return candidate;
}

/**
 * 格式化週期頻率顯示文字，例如「每月 5 日」「每週一」「每年 3 月 1 日」。
 */
export function formatRecurringFrequency(
  rule: Pick<RecurringRule, 'frequency' | 'dayOfMonth' | 'weekday' | 'monthOfYear'>,
): string {
  if (rule.frequency === 'weekly') {
    return `每${WEEKDAYS_ZH[rule.weekday] ?? '週一'}`;
  }
  if (rule.frequency === 'yearly') {
    return `每年 ${rule.monthOfYear} 月 ${rule.dayOfMonth} 日`;
  }
  return `每月 ${rule.dayOfMonth} 日`;
}

export type RecurringRuleStatus = 'active' | 'paused' | 'ended';

/**
 * 取得週期規則的目前狀態（啟用／暫停／已結束）。
 */
export function getRecurringRuleStatus(
  rule: Pick<RecurringRule, 'paused' | 'endDate'>,
  today: string,
): RecurringRuleStatus {
  if (rule.endDate && rule.endDate < today) {
    return 'ended';
  }
  if (rule.paused) {
    return 'paused';
  }
  return 'active';
}

export interface RecurringRuleValidationInput {
  kind: TransactionKind;
  amount: number;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  frequency: RecurringFrequency;
  dayOfMonth: number;
  weekday: number;
  monthOfYear: number;
  startDate: string;
  endDate: string | null;
}

/**
 * 驗證週期性收支規則表單欄位，回傳繁體中文錯誤訊息陣列。
 */
export function validateRecurringRule(
  input: RecurringRuleValidationInput,
  maxDecimals = 0,
): string[] {
  const errors: string[] = [];

  if (maxDecimals <= 0) {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      errors.push('金額必須為大於 0 的整數');
    }
  } else if (!Number.isFinite(input.amount) || input.amount <= 0) {
    errors.push('金額必須為大於 0 的數字');
  } else if (!hasAtMostDecimals(input.amount, maxDecimals)) {
    errors.push(`金額最多 ${maxDecimals} 位小數`);
  }
  if (!input.accountId) {
    errors.push('請選擇帳戶');
  }
  if (input.kind === 'transfer') {
    if (!input.toAccountId) {
      errors.push('請選擇轉入帳戶');
    } else if (input.toAccountId === input.accountId) {
      errors.push('轉出與轉入帳戶不可相同');
    }
  } else if (!input.categoryId) {
    errors.push('請選擇分類');
  }

  if (!parseDateParts(input.startDate)) {
    errors.push('開始日期格式不正確');
  }
  if (input.endDate !== null && input.endDate !== '') {
    if (!parseDateParts(input.endDate)) {
      errors.push('結束日期格式不正確');
    } else if (parseDateParts(input.startDate) && input.endDate < input.startDate) {
      errors.push('結束日期不可早於開始日期');
    }
  }

  if (input.frequency === 'monthly' || input.frequency === 'yearly') {
    if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
      errors.push('每月日期必須介於 1 到 31');
    }
  }
  if (input.frequency === 'yearly') {
    if (!Number.isInteger(input.monthOfYear) || input.monthOfYear < 1 || input.monthOfYear > 12) {
      errors.push('月份必須介於 1 到 12');
    }
  }
  if (input.frequency === 'weekly') {
    if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
      errors.push('星期必須介於 0 到 6');
    }
  }

  return errors;
}
