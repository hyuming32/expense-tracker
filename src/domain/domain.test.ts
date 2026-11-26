import { describe, expect, it } from 'vitest';
import type { Account, Category, Transaction } from '../db/types';
import {
  accountBalance,
  categoryBreakdown,
  groupByDay,
  mergeBackup,
  monthSummary,
  monthlyTrend,
  toCsv,
  validateTransaction,
} from './index';

const baseMeta = {
  updatedAt: 1700000000000,
  deviceId: 'dev-1',
  deleted: false,
};

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx-1',
    kind: 'expense',
    date: '2026-11-10',
    amount: 100,
    accountId: 'acc-cash',
    toAccountId: null,
    categoryId: 'cat-food',
    note: null,
    ...baseMeta,
    ...overrides,
  };
}

describe('monthSummary', () => {
  it('計算指定月份收支並排除轉帳與已刪除紀錄', () => {
    const txs: Transaction[] = [
      makeTx({ id: '1', kind: 'income', date: '2026-11-01', amount: 50000, categoryId: 'cat-salary' }),
      makeTx({ id: '2', kind: 'expense', date: '2026-11-05', amount: 1200 }),
      makeTx({ id: '3', kind: 'expense', date: '2026-11-06', amount: 800 }),
      makeTx({
        id: '4',
        kind: 'transfer',
        date: '2026-11-07',
        amount: 10000,
        accountId: 'acc-bank',
        toAccountId: 'acc-cash',
        categoryId: null,
      }),
      makeTx({ id: '5', kind: 'expense', date: '2026-11-08', amount: 9999, deleted: true }),
      makeTx({ id: '6', kind: 'income', date: '2026-10-31', amount: 30000, categoryId: 'cat-salary' }),
    ];

    expect(monthSummary(txs, '2026-11')).toEqual({
      income: 50000,
      expense: 2000,
      net: 48000,
    });
  });
});

describe('accountBalance', () => {
  it('正確計算含初始餘額、收入、支出、轉出與轉入的帳戶餘額', () => {
    const cash: Account = {
      id: 'acc-cash',
      name: '現金',
      type: 'cash',
      initialBalance: 1000,
      archived: false,
      sortOrder: 1,
      ...baseMeta,
    };
    const credit: Account = {
      id: 'acc-credit',
      name: '信用卡',
      type: 'credit',
      initialBalance: 0,
      archived: false,
      sortOrder: 2,
      ...baseMeta,
    };

    const txs: Transaction[] = [
      makeTx({ id: '1', kind: 'income', accountId: 'acc-cash', amount: 500, categoryId: 'cat-1' }),
      makeTx({ id: '2', kind: 'expense', accountId: 'acc-cash', amount: 200 }),
      makeTx({
        id: '3',
        kind: 'transfer',
        accountId: 'acc-bank',
        toAccountId: 'acc-cash',
        categoryId: null,
        amount: 3000,
      }),
      makeTx({
        id: '4',
        kind: 'transfer',
        accountId: 'acc-cash',
        toAccountId: 'acc-credit',
        categoryId: null,
        amount: 800,
      }),
      makeTx({ id: '5', kind: 'expense', accountId: 'acc-credit', amount: 1500 }),
      makeTx({ id: '6', kind: 'expense', accountId: 'acc-cash', amount: 999, deleted: true }),
    ];

    // 1000 + 500 - 200 + 3000 - 800 = 3500
    expect(accountBalance(cash, txs)).toBe(3500);
    // 0 - 1500 + 800 = -700（待繳 700）
    expect(accountBalance(credit, txs)).toBe(-700);
  });
});

describe('groupByDay', () => {
  it('依日期由新到舊分組並計算當日收支小計（排除轉帳與已刪除）', () => {
    const txs: Transaction[] = [
      makeTx({ id: '1', kind: 'expense', date: '2026-11-10', amount: 150, updatedAt: 100 }),
      makeTx({ id: '2', kind: 'income', date: '2026-11-12', amount: 2000, categoryId: 'cat-2', updatedAt: 200 }),
      makeTx({ id: '3', kind: 'expense', date: '2026-11-12', amount: 300, updatedAt: 300 }),
      makeTx({
        id: '4',
        kind: 'transfer',
        date: '2026-11-12',
        amount: 5000,
        toAccountId: 'acc-bank',
        categoryId: null,
        updatedAt: 400,
      }),
      makeTx({ id: '5', kind: 'expense', date: '2026-11-10', amount: 999, deleted: true }),
    ];

    const groups = groupByDay(txs);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.date).toBe('2026-11-12');
    expect(groups[0]?.expenseTotal).toBe(300);
    expect(groups[0]?.incomeTotal).toBe(2000);
    expect(groups[0]?.transactions.map((t) => t.id)).toEqual(['4', '3', '2']);

    expect(groups[1]?.date).toBe('2026-11-10');
    expect(groups[1]?.expenseTotal).toBe(150);
    expect(groups[1]?.incomeTotal).toBe(0);
  });
});

