import { describe, expect, it } from 'vitest';
import type { Account, Category, Place, Transaction } from '../db/types';
import {
  filterTransactions,
  summarizeFiltered,
  type TransactionFilterContext,
} from './index';

const baseMeta = {
  updatedAt: 1700000000000,
  deviceId: 'dev-1',
  deleted: false,
};

const accounts: Account[] = [
  {
    id: 'acc-cash',
    name: '現金錢包',
    type: 'cash',
    initialBalance: 1000,
    archived: false,
    sortOrder: 1,
    ...baseMeta,
  },
  {
    id: 'acc-bank',
    name: '玉山銀行',
    type: 'bank',
    initialBalance: 50000,
    archived: false,
    sortOrder: 2,
    ...baseMeta,
  },
];

const categories: Category[] = [
  {
    id: 'cat-food',
    name: '餐飲',
    icon: '🍜',
    kind: 'expense',
    parentId: null,
    sortOrder: 1,
    archived: false,
    ...baseMeta,
  },
  {
    id: 'cat-lunch',
    name: '午餐便當',
    icon: '🍱',
    kind: 'expense',
    parentId: 'cat-food',
    sortOrder: 2,
    archived: false,
    ...baseMeta,
  },
  {
    id: 'cat-salary',
    name: '薪水',
    icon: '💰',
    kind: 'income',
    parentId: null,
    sortOrder: 3,
    archived: false,
    ...baseMeta,
  },
];

const places: Place[] = [
  {
    id: 'place-711',
    name: '7-ELEVEN',
    icon: '🏪',
    useCount: 5,
    lastUsedAt: 1700000000000,
    sortOrder: 1,
    archived: false,
    ...baseMeta,
  },
  {
    id: 'place-cafe',
    name: '路易莎咖啡',
    icon: '☕',
    useCount: 3,
    lastUsedAt: 1700000000000,
    sortOrder: 2,
    archived: false,
    ...baseMeta,
  },
];

const ctx: TransactionFilterContext = {
  accountMap: new Map(accounts.map((a) => [a.id, a])),
  categoryMap: new Map(categories.map((c) => [c.id, c])),
  placeMap: new Map(places.map((p) => [p.id, p])),
};

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx-default',
    kind: 'expense',
    date: '2026-11-15',
    amount: 100,
    accountId: 'acc-cash',
    toAccountId: null,
    categoryId: 'cat-food',
    note: null,
    ...baseMeta,
    ...overrides,
  };
}

