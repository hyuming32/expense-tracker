import { afterEach, describe, expect, it } from 'vitest';
import type {
  Account,
  Budget,
  CurrencyRate,
  RecurringRule,
  Shortcut,
  Transaction,
} from '../db/types';
import {
  COMMON_CURRENCIES,
  convertToMain,
  evaluateExpression,
  formatCurrency,
  formatDisplayCurrency,
  formatMoney,
  getHiddenAmountText,
  getMainCurrency,
  HIDDEN_AMOUNT_TEXT,
  isValidRate,
  monthSummary,
  planMainCurrencySwitch,
  resolveAmountExpression,
  roundToDecimals,
  setDisplayCurrency,
  validateTransaction,
} from './index';

const baseMeta = {
  updatedAt: 1000,
  deviceId: 'dev-1',
  deleted: false,
};

afterEach(() => {
  setDisplayCurrency({ code: 'TWD', name: '新台幣', decimals: 0, symbol: 'NT$' }, []);
});

describe('roundToDecimals 與 convertToMain', () => {
  it('正確處理 0 與 2 位小數與浮點數誤差', () => {
    expect(roundToDecimals(123.4, 0)).toBe(123);
    expect(roundToDecimals(123.5, 0)).toBe(124);
    expect(roundToDecimals(-0.4, 0)).toBe(0);
    expect(roundToDecimals(1.005, 2)).toBe(1.01);
    expect(roundToDecimals(12.345, 2)).toBe(12.35);
    expect(roundToDecimals(12.344, 2)).toBe(12.34);

    // 21200 日圓 × 0.215 = 4558 台幣
    expect(convertToMain(21200, 0.215, 0)).toBe(4558);
    // 1000 日圓 × 0.00671875 = 6.72 美元
    expect(convertToMain(1000, 0.00671875, 2)).toBe(6.72);
    // 10.50 美元 × 32 = 336 台幣
    expect(convertToMain(10.5, 32, 0)).toBe(336);
  });
});

describe('getMainCurrency 與 COMMON_CURRENCIES', () => {
  it('無 isMain 記錄時預設回傳新台幣（TWD、小數 0）', () => {
    expect(getMainCurrency([])).toEqual({
      code: 'TWD',
      name: '新台幣',
      decimals: 0,
      symbol: 'NT$',
    });

    const jpyOnly: CurrencyRate[] = [
      {
        id: 'JPY',
        code: 'JPY',
        name: '日圓',
        rate: 0.215,
        decimals: 0,
        isMain: false,
        sortOrder: 1,
        archived: false,
        ...baseMeta,
      },
    ];
    expect(getMainCurrency(jpyOnly).code).toBe('TWD');
  });

  it('有 isMain 記錄時回傳該主幣別資訊且常用清單包含主要幣別', () => {
    const currencies: CurrencyRate[] = [
      {
        id: 'USD',
        code: 'USD',
        name: '美元',
        rate: 1,
        decimals: 2,
        isMain: true,
        sortOrder: 1,
        archived: false,
        ...baseMeta,
      },
    ];
    expect(getMainCurrency(currencies)).toEqual({
      code: 'USD',
      name: '美元',
      decimals: 2,
      symbol: 'US$',
    });
    expect(COMMON_CURRENCIES.map((c) => c.code)).toContain('TWD');
    expect(COMMON_CURRENCIES.map((c) => c.code)).toContain('JPY');
    expect(COMMON_CURRENCIES.map((c) => c.code)).toContain('USD');
  });
});