describe('validateTransaction', () => {
  it('合法的支出、收入與轉帳回傳空陣列', () => {
    expect(
      validateTransaction({
        kind: 'expense',
        date: '2026-11-26',
        amount: 120,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
      }),
    ).toEqual([]);

    expect(
      validateTransaction({
        kind: 'transfer',
        date: '2026-11-26',
        amount: 5000,
        accountId: 'acc-1',
        toAccountId: 'acc-2',
        categoryId: null,
      }),
    ).toEqual([]);
  });

  it('檢查金額非正整數、缺少欄位與轉帳規則錯誤', () => {
    expect(
      validateTransaction({
        kind: 'expense',
        date: '2026-11-26',
        amount: 0,
        accountId: '',
        toAccountId: 'acc-2',
        categoryId: null,
      }),
    ).toEqual(['金額需為正整數', '請選擇帳戶', '請選擇分類', '一般收支不應指定轉入帳戶']);

    expect(
      validateTransaction({
        kind: 'expense',
        date: '2026-11-26',
        amount: 12.5,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
      }),
    ).toEqual(['金額需為正整數']);

    expect(
      validateTransaction({
        kind: 'transfer',
        date: '2026-11-26',
        amount: 500,
        accountId: 'acc-1',
        toAccountId: 'acc-1',
        categoryId: 'cat-1',
      }),
    ).toEqual(['轉出與轉入帳戶不可相同', '轉帳不應指定分類']);

    expect(
      validateTransaction({
        kind: 'transfer',
        date: 'invalid',
        amount: -10,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: null,
      }),
    ).toEqual(['金額需為正整數', '請選擇有效的日期', '請選擇轉入帳戶']);
  });
});

describe('categoryBreakdown', () => {
  it('子分類併入父分類、依金額由大到小排序並排除轉帳與已刪除紀錄', () => {
    const categories: Category[] = [
      { id: 'cat-food', name: '飲食', icon: '🍽️', kind: 'expense', parentId: null, sortOrder: 1, archived: false, ...baseMeta },
      { id: 'cat-lunch', name: '午餐', icon: '🍱', kind: 'expense', parentId: 'cat-food', sortOrder: 1, archived: false, ...baseMeta },
      { id: 'cat-dinner', name: '晚餐', icon: '🍜', kind: 'expense', parentId: 'cat-food', sortOrder: 2, archived: false, ...baseMeta },
      { id: 'cat-traffic', name: '交通', icon: '🚇', kind: 'expense', parentId: null, sortOrder: 2, archived: false, ...baseMeta },
      { id: 'cat-salary', name: '薪資', icon: '💰', kind: 'income', parentId: null, sortOrder: 1, archived: false, ...baseMeta },
    ];

    const txs: Transaction[] = [
      makeTx({ id: '1', kind: 'expense', date: '2026-11-01', amount: 150, categoryId: 'cat-lunch' }),
      makeTx({ id: '2', kind: 'expense', date: '2026-11-02', amount: 250, categoryId: 'cat-dinner' }),
      makeTx({ id: '3', kind: 'expense', date: '2026-11-03', amount: 600, categoryId: 'cat-traffic' }),
      makeTx({ id: '4', kind: 'transfer', date: '2026-11-04', amount: 5000, toAccountId: 'acc-bank', categoryId: null }),
      makeTx({ id: '5', kind: 'income', date: '2026-11-05', amount: 40000, categoryId: 'cat-salary' }),
      makeTx({ id: '6', kind: 'expense', date: '2026-11-06', amount: 999, categoryId: 'cat-traffic', deleted: true }),
      makeTx({ id: '7', kind: 'expense', date: '2026-10-31', amount: 800, categoryId: 'cat-food' }),
    ];

    expect(categoryBreakdown(txs, categories, '2026-11')).toEqual([
      { categoryId: 'cat-traffic', name: '交通', icon: '🚇', amount: 600, percentage: 60 },
      { categoryId: 'cat-food', name: '飲食', icon: '🍽️', amount: 400, percentage: 40 },
    ]);
  });
});

