import { describe, expect, it } from 'vitest';
import type { RecurringRule } from '../db/types';
import {
  buildRecurringTransactionId,
  dueOccurrences,
  formatRecurringFrequency,
  getNextOccurrenceDate,
  getRecurringRuleStatus,
  MAX_RECURRING_BACKFILL,
} from './recurring';

function makeRule(overrides: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: 'rule-1',
    kind: 'expense',
    amount: 1000,
    accountId: 'seed-acc-cash',
    toAccountId: null,
    categoryId: 'seed-cat-housing',
    note: '房租',
    frequency: 'monthly',
    dayOfMonth: 5,
    weekday: 1,
    monthOfYear: 1,
    startDate: '2026-01-01',
    endDate: null,
    paused: false,
    autoPost: true,
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted: false,
    ...overrides,
  };
}

describe('週期性收支純函式', () => {
  it('每月 31 日在 2 月（平年／閏年）與 4 月會落在月底', () => {
    const rule = makeRule({
      frequency: 'monthly',
      dayOfMonth: 31,
      startDate: '2024-01-01',
    });

    const dates2024 = dueOccurrences(rule, null, '2024-05-15');
    expect(dates2024).toEqual([
      '2024-01-31',
      '2024-02-29', // 2024 為閏年
      '2024-03-31',
      '2024-04-30',
    ]);

    const rule2025 = makeRule({
      frequency: 'monthly',
      dayOfMonth: 31,
      startDate: '2025-01-01',
    });
    const dates2025 = dueOccurrences(rule2025, null, '2025-04-30');
    expect(dates2025).toEqual([
      '2025-01-31',
      '2025-02-28', // 2025 為平年
      '2025-03-31',
      '2025-04-30',
    ]);
  });

  it('閏年 2/29 年規則在平年落在 2/28、閏年落在 2/29', () => {
    const rule = makeRule({
      frequency: 'yearly',
      monthOfYear: 2,
      dayOfMonth: 29,
      startDate: '2024-01-01',
    });

    const dates = dueOccurrences(rule, null, '2028-03-01');
    expect(dates).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ]);
  });

  it('每週規則依 weekday 正確產生日期並受 lastCheckedDate 節流', () => {
    // 2026-11-02 為週一 (weekday=1)
    const rule = makeRule({
      frequency: 'weekly',
      weekday: 1,
      startDate: '2026-11-01',
    });

    expect(dueOccurrences(rule, null, '2026-11-26')).toEqual([
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
    ]);

    expect(dueOccurrences(rule, '2026-11-09', '2026-11-26')).toEqual([
      '2026-11-16',
      '2026-11-23',
    ]);
  });

  it('長時間未開啟補產生多期時，最多只產生最近 24 筆', () => {
    const rule = makeRule({
      frequency: 'monthly',
      dayOfMonth: 10,
      startDate: '2023-01-01',
    });

    const dates = dueOccurrences(rule, null, '2026-11-26');
    expect(dates).toHaveLength(MAX_RECURRING_BACKFILL);
    expect(dates[0]).toBe('2024-12-10');
    expect(dates[dates.length - 1]).toBe('2026-11-10');
  });

  it('暫停中或超過結束日時不再產生新期數', () => {
    const pausedRule = makeRule({ paused: true, startDate: '2026-01-01' });
    expect(dueOccurrences(pausedRule, null, '2026-11-26')).toEqual([]);
    expect(getNextOccurrenceDate(pausedRule, '2026-11-26')).toBeNull();
    expect(getRecurringRuleStatus(pausedRule, '2026-11-26')).toBe('paused');

    const endedRule = makeRule({
      frequency: 'monthly',
      dayOfMonth: 5,
      startDate: '2026-09-01',
      endDate: '2026-10-10',
    });
    expect(dueOccurrences(endedRule, null, '2026-11-26')).toEqual([
      '2026-09-05',
      '2026-10-05',
    ]);
    expect(getNextOccurrenceDate(endedRule, '2026-11-26')).toBeNull();
    expect(getRecurringRuleStatus(endedRule, '2026-11-26')).toBe('ended');
  });

  it('格式與決定性交易 id 輔助函式正確運作', () => {
    expect(buildRecurringTransactionId('r1', '2026-11-05')).toBe('rec-r1-2026-11-05');
    expect(formatRecurringFrequency(makeRule({ frequency: 'monthly', dayOfMonth: 5 }))).toBe(
      '每月 5 日',
    );
    expect(formatRecurringFrequency(makeRule({ frequency: 'weekly', weekday: 1 }))).toBe('每週一');
    expect(
      formatRecurringFrequency(makeRule({ frequency: 'yearly', monthOfYear: 3, dayOfMonth: 1 })),
    ).toBe('每年 3 月 1 日');
  });
});
