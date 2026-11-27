import { describe, expect, it } from 'vitest';
import type { Account, Category, NotePreset, Place, Transaction } from '../db/types';
import {
  accountBalance,
  categoryBreakdown,
  categoryCompare,
  clipToElapsed,
  compareSummary,
  findPlaceBySellerId,
  getCurrentTimeString,
  groupByDay,
  mergeBackup,
  monthSummary,
  monthlyTrend,
  periodRange,
  periodSummary,
  periodTrend,
  placeBreakdownInRange,
  sameLastYear,
  selectQuickNotePresets,
  selectQuickPlaces,
  shiftPeriod,
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
        invoiceNo: 'AB12345678',
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
        '日期,時間,類型,金額,分類,子分類,帳戶,轉入帳戶,地點,備註,標籤,發票號碼,幣別,原幣金額,匯率',
        '2026-11-05,,轉帳,3000,,,"銀行,帳戶",現金,,,,,,,',
        '2026-11-01,,支出,120,飲食,午餐,現金,,,"便當, 加""蛋""\n外帶",,AB12345678,,,',
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

describe('periodRange / shiftPeriod / sameLastYear', () => {
  it('計算月、自然季與年的起訖日期，並支援跨年 Q4 與 Q1 切換', () => {
    const q4 = periodRange('quarter', '2025-11-15');
    expect(q4).toEqual({
      kind: 'quarter',
      start: '2025-10-01',
      end: '2025-12-31',
      label: '2025 年 第 4 季（10–12 月）',
    });

    const nextQ1 = shiftPeriod(q4, 1);
    expect(nextQ1).toEqual({
      kind: 'quarter',
      start: '2026-01-01',
      end: '2026-03-31',
      label: '2026 年 第 1 季（1–3 月）',
    });

    expect(shiftPeriod(nextQ1, -1)).toEqual(q4);

    expect(periodRange('month', '2026-11-26')).toEqual({
      kind: 'month',
      start: '2026-11-01',
      end: '2026-11-30',
      label: '2026 年 11 月',
    });

    expect(periodRange('year', '2026-11-26')).toEqual({
      kind: 'year',
      start: '2026-01-01',
      end: '2026-12-31',
      label: '2026 年',
    });
  });

  it('正確處理閏年 2/29 的去年同期', () => {
    const leapFeb = periodRange('month', '2024-02-29');
    expect(leapFeb.end).toBe('2024-02-29');

    const prevYearFeb = sameLastYear(leapFeb);
    expect(prevYearFeb).toEqual({
      kind: 'month',
      start: '2023-02-01',
      end: '2023-02-28',
      label: '2023 年 2 月',
    });

    const normalFeb = periodRange('month', '2025-02-10');
    expect(sameLastYear(normalFeb).end).toBe('2024-02-29');
  });
});

describe('clipToElapsed', () => {
  it('進行中期間將比較期裁切至相同已過天數，月底日數不同時以較短者為準', () => {
    const nov = periodRange('month', '2026-11-26');
    const oct = shiftPeriod(nov, -1);
    const clipped = clipToElapsed(nov, oct, '2026-11-26');

    expect(clipped.isInProgress).toBe(true);
    expect(clipped.range.end).toBe('2026-11-26');
    expect(clipped.compareRange.start).toBe('2026-10-01');
    expect(clipped.compareRange.end).toBe('2026-10-26');

    // 3/31 對比 2 月時，以較短的 2/28 為準
    const mar = periodRange('month', '2026-03-31');
    const feb = shiftPeriod(mar, -1);
    const clippedMar = clipToElapsed(mar, feb, '2026-03-31');
    expect(clippedMar.isInProgress).toBe(true);
    expect(clippedMar.range.end).toBe('2026-03-31');
    expect(clippedMar.compareRange.end).toBe('2026-02-28');

    // 已結束期間不裁切
    const past = clipToElapsed(oct, shiftPeriod(oct, -1), '2026-11-26');
    expect(past.isInProgress).toBe(false);
    expect(past.range.end).toBe('2026-10-31');
    expect(past.compareRange.end).toBe('2026-09-30');
  });
});

describe('periodSummary & compareSummary', () => {
  it('計算期間收支並排除轉帳與已刪除，比較期為 0 時 pct 為 null', () => {
    const range = periodRange('quarter', '2026-11-26');
    const txs: Transaction[] = [
      makeTx({ id: '1', kind: 'income', date: '2026-10-05', amount: 60000, categoryId: 'cat-salary' }),
      makeTx({ id: '2', kind: 'expense', date: '2026-11-10', amount: 15000 }),
      makeTx({
        id: '3',
        kind: 'transfer',
        date: '2026-11-15',
        amount: 20000,
        accountId: 'acc-bank',
        toAccountId: 'acc-cash',
        categoryId: null,
      }),
      makeTx({ id: '4', kind: 'expense', date: '2026-11-20', amount: 9999, deleted: true }),
      makeTx({ id: '5', kind: 'expense', date: '2026-09-30', amount: 5000 }),
    ];

    expect(periodSummary(txs, range)).toEqual({
      income: 60000,
      expense: 15000,
      net: 45000,
    });

    expect(compareSummary(1500, 0)).toEqual({ diff: 1500, pct: null });
    expect(compareSummary(0, 0)).toEqual({ diff: 0, pct: null });
    expect(compareSummary(1120, 1000)).toEqual({ diff: 120, pct: 12 });
    expect(compareSummary(950, 1000)).toEqual({ diff: -50, pct: -5 });
  });
});

describe('categoryCompare', () => {
  it('依增減金額絕對值由大到小排序、子分類併入父分類且不計入轉帳', () => {
    const categories: Category[] = [
      { id: 'cat-food', name: '飲食', icon: '🍽️', kind: 'expense', parentId: null, sortOrder: 1, archived: false, ...baseMeta },
      { id: 'cat-lunch', name: '午餐', icon: '🍱', kind: 'expense', parentId: 'cat-food', sortOrder: 1, archived: false, ...baseMeta },
      { id: 'cat-dinner', name: '晚餐', icon: '🍜', kind: 'expense', parentId: 'cat-food', sortOrder: 2, archived: false, ...baseMeta },
      { id: 'cat-traffic', name: '交通', icon: '🚇', kind: 'expense', parentId: null, sortOrder: 2, archived: false, ...baseMeta },
      { id: 'cat-salary', name: '薪資', icon: '💰', kind: 'income', parentId: null, sortOrder: 1, archived: false, ...baseMeta },
    ];

    const currentRange = periodRange('month', '2026-11-01');
    const prevRange = shiftPeriod(currentRange, -1);

    const txs: Transaction[] = [
      // 本期：飲食 500（午餐 300、晚餐 200），交通 100
      makeTx({ id: '1', kind: 'expense', date: '2026-11-05', amount: 300, categoryId: 'cat-lunch' }),
      makeTx({ id: '2', kind: 'expense', date: '2026-11-06', amount: 200, categoryId: 'cat-dinner' }),
      makeTx({ id: '3', kind: 'expense', date: '2026-11-07', amount: 100, categoryId: 'cat-traffic' }),
      // 轉帳與收入不計入
      makeTx({ id: '4', kind: 'transfer', date: '2026-11-08', amount: 50000, toAccountId: 'acc-bank', categoryId: null }),
      makeTx({ id: '5', kind: 'income', date: '2026-11-09', amount: 40000, categoryId: 'cat-salary' }),
      // 上期：飲食 200（午餐 200），交通 800 -> 交通 diff = -700（|diff|=700）應排第一，飲食 diff = +300 排第二
      makeTx({ id: '6', kind: 'expense', date: '2026-10-05', amount: 200, categoryId: 'cat-lunch' }),
      makeTx({ id: '7', kind: 'expense', date: '2026-10-10', amount: 800, categoryId: 'cat-traffic' }),
    ];

    const rows = categoryCompare(txs, categories, currentRange, prevRange);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      categoryId: 'cat-traffic',
      current: 100,
      previous: 800,
      diff: -700,
      pct: -87.5,
      children: [],
    });
    expect(rows[1]).toMatchObject({
      categoryId: 'cat-food',
      current: 500,
      previous: 200,
      diff: 300,
      pct: 150,
    });
    expect(rows[1]?.children).toEqual([
      {
        categoryId: 'cat-dinner',
        name: '晚餐',
        icon: '🍜',
        current: 200,
        previous: 0,
        diff: 200,
        pct: null,
      },
      {
        categoryId: 'cat-lunch',
        name: '午餐',
        icon: '🍱',
        current: 300,
        previous: 200,
        diff: 100,
        pct: 50,
      },
    ]);
  });
});

