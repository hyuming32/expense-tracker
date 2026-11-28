import { describe, expect, it } from 'vitest';
import type { Budget, Category, Transaction } from '../db/types';
import {
  computeBudgetStatus,
  computeMemberBudgetUsage,
  getBudgetAlertLevel,
} from './budget';

const BASE_META = {
  updatedAt: 1000,
  deviceId: 'dev-1',
  deleted: false,
} as const;

const categories: Category[] = [
  {
    id: 'cat-food',
    name: '飲食',
    icon: '🍽️',
    kind: 'expense',
    parentId: null,
    sortOrder: 1,
    archived: false,
    ...BASE_META,
  },
  {
    id: 'cat-food-lunch',
    name: '午餐',
    icon: '🍱',
    kind: 'expense',
    parentId: 'cat-food',
    sortOrder: 1,
    archived: false,
    ...BASE_META,
  },
  {
    id: 'cat-transport',
    name: '交通',
    icon: '🚇',
    kind: 'expense',
    parentId: null,
    sortOrder: 2,
    archived: false,
    ...BASE_META,
  },
  {
    id: 'cat-salary',
    name: '薪資',
    icon: '💰',
    kind: 'income',
    parentId: null,
    sortOrder: 1,
    archived: false,
    ...BASE_META,
  },
];

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: `tx-${Math.random()}`,
    kind: 'expense',
    date: '2026-11-20',
    amount: 100,
    accountId: 'acc-1',
    toAccountId: null,
    categoryId: 'cat-food',
    note: null,
    ...BASE_META,
    ...overrides,
  };
}

function makeBudget(categoryId: string | null, amount: number): Budget {
  return {
    id: categoryId === null ? 'budget-total' : `budget-${categoryId}`,
    categoryId,
    amount,
    ...BASE_META,
  };
}

describe('computeBudgetStatus', () => {
  it('未設總預算時 total 回傳 null，但仍計算分類預算', () => {
    const budgets = [makeBudget('cat-food', 5000)];
    const txs = [makeTx({ amount: 1200, categoryId: 'cat-food' })];

    const result = computeBudgetStatus(budgets, txs, categories, '2026-11-26');
    expect(result.total).toBeNull();
    expect(result.daysLeft).toBe(5); // 11/26 到 11/30 共 5 天
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]?.spent).toBe(1200);
    expect(result.categories[0]?.remaining).toBe(3800);
    expect(result.categories[0]?.perDay).toBe(760);
  });

  it('只計支出，不計收入、轉帳、已刪除交易與跨月交易；子分類支出算進主分類', () => {
    const budgets = [makeBudget(null, 10000), makeBudget('cat-food', 3000)];
    const txs: Transaction[] = [
      makeTx({ id: 'tx-1', kind: 'expense', date: '2026-11-01', amount: 500, categoryId: 'cat-food' }),
      makeTx({ id: 'tx-2', kind: 'expense', date: '2026-11-15', amount: 400, categoryId: 'cat-food-lunch' }),
      makeTx({ id: 'tx-3', kind: 'expense', date: '2026-11-16', amount: 300, categoryId: 'cat-transport' }),
      makeTx({ id: 'tx-income', kind: 'income', date: '2026-11-10', amount: 50000, categoryId: 'cat-salary' }),
      makeTx({ id: 'tx-transfer', kind: 'transfer', date: '2026-11-12', amount: 8000, toAccountId: 'acc-2', categoryId: null }),
      makeTx({ id: 'tx-deleted', kind: 'expense', date: '2026-11-18', amount: 2000, categoryId: 'cat-food', deleted: true }),
      makeTx({ id: 'tx-prev-month', kind: 'expense', date: '2026-10-31', amount: 1500, categoryId: 'cat-food' }),
    ];

    const result = computeBudgetStatus(budgets, txs, categories, '2026-11-26');
    expect(result.total?.spent).toBe(1200);
    expect(result.total?.remaining).toBe(8800);
    expect(result.total?.perDay).toBe(Math.floor(8800 / 5));

    expect(result.categories[0]?.categoryId).toBe('cat-food');
    expect(result.categories[0]?.spent).toBe(900); // 500 + 400
    expect(result.categories[0]?.remaining).toBe(2100);
  });

  it('月底當天 daysLeft=1；超支時 remaining 為負且 perDay=0', () => {
    const budgets = [makeBudget(null, 5000)];
    const txs = [makeTx({ date: '2026-11-30', amount: 6200, categoryId: 'cat-food' })];

    const result = computeBudgetStatus(budgets, txs, categories, '2026-11-30');
    expect(result.daysLeft).toBe(1);
    expect(result.total?.daysLeft).toBe(1);
    expect(result.total?.remaining).toBe(-1200);
    expect(result.total?.perDay).toBe(0);
    expect(result.total?.status).toBe('over');
    expect(result.total?.statusLabel).toBe('已超支');
  });

  it('狀態門檻：< 0.8 正常、0.8–1 快用完、> 1 已超支', () => {
    expect(getBudgetAlertLevel(0)).toEqual({ status: 'normal', statusLabel: '正常' });
    expect(getBudgetAlertLevel(0.799)).toEqual({ status: 'normal', statusLabel: '正常' });
    expect(getBudgetAlertLevel(0.8)).toEqual({ status: 'warning', statusLabel: '快用完' });
    expect(getBudgetAlertLevel(1)).toEqual({ status: 'warning', statusLabel: '快用完' });
    expect(getBudgetAlertLevel(1.001)).toEqual({ status: 'over', statusLabel: '已超支' });
  });

  it('分類預算依 ratio 由高到低排序', () => {
    const budgets = [makeBudget('cat-food', 1000), makeBudget('cat-transport', 1000)];
    const txs = [
      makeTx({ amount: 300, categoryId: 'cat-food' }), // 0.3
      makeTx({ amount: 900, categoryId: 'cat-transport' }), // 0.9
    ];

    const result = computeBudgetStatus(budgets, txs, categories, '2026-11-26');
    expect(result.categories.map((c) => c.categoryId)).toEqual(['cat-transport', 'cat-food']);
  });
});

