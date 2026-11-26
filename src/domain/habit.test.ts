import { describe, expect, it } from 'vitest';
import type { NoSpendDay, Transaction } from '../db/types';
import {
  collectActiveDays,
  computeMonthHabitStats,
  computeStreak,
  findFirstRecordDay,
  findMissingDays,
} from './habit';

function makeTx(overrides: Partial<Transaction> & { date: string }): Transaction {
  return {
    id: `tx-${overrides.date}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'expense',
    amount: 100,
    accountId: 'seed-acc-cash',
    toAccountId: null,
    categoryId: 'seed-cat-food',
    note: null,
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted: false,
    ...overrides,
  };
}

function makeNoSpend(date: string, deleted = false): NoSpendDay {
  return {
    id: `nospend-${date}`,
    date,
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted,
  };
}

describe('collectActiveDays', () => {
  it('納入一般支出、收入、轉帳，排除已刪除與 recurringId 自動入帳交易', () => {
    const txs: Transaction[] = [
      makeTx({ date: '2026-11-20', kind: 'expense' }),
      makeTx({ date: '2026-11-21', kind: 'income', categoryId: 'seed-cat-income-salary' }),
      makeTx({ date: '2026-11-22', kind: 'transfer', categoryId: null, toAccountId: 'seed-acc-bank' }),
      makeTx({ date: '2026-11-23', recurringId: 'rule-1', occurrenceDate: '2026-11-23' }),
      makeTx({ date: '2026-11-24', deleted: true }),
    ];

    const active = collectActiveDays(txs, []);
    expect(active.has('2026-11-20')).toBe(true);
    expect(active.has('2026-11-21')).toBe(true);
    expect(active.has('2026-11-22')).toBe(true);
    expect(active.has('2026-11-23')).toBe(false);
    expect(active.has('2026-11-24')).toBe(false);
  });

  it('將未刪除的沒花錢標記算作有記帳的日子', () => {
    const active = collectActiveDays(
      [makeTx({ date: '2026-11-24' })],
      [makeNoSpend('2026-11-25'), makeNoSpend('2026-11-23', true)],
    );

    expect(active.has('2026-11-24')).toBe(true);
    expect(active.has('2026-11-25')).toBe(true);
    expect(active.has('2026-11-23')).toBe(false);
  });
});

describe('computeStreak', () => {
  it('今天有記時從今天往回數連續天數', () => {
    const active = new Set(['2026-11-24', '2026-11-25', '2026-11-26']);
    expect(computeStreak(active, '2026-11-26')).toEqual({
      streak: 3,
      todayRecorded: true,
    });
  });

  it('今天沒記時從昨天開始往回數且不打斷連續', () => {
    const active = new Set(['2026-11-23', '2026-11-24', '2026-11-25']);
    expect(computeStreak(active, '2026-11-26')).toEqual({
      streak: 3,
      todayRecorded: false,
    });
  });

  it('中間斷一天時只算斷開後的連續天數', () => {
    const active = new Set(['2026-11-21', '2026-11-22', '2026-11-24', '2026-11-25', '2026-11-26']);
    expect(computeStreak(active, '2026-11-26')).toEqual({
      streak: 3,
      todayRecorded: true,
    });
  });

  it('只有今天有記時回傳 streak = 1', () => {
    const active = new Set(['2026-11-26']);
    expect(computeStreak(active, '2026-11-26')).toEqual({
      streak: 1,
      todayRecorded: true,
    });
  });

  it('今天與昨天都沒記時回傳 streak = 0', () => {
    const active = new Set(['2026-11-24']);
    expect(computeStreak(active, '2026-11-26')).toEqual({
      streak: 0,
      todayRecorded: false,
    });
  });
});

describe('findMissingDays', () => {
  it('回傳從 firstDay 到昨天之間漏記的日期，由近到遠排序並遵守 limit', () => {
    const active = new Set(['2026-11-20', '2026-11-22', '2026-11-26']);
    expect(findMissingDays(active, '2026-11-20', '2026-11-26')).toEqual([
      '2026-11-25',
      '2026-11-24',
      '2026-11-23',
      '2026-11-21',
    ]);

    expect(findMissingDays(active, '2026-11-20', '2026-11-26', 2)).toEqual([
      '2026-11-25',
      '2026-11-24',
    ]);
  });

  it('firstDay 為 null 或大於等於 today 時回傳空陣列', () => {
    const active = new Set<string>();
    expect(findMissingDays(active, null, '2026-11-26')).toEqual([]);
    expect(findMissingDays(active, '2026-11-26', '2026-11-26')).toEqual([]);
    expect(findMissingDays(active, '2026-11-27', '2026-11-26')).toEqual([]);
  });
});

describe('findFirstRecordDay & computeMonthHabitStats', () => {
  it('找出最早非自動入帳交易日並計算本月已記與空白天數', () => {
    const txs: Transaction[] = [
      makeTx({ date: '2026-11-01', recurringId: 'rule-1' }),
      makeTx({ date: '2026-11-03' }),
      makeTx({ date: '2026-11-05' }),
    ];
    expect(findFirstRecordDay(txs)).toBe('2026-11-03');

    const active = collectActiveDays(txs, [makeNoSpend('2026-11-04')]);
    // today = 2026-11-06：03, 04, 05 已記（3天）；01, 02 空白（2天）；06 當天未記不算空白
    expect(computeMonthHabitStats('2026-11', active, '2026-11-06')).toEqual({
      recordedDays: 3,
      blankDays: 2,
    });
  });

  it('第一個記帳日之前的日期不算空白日', () => {
    const active = new Set(['2026-11-20', '2026-11-22']);
    // 20、22 已記；21 空白；1–19 在第一筆之前不算；26 為今天不算
    expect(computeMonthHabitStats('2026-11', active, '2026-11-26', '2026-11-20')).toEqual({
      recordedDays: 2,
      blankDays: 4,
    });
    expect(computeMonthHabitStats('2026-11', new Set(), '2026-11-26', null)).toEqual({
      recordedDays: 0,
      blankDays: 0,
    });
  });
});