describe('periodTrend', () => {
  it('支援季模式最近 8 季與去年同期支出對照，並排除轉帳', () => {
    const endRange = periodRange('quarter', '2026-11-01');
    const txs: Transaction[] = [
      makeTx({ id: '1', kind: 'income', date: '2026-10-10', amount: 80000, categoryId: 'cat-salary' }),
      makeTx({ id: '2', kind: 'expense', date: '2026-10-12', amount: 12000 }),
      makeTx({ id: '3', kind: 'expense', date: '2025-11-05', amount: 9500 }),
      makeTx({ id: '4', kind: 'transfer', date: '2026-10-15', amount: 50000, toAccountId: 'acc-bank', categoryId: null }),
    ];

    const trend = periodTrend(txs, 'quarter', endRange, 8);
    expect(trend).toHaveLength(8);
    expect(trend[7]).toEqual({
      key: '2026-Q4',
      shortLabel: '26 Q4',
      label: '2026 年 第 4 季（10–12 月）',
      income: 80000,
      expense: 12000,
      lastYearExpense: 9500,
    });
  });
});

describe('selectQuickNotePresets', () => {
  const categories: Category[] = [
    { id: 'cat-food', name: '飲食', icon: '🍽️', kind: 'expense', parentId: null, sortOrder: 1, archived: false, ...baseMeta },
    { id: 'cat-lunch', name: '午餐', icon: '🍱', kind: 'expense', parentId: 'cat-food', sortOrder: 1, archived: false, ...baseMeta },
    { id: 'cat-transport', name: '交通', icon: '🚇', kind: 'expense', parentId: null, sortOrder: 2, archived: false, ...baseMeta },
  ];

  function makePreset(overrides: Partial<NotePreset>): NotePreset {
    return {
      id: 'p-1',
      text: '便當',
      categoryId: null,
      useCount: 1,
      lastUsedAt: 1000,
      sortOrder: 1,
      ...baseMeta,
      ...overrides,
    };
  }

  it('依分類（含父分類）優先、再依 useCount、lastUsedAt 排序，最多 12 個並排除已刪除', () => {
    const presets: NotePreset[] = [
      makePreset({ id: 'g-low', text: '全域少用', categoryId: null, useCount: 1, lastUsedAt: 5000 }),
      makePreset({ id: 'g-high', text: '全域常用', categoryId: null, useCount: 99, lastUsedAt: 9000 }),
      makePreset({ id: 'other-cat', text: '捷運', categoryId: 'cat-transport', useCount: 50 }),
      makePreset({ id: 'deleted-cat', text: '已刪除', categoryId: 'cat-lunch', useCount: 100, deleted: true }),
      makePreset({ id: 'parent-cat', text: '父分類備註', categoryId: 'cat-food', useCount: 3, lastUsedAt: 2000 }),
      makePreset({ id: 'exact-old', text: '子分類舊', categoryId: 'cat-lunch', useCount: 2, lastUsedAt: 1000 }),
      makePreset({ id: 'exact-new', text: '子分類新', categoryId: 'cat-lunch', useCount: 2, lastUsedAt: 3000 }),
    ];

    const result = selectQuickNotePresets({
      presets,
      categories,
      categoryId: 'cat-lunch',
    });

    expect(result.map((p) => p.id)).toEqual([
      'parent-cat',
      'exact-new',
      'exact-old',
      'g-high',
      'g-low',
    ]);

    const manyPresets = Array.from({ length: 15 }, (_, idx) =>
      makePreset({ id: `m-${idx}`, text: `備註-${idx}`, categoryId: null, useCount: 20 - idx }),
    );
    expect(selectQuickNotePresets({ presets: manyPresets, categories, categoryId: null })).toHaveLength(12);
  });

  it('支援依輸入文字即時包含篩選（不分大小寫）', () => {
    const presets: NotePreset[] = [
      makePreset({ id: '1', text: 'Starbucks 拿鐵', categoryId: 'cat-food' }),
      makePreset({ id: '2', text: '7-11 咖啡', categoryId: 'cat-food' }),
      makePreset({ id: '3', text: '牛肉麵', categoryId: 'cat-food' }),
    ];

    const filtered = selectQuickNotePresets({
      presets,
      categories,
      categoryId: 'cat-food',
      query: 'star',
    });
    expect(filtered.map((p) => p.id)).toEqual(['1']);
  });
});