describe('computeMemberBudgetUsage', () => {
  it('只計指定成員當月未刪除支出（含分期當月那一期），不計他人、跨月、收入與轉帳', () => {
    const txs: Transaction[] = [
      makeTx({ id: 'm1', kind: 'expense', date: '2026-11-03', amount: 1500, memberId: 'mem-me' }),
      makeTx({
        id: 'm2-inst-nov',
        kind: 'expense',
        date: '2026-11-15',
        amount: 2500,
        memberId: 'mem-me',
        installmentId: 'inst-1',
        installmentIndex: 1,
        installmentCount: 3,
      }),
      makeTx({
        id: 'm2-inst-dec',
        kind: 'expense',
        date: '2026-12-15',
        amount: 2500,
        memberId: 'mem-me',
        installmentId: 'inst-1',
        installmentIndex: 2,
        installmentCount: 3,
      }),
      makeTx({ id: 'other', kind: 'expense', date: '2026-11-10', amount: 3000, memberId: 'mem-other' }),
      makeTx({ id: 'inc', kind: 'income', date: '2026-11-05', amount: 50000, categoryId: 'cat-salary', memberId: 'mem-me' }),
      makeTx({ id: 'trf', kind: 'transfer', date: '2026-11-06', amount: 5000, toAccountId: 'acc-2', categoryId: null, memberId: 'mem-me' }),
      makeTx({ id: 'del', kind: 'expense', date: '2026-11-08', amount: 900, memberId: 'mem-me', deleted: true }),
    ];

    const warningUsage = computeMemberBudgetUsage(txs, 'mem-me', '2026-11', 5000);
    expect(warningUsage).toEqual({
      memberId: 'mem-me',
      budget: 5000,
      spent: 4000,
      remaining: 1000,
      ratio: 0.8,
      status: 'warning',
      statusLabel: '快用完',
    });

    const overUsage = computeMemberBudgetUsage(txs, 'mem-me', '2026-11', 3500);
    expect(overUsage.remaining).toBe(-500);
    expect(overUsage.status).toBe('over');
    expect(overUsage.statusLabel).toBe('已超支');
  });
});