describe('monthlyTrend', () => {
  it('支援跨年往前推 12 個月、無資料月份補 0 且排除轉帳', () => {
    const txs: Transaction[] = [
      makeTx({ id: '1', kind: 'income', date: '2025-12-15', amount: 30000, categoryId: 'cat-salary' }),
      makeTx({ id: '2', kind: 'expense', date: '2025-12-20', amount: 5000 }),
      makeTx({ id: '3', kind: 'expense', date: '2026-02-10', amount: 1200 }),
      makeTx({ id: '4', kind: 'transfer', date: '2026-02-11', amount: 9000, toAccountId: 'acc-bank', categoryId: null }),
      makeTx({ id: '5', kind: 'expense', date: '2026-02-12', amount: 777, deleted: true }),
    ];

    const trend = monthlyTrend(txs, '2026-03', 12);
    expect(trend).toHaveLength(12);
    expect(trend[0]).toEqual({ month: '2025-04', income: 0, expense: 0 });
    expect(trend[8]).toEqual({ month: '2025-12', income: 30000, expense: 5000 });
    expect(trend[10]).toEqual({ month: '2026-02', income: 0, expense: 1200 });
    expect(trend[11]).toEqual({ month: '2026-03', income: 0, expense: 0 });
  });
});

describe('toCsv', () => {
  it('輸出含 UTF-8 BOM、正確欄位順序與特殊字元跳脫，並依日期新到舊排序', () => {
    const accounts: Account[] = [
      { id: 'acc-cash', name: '現金', type: 'cash', initialBalance: 0, archived: false, sortOrder: 1, ...baseMeta },
      { id: 'acc-bank', name: '銀行,帳戶', type: 'bank', initialBalance: 0, archived: false, sortOrder: 2, ...baseMeta },
    ];
    const categories: Category[] = [
      { id: 'cat-food', name: '飲食', icon: '🍽️', kind: 'expense', parentId: null, sortOrder: 1, archived: false, ...baseMeta },
      { id: 'cat-lunch', name: '午餐', icon: '🍱', kind: 'expense', parentId: 'cat-food', sortOrder: 1, archived: false, ...baseMeta },
    ];
    const txs: Transaction[] = [
      makeTx({
        id: '1',
        kind: 'expense',
        date: '2026-11-01',
        amount: 120,
        accountId: 'acc-cash',
        categoryId: 'cat-lunch',
        note: '便當, 加"蛋"\n外帶',
      }),
      makeTx({
        id: '2',
        kind: 'transfer',
        date: '2026-11-05',
        amount: 3000,
        accountId: 'acc-bank',
        toAccountId: 'acc-cash',
        categoryId: null,
        note: null,
      }),
      makeTx({
        id: '3',
        kind: 'expense',
        date: '2026-11-06',
        amount: 999,
        deleted: true,
      }),
    ];

    const csv = toCsv(txs, categories, accounts);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const content = csv.slice(1);
    expect(content).toBe(
      [
        '日期,類型,金額,分類,子分類,帳戶,轉入帳戶,備註',
        '2026-11-05,轉帳,3000,,,"銀行,帳戶",現金,',
        '2026-11-01,支出,120,飲食,午餐,現金,,"便當, 加""蛋""\n外帶"',
      ].join('\n'),
    );
  });
});

describe('mergeBackup', () => {
  it('同 id 取 updatedAt 較新者，並保留雙方獨有紀錄', () => {
    const existing: Account[] = [
      { id: 'a1', name: '舊名稱', type: 'cash', initialBalance: 100, archived: false, sortOrder: 1, updatedAt: 100, deviceId: 'd1', deleted: false },
      { id: 'a2', name: '本地獨有', type: 'bank', initialBalance: 200, archived: false, sortOrder: 2, updatedAt: 200, deviceId: 'd1', deleted: false },
      { id: 'a3', name: '本地較新', type: 'credit', initialBalance: 0, archived: false, sortOrder: 3, updatedAt: 500, deviceId: 'd1', deleted: false },
    ];
    const incoming: Account[] = [
      { id: 'a1', name: '新名稱', type: 'cash', initialBalance: 150, archived: false, sortOrder: 1, updatedAt: 300, deviceId: 'd2', deleted: false },
      { id: 'a3', name: '匯入較舊', type: 'credit', initialBalance: 0, archived: false, sortOrder: 3, updatedAt: 400, deviceId: 'd2', deleted: false },
      { id: 'a4', name: '匯入獨有', type: 'cash', initialBalance: 50, archived: false, sortOrder: 4, updatedAt: 250, deviceId: 'd2', deleted: false },
    ];

    const merged = mergeBackup(existing, incoming);
    const byId = new Map(merged.map((item) => [item.id, item]));
    expect(merged).toHaveLength(4);
    expect(byId.get('a1')?.name).toBe('新名稱');
    expect(byId.get('a2')?.name).toBe('本地獨有');
    expect(byId.get('a3')?.name).toBe('本地較新');
    expect(byId.get('a4')?.name).toBe('匯入獨有');
  });
});