describe('selectQuickPlaces 與地點輔助函式', () => {
  function makePlace(overrides: Partial<Place>): Place {
    return {
      id: 'pl-1',
      name: '公司附近',
      icon: '📍',
      useCount: 0,
      lastUsedAt: 0,
      sortOrder: 1,
      archived: false,
      ...baseMeta,
      ...overrides,
    };
  }

  it('依 useCount 由大到小、lastUsedAt 新到舊排序，最多 10 個並排除已停用與已刪除', () => {
    const places: Place[] = [
      makePlace({ id: 'archived', name: '已停用', useCount: 99, archived: true }),
      makePlace({ id: 'deleted', name: '已刪除', useCount: 99, deleted: true }),
      ...Array.from({ length: 12 }, (_, idx) =>
        makePlace({
          id: `p-${idx}`,
          name: `地點-${idx}`,
          useCount: idx === 0 || idx === 1 ? 5 : idx,
          lastUsedAt: idx === 0 ? 1000 : idx === 1 ? 3000 : idx * 100,
          sortOrder: idx + 1,
        }),
      ),
    ];

    const quick = selectQuickPlaces({ places });
    expect(quick).toHaveLength(10);
    expect(quick[0]?.id).toBe('p-11');
    const idx1 = quick.findIndex((p) => p.id === 'p-1');
    const idx0 = quick.findIndex((p) => p.id === 'p-0');
    expect(idx1).toBeLessThan(idx0);
    expect(quick.some((p) => p.id === 'archived' || p.id === 'deleted')).toBe(false);
  });

  it('停用地點不自動帶入，未停用地點可依統編自動帶入', () => {
    const places: Place[] = [
      makePlace({ id: 'p-arch', name: '停用店', archived: true, sellerIds: ['11112222'] }),
      makePlace({ id: 'p-active', name: '全聯', archived: false, sellerIds: ['33334444'] }),
    ];

    expect(findPlaceBySellerId(places, '11112222')).toBeUndefined();
    expect(findPlaceBySellerId(places, '33334444')?.id).toBe('p-active');
  });

  it('同日交易依時間由晚到早排序，無時間排在最後，再依 updatedAt', () => {
    const txs: Transaction[] = [
      makeTx({ id: 'no-time-old', date: '2026-11-26', time: null, updatedAt: 100 }),
      makeTx({ id: 'morning', date: '2026-11-26', time: '08:30', updatedAt: 500 }),
      makeTx({ id: 'no-time-new', date: '2026-11-26', time: null, updatedAt: 900 }),
      makeTx({ id: 'evening', date: '2026-11-26', time: '20:15', updatedAt: 200 }),
    ];

    const groups = groupByDay(txs);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.transactions.map((t) => t.id)).toEqual([
      'evening',
      'morning',
      'no-time-new',
      'no-time-old',
    ]);
  });

  it('placeBreakdownInRange 依地點彙總所選期間支出前 10 名', () => {
    const places: Place[] = Array.from({ length: 12 }, (_, idx) =>
      makePlace({ id: `pl-${idx}`, name: `地點${idx}` }),
    );
    const txs: Transaction[] = [
      ...places.map((p, idx) =>
        makeTx({
          id: `tx-${idx}`,
          kind: 'expense',
          date: '2026-11-10',
          amount: (idx + 1) * 100,
          placeId: p.id,
        }),
      ),
      makeTx({
        id: 'tx-transfer',
        kind: 'transfer',
        date: '2026-11-10',
        amount: 99999,
        toAccountId: 'acc-bank',
        categoryId: null,
        placeId: 'pl-0',
      }),
    ];

    const range = periodRange('month', '2026-11-01');
    const breakdown = placeBreakdownInRange(txs, places, range, 10);
    expect(breakdown).toHaveLength(10);
    expect(breakdown[0]?.placeId).toBe('pl-11');
    expect(breakdown[0]?.amount).toBe(1200);
    expect(breakdown[9]?.placeId).toBe('pl-2');
  });

  it('placeBreakdownInRange 未指定地點固定排在有地點項目之後且不佔前 10 名名額', () => {
    const places: Place[] = Array.from({ length: 12 }, (_, idx) =>
      makePlace({ id: `pl-${idx}`, name: `地點${idx}` }),
    );
    const txs: Transaction[] = [
      ...places.map((p, idx) =>
        makeTx({
          id: `tx-${idx}`,
          kind: 'expense',
          date: '2026-11-10',
          amount: (idx + 1) * 100,
          placeId: p.id,
        }),
      ),
      makeTx({
        id: 'tx-unspecified',
        kind: 'expense',
        date: '2026-11-12',
        amount: 50000, // 金額最大，仍應排在最後
        placeId: null,
      }),
    ];

    const range = periodRange('month', '2026-11-01');
    const breakdown = placeBreakdownInRange(txs, places, range, 10);
    expect(breakdown).toHaveLength(11);
    expect(breakdown[0]?.placeId).toBe('pl-11');
    expect(breakdown[9]?.placeId).toBe('pl-2');
    expect(breakdown[10]?.placeId).toBe('unspecified');
    expect(breakdown[10]?.name).toBe('未指定地點');
    expect(breakdown[10]?.amount).toBe(50000);
  });

  it('getCurrentTimeString 回傳 HH:mm 格式', () => {
    const dt = new Date(2026, 10, 26, 9, 5);
    expect(getCurrentTimeString(dt)).toBe('09:05');
  });
});