describe('filterTransactions', () => {
  const sampleTxs: Transaction[] = [
    makeTx({
      id: 'tx-nov-lunch',
      kind: 'expense',
      date: '2026-11-10',
      amount: 1200,
      accountId: 'acc-cash',
      categoryId: 'cat-lunch',
      placeId: 'place-711',
      note: '買咖啡與便當',
      tags: ['加班', '公司'],
      invoiceNo: 'AB12345678',
    }),
    makeTx({
      id: 'tx-nov-income',
      kind: 'income',
      date: '2026-11-05',
      amount: 50000,
      accountId: 'acc-bank',
      categoryId: 'cat-salary',
      note: '十一月薪資',
      tags: ['固定收入'],
    }),
    makeTx({
      id: 'tx-nov-transfer',
      kind: 'transfer',
      date: '2026-11-20',
      amount: 3000,
      accountId: 'acc-bank',
      toAccountId: 'acc-cash',
      categoryId: null,
      note: '提款補現金',
    }),
    makeTx({
      id: 'tx-oct-cafe',
      kind: 'expense',
      date: '2026-10-31',
      amount: 150,
      accountId: 'acc-cash',
      categoryId: 'cat-food',
      placeId: 'place-cafe',
      note: '早餐拿鐵',
      tags: ['咖啡'],
      invoiceNo: 'CD87654321',
    }),
    makeTx({
      id: 'tx-dec-start',
      kind: 'expense',
      date: '2026-12-01',
      amount: 500,
      accountId: 'acc-cash',
      categoryId: 'cat-food',
      note: '十二月第一筆',
    }),
    makeTx({
      id: 'tx-deleted',
      kind: 'expense',
      date: '2026-11-12',
      amount: 1200,
      accountId: 'acc-cash',
      categoryId: 'cat-food',
      note: '已刪除紀錄',
      deleted: true,
    }),
  ];

  it('一律排除已刪除紀錄，並支援月份、全部與自訂區間（含端點）', () => {
    const monthRes = filterTransactions(
      sampleTxs,
      { range: { kind: 'month', month: '2026-11' } },
      ctx,
    );
    expect(monthRes.map((t) => t.id)).toEqual(['tx-nov-lunch', 'tx-nov-income', 'tx-nov-transfer']);

    const allRes = filterTransactions(sampleTxs, { range: { kind: 'all' } }, ctx);
    expect(allRes.map((t) => t.id)).toEqual([
      'tx-nov-lunch',
      'tx-nov-income',
      'tx-nov-transfer',
      'tx-oct-cafe',
      'tx-dec-start',
    ]);

    const customRes = filterTransactions(
      sampleTxs,
      { range: { kind: 'custom', from: '2026-10-31', to: '2026-11-10' } },
      ctx,
    );
    expect(customRes.map((t) => t.id)).toEqual(['tx-nov-lunch', 'tx-nov-income', 'tx-oct-cafe']);
  });

  it('關鍵字可比對備註、標籤、#標籤、分類名、地點名、帳戶名、發票號碼與純數字金額', () => {
    const allRange = { kind: 'all' } as const;

    // 備註
    expect(
      filterTransactions(sampleTxs, { range: allRange, keyword: '拿鐵' }, ctx).map((t) => t.id),
    ).toEqual(['tx-oct-cafe']);

    // 標籤（一般關鍵字）
    expect(
      filterTransactions(sampleTxs, { range: allRange, keyword: '公司' }, ctx).map((t) => t.id),
    ).toEqual(['tx-nov-lunch']);

    // #標籤（只比對標籤，不比對備註中的「咖啡」）
    expect(
      filterTransactions(sampleTxs, { range: allRange, keyword: '#咖啡' }, ctx).map((t) => t.id),
    ).toEqual(['tx-oct-cafe']);

    // 分類名稱
    expect(
      filterTransactions(sampleTxs, { range: allRange, keyword: '薪水' }, ctx).map((t) => t.id),
    ).toEqual(['tx-nov-income']);

    // 地點名稱
    expect(
      filterTransactions(sampleTxs, { range: allRange, keyword: '7-eleven' }, ctx).map((t) => t.id),
    ).toEqual(['tx-nov-lunch']);

    // 帳戶名稱（含轉入帳戶）
    expect(
      filterTransactions(sampleTxs, { range: allRange, keyword: '玉山' }, ctx).map((t) => t.id),
    ).toEqual(['tx-nov-income', 'tx-nov-transfer']);

    // 發票號碼
    expect(
      filterTransactions(sampleTxs, { range: allRange, keyword: 'cd8765' }, ctx).map((t) => t.id),
    ).toEqual(['tx-oct-cafe']);

    // 純數字「1,200」比對金額完全相等
    expect(
      filterTransactions(sampleTxs, { range: allRange, keyword: '1,200' }, ctx).map((t) => t.id),
    ).toEqual(['tx-nov-lunch']);
  });

  it('關鍵字搜尋主分類名稱時，也會比對到使用其子分類的交易', () => {
    // tx-nov-lunch 的分類為子分類 cat-lunch（parent 為 cat-food「餐飲」）
    const res = filterTransactions(
      sampleTxs,
      { range: { kind: 'month', month: '2026-11' }, keyword: '餐飲' },
      ctx,
    );
    expect(res.map((t) => t.id)).toEqual(['tx-nov-lunch']);
  });

  it('支援多選類型篩選（空陣列代表全部）', () => {
    const res = filterTransactions(
      sampleTxs,
      { range: { kind: 'month', month: '2026-11' }, kinds: ['income', 'transfer'] },
      ctx,
    );
    expect(res.map((t) => t.id)).toEqual(['tx-nov-income', 'tx-nov-transfer']);
  });

  it('支援只填最小金額、只填最大金額或同時填寫（含端點）', () => {
    const allRange = { kind: 'all' } as const;

    expect(
      filterTransactions(sampleTxs, { range: allRange, minAmount: 3000 }, ctx).map((t) => t.id),
    ).toEqual(['tx-nov-income', 'tx-nov-transfer']);

    expect(
      filterTransactions(sampleTxs, { range: allRange, maxAmount: 500 }, ctx).map((t) => t.id),
    ).toEqual(['tx-oct-cafe', 'tx-dec-start']);

    expect(
      filterTransactions(
        sampleTxs,
        { range: allRange, minAmount: 500, maxAmount: 1200 },
        ctx,
      ).map((t) => t.id),
    ).toEqual(['tx-nov-lunch', 'tx-dec-start']);
  });

  it('選取主分類時會包含其子分類，選取帳戶時會包含轉入帳戶', () => {
    const allRange = { kind: 'all' } as const;

    // cat-food 為父分類，tx-nov-lunch 使用子分類 cat-lunch
    expect(
      filterTransactions(sampleTxs, { range: allRange, categoryId: 'cat-food' }, ctx).map(
        (t) => t.id,
      ),
    ).toEqual(['tx-nov-lunch', 'tx-oct-cafe', 'tx-dec-start']);

    // acc-cash 為 tx-nov-transfer 的 toAccountId
    expect(
      filterTransactions(sampleTxs, { range: allRange, accountId: 'acc-cash' }, ctx).map(
        (t) => t.id,
      ),
    ).toEqual(['tx-nov-lunch', 'tx-nov-transfer', 'tx-oct-cafe', 'tx-dec-start']);
  });

  it('支援有無發票篩選', () => {
    const allRange = { kind: 'all' } as const;

    expect(
      filterTransactions(sampleTxs, { range: allRange, invoice: 'with' }, ctx).map((t) => t.id),
    ).toEqual(['tx-nov-lunch', 'tx-oct-cafe']);

    expect(
      filterTransactions(sampleTxs, { range: allRange, invoice: 'without' }, ctx).map((t) => t.id),
    ).toEqual(['tx-nov-income', 'tx-nov-transfer', 'tx-dec-start']);
  });
});

describe('summarizeFiltered', () => {
  it('正確計算支出合計、收入合計與筆數（含轉帳筆數但不計入收支合計，排除已刪除）', () => {
    const list: Transaction[] = [
      makeTx({ id: '1', kind: 'expense', amount: 1200 }),
      makeTx({ id: '2', kind: 'expense', amount: 300 }),
      makeTx({ id: '3', kind: 'income', amount: 50000, categoryId: 'cat-salary' }),
      makeTx({
        id: '4',
        kind: 'transfer',
        amount: 3000,
        accountId: 'acc-bank',
        toAccountId: 'acc-cash',
        categoryId: null,
      }),
      makeTx({ id: '5', kind: 'expense', amount: 9999, deleted: true }),
    ];

    expect(summarizeFiltered(list)).toEqual({
      expenseTotal: 1500,
      incomeTotal: 50000,
      count: 4,
    });
  });
});
