import { describe, expect, it } from 'vitest';
import type { Account, Transaction } from '../db/types';
import { accountBalance, groupByDay, monthSummary, validateTransaction } from './index';

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
