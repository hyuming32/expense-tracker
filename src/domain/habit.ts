import type { NoSpendDay, Transaction } from '../db/types';

export interface StreakResult {
  streak: number;
  todayRecorded: boolean;
}

export interface MonthHabitStats {
  recordedDays: number;
  blankDays: number;
}

/**
 * 將 YYYY-MM-DD 日期字串加減指定天數（以本地曆法計算，避免 UTC 偏移）。
 */
export function shiftDate(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) {
    return dateStr;
  }
  const date = new Date(y, m - 1, d + deltaDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 收集所有「有記帳的日子」：
 * 當天有任何未刪除且非週期自動入帳（無 recurringId）的交易，或使用者標記為「這天沒花錢」。
 */
export function collectActiveDays(
  transactions: readonly Transaction[],
  noSpendDays: readonly NoSpendDay[],
): Set<string> {
  const active = new Set<string>();
  for (const tx of transactions) {
    if (tx.deleted || tx.recurringId) {
      continue;
    }
    active.add(tx.date);
  }
  for (const day of noSpendDays) {
    if (!day.deleted) {
      active.add(day.date);
    }
  }
  return active;
}

/**
 * 取得所有未刪除且非自動入帳交易中最早的日期；若無則回傳 null。
 */
export function findFirstRecordDay(
  transactions: readonly Transaction[],
  noSpendDays: readonly NoSpendDay[] = [],
): string | null {
  let first: string | null = null;
  for (const tx of transactions) {
    if (tx.deleted || tx.recurringId) {
      continue;
    }
    if (first === null || tx.date < first) {
      first = tx.date;
    }
  }
  for (const day of noSpendDays) {
    if (day.deleted) {
      continue;
    }
    if (first === null || day.date < first) {
      first = day.date;
    }
  }
  return first;
}

/**
 * 計算從今天往回數的連續記帳天數。
 * 今天還沒記時從昨天開始數（今天不打斷連續，但回傳 todayRecorded = false）。
 */
export function computeStreak(activeDays: ReadonlySet<string>, today: string): StreakResult {
  const todayRecorded = activeDays.has(today);
  let cursor = todayRecorded ? today : shiftDate(today, -1);
  let streak = 0;

  while (activeDays.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }

  return { streak, todayRecorded };
}

/**
 * 找出從 firstDay 到昨天之間沒記帳的日期，依由近到遠排序。
 */
export function findMissingDays(
  activeDays: ReadonlySet<string>,
  firstDay: string | null,
  today: string,
  limit?: number,
): string[] {
  if (!firstDay || firstDay >= today) {
    return [];
  }
  if (limit !== undefined && limit <= 0) {
    return [];
  }

  const missing: string[] = [];
  let cursor = shiftDate(today, -1);

  while (cursor >= firstDay) {
    if (!activeDays.has(cursor)) {
      missing.push(cursor);
      if (limit !== undefined && missing.length >= limit) {
        break;
      }
    }
    cursor = shiftDate(cursor, -1);
  }

  return missing;
}

/**
 * 計算指定月份（YYYY-MM）的已記帳天數與空白天數（僅計算早於 today 的過去日期）。
 */
export function computeMonthHabitStats(
  month: string,
  activeDays: ReadonlySet<string>,
  today: string,
  /** 第一個有記帳的日子；之前的日期不算空白。null＝從未記帳（不算任何空白）；省略＝不設下限 */
  firstDay?: string | null,
): MonthHabitStats {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) {
    return { recordedDays: 0, blankDays: 0 };
  }
  const daysInMonth = new Date(y, m, 0).getDate();
  let recordedDays = 0;
  let blankDays = 0;

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateStr = `${month}-${String(day).padStart(2, '0')}`;
    if (dateStr > today) {
      continue;
    }
    if (activeDays.has(dateStr)) {
      recordedDays += 1;
    } else if (dateStr < today && firstDay !== null && (firstDay === undefined || dateStr >= firstDay)) {
      blankDays += 1;
    }
  }

  return { recordedDays, blankDays };
}