describe('isValidRate', () => {
  it('檢查正數且為有限數字（不限制小數位數）', () => {
    expect(isValidRate(32)).toBe(true);
    expect(isValidRate(0.215)).toBe(true);
    expect(isValidRate(0.000001)).toBe(true);
    expect(isValidRate(0.1234567)).toBe(true);
    expect(isValidRate(1 / 30.5)).toBe(true);
    expect(isValidRate(0.000039)).toBe(true);
    expect(isValidRate(0)).toBe(false);
    expect(isValidRate(-1.5)).toBe(false);
    expect(isValidRate(Number.NaN)).toBe(false);
    expect(isValidRate(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('validateTransaction 與 calc 小數位支援', () => {
  it('預設 decimals=0 維持正整數行為，decimals=2 允許兩位小數', () => {
    expect(
      validateTransaction({
        kind: 'expense',
        date: '2026-11-27',
        amount: 12.5,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
      }),
    ).toEqual(['金額需為正整數']);

    expect(
      validateTransaction(
        {
          kind: 'expense',
          date: '2026-11-27',
          amount: 12.5,
          accountId: 'acc-1',
          toAccountId: null,
          categoryId: 'cat-1',
        },
        2,
      ),
    ).toEqual([]);

    expect(
      validateTransaction(
        {
          kind: 'expense',
          date: '2026-11-27',
          amount: 12.345,
          accountId: 'acc-1',
          toAccountId: null,
          categoryId: 'cat-1',
        },
        2,
      ),
    ).toEqual(['金額最多 2 位小數']);

    expect(
      validateTransaction(
        {
          kind: 'expense',
          date: '2026-11-27',
          amount: 0,
          accountId: 'acc-1',
          toAccountId: null,
          categoryId: 'cat-1',
        },
        2,
      ),
    ).toEqual(['金額需為正數']);

    expect(evaluateExpression('10.5+2.25', 2)).toEqual({ ok: true, value: 12.75 });
    expect(resolveAmountExpression('10÷3', 2)).toEqual({ ok: true, value: 3.33 });
  });
});

describe('formatCurrency / formatDisplayCurrency / formatMoney', () => {
  it('TWD 預設維持既有輸出，切換主幣別為 USD 後正確顯示小數與符號，且可格式化原幣', () => {
    expect(formatCurrency(1234)).toBe('NT$1,234');
    expect(formatDisplayCurrency(1234, true)).toBe(HIDDEN_AMOUNT_TEXT);

    setDisplayCurrency({ code: 'USD', name: '美元', decimals: 2, symbol: 'US$' });
    expect(formatCurrency(12.5)).toBe('US$12.50');
    expect(formatCurrency(-8)).toBe('-US$8.00');
    expect(formatDisplayCurrency(12.5, true)).toBe('US$ ••••');
    expect(getHiddenAmountText('JPY')).toBe('¥ ••••');

    expect(formatMoney(21200, 'JPY')).toBe('¥21,200');
    expect(formatMoney(15.5, 'EUR')).toBe('€15.50');
  });
});

describe('planMainCurrencySwitch 切換主幣別換算', () => {
  it('TWD → USD (R=32) 正確換算台幣、日圓、美元三種交易與帳戶/預算/週期/捷徑，切回 TWD 後數值一致', () => {
    const transactions: Transaction[] = [
      {
        id: 'tx-twd',
        kind: 'expense',
        date: '2026-11-20',
        amount: 320,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: '午餐',
        ...baseMeta,
      },
      {
        id: 'tx-jpy',
        kind: 'expense',
        date: '2026-11-21',
        amount: 215,
        currency: 'JPY',
        originalAmount: 1000,
        rate: 0.215,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: '拉麵',
        ...baseMeta,
      },
      {
        id: 'tx-usd',
        kind: 'expense',
        date: '2026-11-22',
        amount: 320,
        currency: 'USD',
        originalAmount: 10,
        rate: 32,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: '訂閱',
        ...baseMeta,
      },
    ];

    const accounts: Account[] = [
      {
        id: 'acc-1',
        name: '銀行',
        type: 'bank',
        initialBalance: 32000,
        archived: false,
        sortOrder: 1,
        ...baseMeta,
      },
    ];
    const budgets: Budget[] = [
      { id: 'budget-total', categoryId: null, amount: 16000, ...baseMeta },
    ];
    const recurringRules: RecurringRule[] = [
      {
        id: 'rec-1',
        kind: 'expense',
        amount: 640,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: '月租',
        frequency: 'monthly',
        dayOfMonth: 1,
        weekday: 1,
        monthOfYear: 1,
        startDate: '2026-11-01',
        endDate: null,
        paused: false,
        autoPost: true,
        ...baseMeta,
      },
    ];
    const shortcuts: Shortcut[] = [
      {
        id: 'sc-fixed',
        label: '咖啡',
        icon: '☕',
        kind: 'expense',
        amount: 160,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: null,
        sortOrder: 1,
        ...baseMeta,
      },
      {
        id: 'sc-empty',
        label: '不定額',
        icon: '⚡',
        kind: 'expense',
        amount: null,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: null,
        sortOrder: 2,
        ...baseMeta,
      },
    ];
    const currencies: CurrencyRate[] = [
      {
        id: 'JPY',
        code: 'JPY',
        name: '日圓',
        rate: 0.215,
        decimals: 0,
        isMain: false,
        sortOrder: 1,
        archived: false,
        ...baseMeta,
      },
      {
        id: 'USD',
        code: 'USD',
        name: '美元',
        rate: 32,
        decimals: 2,
        isMain: false,
        sortOrder: 2,
        archived: false,
        ...baseMeta,
      },
    ];

    const toUsd = planMainCurrencySwitch({
      newCode: 'USD',
      newName: '美元',
      newDecimals: 2,
      rate: 32,
      transactions,
      accounts,
      budgets,
      recurringRules,
      shortcuts,
      currencies,
      now: 2000,
      deviceId: 'dev-1',
    });

    const twdTx = toUsd.transactions.find((t) => t.id === 'tx-twd');
    const jpyTx = toUsd.transactions.find((t) => t.id === 'tx-jpy');
    const usdTx = toUsd.transactions.find((t) => t.id === 'tx-usd');

    expect(twdTx).toMatchObject({
      currency: 'TWD',
      originalAmount: 320,
      rate: 1 / 32,
      amount: 10,
    });
    expect(jpyTx).toMatchObject({
      currency: 'JPY',
      originalAmount: 1000,
      rate: 0.215 / 32,
      amount: 6.72,
    });
    expect(usdTx).toMatchObject({
      currency: null,
      originalAmount: null,
      rate: null,
      amount: 10,
    });

    expect(toUsd.accounts[0]?.initialBalance).toBe(1000);
    expect(toUsd.budgets[0]?.amount).toBe(500);
    expect(toUsd.recurringRules[0]?.amount).toBe(20);
    expect(toUsd.shortcuts.find((s) => s.id === 'sc-fixed')?.amount).toBe(5);
    expect(toUsd.shortcuts.find((s) => s.id === 'sc-empty')?.amount).toBeNull();

    const curMap1 = new Map(toUsd.currencies.map((c) => [c.code, c]));
    expect(curMap1.get('USD')).toMatchObject({ isMain: true, rate: 1 });
    expect(curMap1.get('TWD')).toMatchObject({ isMain: false, rate: 1 / 32 });
    expect(curMap1.get('JPY')?.isMain).toBe(false);
    expect(curMap1.get('JPY')?.rate).toBeCloseTo(0.215 / 32, 8);

    // 再切回 TWD（1 TWD = 0.03125 USD）
    const backToTwd = planMainCurrencySwitch({
      newCode: 'TWD',
      rate: 0.03125,
      transactions: toUsd.transactions,
      accounts: toUsd.accounts,
      budgets: toUsd.budgets,
      recurringRules: toUsd.recurringRules,
      shortcuts: toUsd.shortcuts,
      currencies: toUsd.currencies,
      now: 3000,
      deviceId: 'dev-1',
    });

    const curMapBack = new Map(backToTwd.currencies.map((c) => [c.code, c]));
    expect(curMapBack.get('TWD')).toMatchObject({ isMain: true, rate: 1 });
    expect(curMapBack.get('USD')).toMatchObject({ isMain: false, rate: 32 });
    expect(curMapBack.get('JPY')?.rate).toBeCloseTo(0.215, 8);

    const twdTxBack = backToTwd.transactions.find((t) => t.id === 'tx-twd');
    const jpyTxBack = backToTwd.transactions.find((t) => t.id === 'tx-jpy');
    const usdTxBack = backToTwd.transactions.find((t) => t.id === 'tx-usd');

    expect(twdTxBack).toMatchObject({
      currency: null,
      originalAmount: null,
      rate: null,
      amount: 320,
    });
    expect(jpyTxBack).toMatchObject({
      currency: 'JPY',
      originalAmount: 1000,
      rate: 0.215,
      amount: 215,
    });
    expect(usdTxBack).toMatchObject({
      currency: 'USD',
      originalAmount: 10,
      rate: 32,
      amount: 320,
    });
    expect(backToTwd.accounts[0]?.initialBalance).toBe(32000);
    expect(backToTwd.budgets[0]?.amount).toBe(16000);
    expect(backToTwd.recurringRules[0]?.amount).toBe(640);
    expect(backToTwd.shortcuts.find((s) => s.id === 'sc-fixed')?.amount).toBe(160);

    // 報表可直接加總預先存好的 amount（包含舊資料無 currency 欄位）
    expect(monthSummary(backToTwd.transactions, '2026-11').expense).toBe(320 + 215 + 320);
  });
});
