import { describe, expect, it } from 'vitest';
import type { Transaction } from '../db/types';
import {
  buildInstallmentDates,
  getInstallmentProgress,
  splitInstallment,
} from './installment';

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx-1',
    kind: 'expense',
    date: '2026-11-01',
    amount: 1000,
    accountId: 'acc-1',
    toAccountId: null,
    categoryId: 'cat-1',
    note: null,
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted: false,
    ...overrides,
  };
}

describe('splitInstallment', () => {
  it('0 位小數除不盡時零頭全部加在第 1 期且總和相等', () => {
    const parts = splitInstallment(10000, 3, 0);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(parts.reduce((sum, n) => sum + n, 0)).toBe(10000);
  });

  it('2 位小數除不盡時以最小單位計算避免浮點誤差', () => {
    const parts = splitInstallment(100, 3, 2);
    expect(parts).toEqual([33.34, 33.33, 33.33]);
    expect(Math.round(parts.reduce((sum, n) => sum + n, 0) * 100) / 100).toBe(100);
  });

  it('整除時每期金額相同，並支援 2 到 60 期邊界', () => {
    expect(splitInstallment(1200, 2, 0)).toEqual([600, 600]);
    const sixty = splitInstallment(6000, 60, 0);
    expect(sixty).toHaveLength(60);
    expect(sixty.every((n) => n === 100)).toBe(true);
  });

  it('期數超出 2–60 或金額 <= 0 時拋出錯誤', () => {
    expect(() => splitInstallment(1000, 1, 0)).toThrow();
    expect(() => splitInstallment(1000, 61, 0)).toThrow();
    expect(() => splitInstallment(1000, 2.5, 0)).toThrow();
    expect(() => splitInstallment(0, 3, 0)).toThrow();
  });
});

describe('buildInstallmentDates', () => {
  it('從 1/31 起跨平年 2 月時取 2/28，第 3 期回到 3/31（不被前月月底帶偏）', () => {
    expect(buildInstallmentDates('2026-01-31', 4)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('從 1/31 起跨閏年 2 月時取 2/29，第 3 期回到 3/31', () => {
    expect(buildInstallmentDates('2024-01-31', 3)).toEqual([
      '2024-01-31',
      '2024-02-29',
      '2024-03-31',
    ]);
  });

  it('正確處理跨年月份', () => {
    expect(buildInstallmentDates('2026-11-15', 4)).toEqual([
      '2026-11-15',
      '2026-12-15',
      '2027-01-15',
      '2027-02-15',
    ]);
  });
});

describe('getInstallmentProgress', () => {
  it('依 date <= today 計算已入帳與剩餘期數金額，並忽略 deleted 與其他分期', () => {
    const txs: Transaction[] = [
      makeTx({ id: 'a1', installmentId: 'inst-1', installmentIndex: 1, date: '2026-10-15', amount: 3334 }),
      makeTx({ id: 'a2', installmentId: 'inst-1', installmentIndex: 2, date: '2026-11-15', amount: 3333 }),
      makeTx({ id: 'a3', installmentId: 'inst-1', installmentIndex: 3, date: '2026-12-15', amount: 3333 }),
      makeTx({
        id: 'a4-deleted',
        installmentId: 'inst-1',
        installmentIndex: 4,
        date: '2027-01-15',
        amount: 3333,
        deleted: true,
      }),
      makeTx({ id: 'b1', installmentId: 'inst-other', installmentIndex: 1, date: '2026-11-01', amount: 500 }),
    ];

    expect(getInstallmentProgress(txs, 'inst-1', '2026-11-15')).toEqual({
      count: 3,
      total: 10000,
      paidCount: 2,
      paidAmount: 6667,
      remainingCount: 1,
      remainingAmount: 3333,
    });
  });
});
