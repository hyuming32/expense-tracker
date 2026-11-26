import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEED_ACCOUNTS,
  DEFAULT_SEED_CATEGORIES,
  ExpenseDatabase,
  ensureSeeded,
} from '../db/database';
import { recordQuickTextTransaction, savePlace } from '../db/repository';
import type { Account, Category, Place } from '../db/types';
import { parseQuickText, type QuickTextContext } from './index';

function buildSeedAccounts(): Account[] {
  return DEFAULT_SEED_ACCOUNTS.map((a) => ({
    ...a,
    initialBalance: 0,
    archived: false,
    updatedAt: 1,
    deviceId: 'seed',
    deleted: false,
  }));
}

function buildSeedCategories(): Category[] {
  return DEFAULT_SEED_CATEGORIES.map((c) => ({
    ...c,
    archived: false,
    updatedAt: 1,
    deviceId: 'seed',
    deleted: false,
  }));
}

function createContext(overrides?: Partial<QuickTextContext>): QuickTextContext {
  return {
    accounts: buildSeedAccounts(),
    categories: buildSeedCategories(),
    places: [],
    notePresets: [],
    today: '2026-11-26',
    defaultAccountId: 'seed-acc-cash',
    ...overrides,
  };
}

describe('parseQuickText', () => {
  it('解析標準格式「午餐 牛肉麵 180」', () => {
    const res = parseQuickText('午餐 牛肉麵 180', createContext());
    expect(res).toEqual({
      kind: 'expense',
      amount: 180,
      categoryId: 'seed-cat-food-lunch',
      accountId: 'seed-acc-cash',
      toAccountId: null,
      placeId: null,
      note: '牛肉麵',
      tags: [],
      date: '2026-11-26',
      confidence: { category: true, amount: true },
    });
  });

  it('解析黏在一起的文字「午餐180」', () => {
    const res = parseQuickText('午餐180', createContext());
    expect(res.kind).toBe('expense');
    expect(res.amount).toBe(180);
    expect(res.categoryId).toBe('seed-cat-food-lunch');
    expect(res.note).toBeNull();
    expect(res.confidence).toEqual({ category: true, amount: true });
  });

  it('透過內建關鍵字表解析「咖啡 65」', () => {
    const res = parseQuickText('咖啡 65', createContext());
    expect(res.kind).toBe('expense');
    expect(res.amount).toBe(65);
    expect(res.categoryId).toBe('seed-cat-food-snack');
    expect(res.confidence).toEqual({ category: true, amount: true });
  });

  it('解析「昨天 計程車 250 信用卡」的日期、分類與信用卡帳戶', () => {
    const res = parseQuickText('昨天 計程車 250 信用卡', createContext());
    expect(res.kind).toBe('expense');
    expect(res.date).toBe('2026-11-25');
    expect(res.categoryId).toBe('seed-cat-transport');
    expect(res.amount).toBe(250);
    expect(res.accountId).toBe('seed-acc-credit');
    expect(res.confidence).toEqual({ category: true, amount: true });
  });

  it('解析「薪水 52000」為收入並對應薪資分類', () => {
    const res = parseQuickText('薪水 52000', createContext());
    expect(res.kind).toBe('income');
    expect(res.amount).toBe(52000);
    expect(res.categoryId).toBe('seed-cat-income-salary');
    expect(res.confidence).toEqual({ category: true, amount: true });
  });

  it('解析「領錢 3000」為銀行到現金的轉帳', () => {
    const res = parseQuickText('領錢 3000', createContext());
    expect(res.kind).toBe('transfer');
    expect(res.amount).toBe(3000);
    expect(res.accountId).toBe('seed-acc-bank');
    expect(res.toAccountId).toBe('seed-acc-cash');
    expect(res.categoryId).toBeNull();
    expect(res.confidence).toEqual({ category: true, amount: true });
  });

  it('解析「轉帳 現金 到 銀行 5000」為現金到銀行的轉帳', () => {
    const res = parseQuickText('轉帳 現金 到 銀行 5000', createContext());
    expect(res.kind).toBe('transfer');
    expect(res.amount).toBe(5000);
    expect(res.accountId).toBe('seed-acc-cash');
    expect(res.toAccountId).toBe('seed-acc-bank');
    expect(res.categoryId).toBeNull();
  });

  it('解析含千分位與貨幣單位的金額「1,200元 衣服」', () => {
    const res = parseQuickText('1,200元 衣服', createContext());
    expect(res.kind).toBe('expense');
    expect(res.amount).toBe(1200);
    expect(res.categoryId).toBe('seed-cat-clothing');
    expect(res.confidence).toEqual({ category: true, amount: true });
  });

  it('無數字時回傳 amount null 與 confidence.amount=false', () => {
    const res = parseQuickText('晚餐 滷肉飯', createContext());
    expect(res.amount).toBeNull();
    expect(res.categoryId).toBe('seed-cat-food-dinner');
    expect(res.note).toBe('滷肉飯');
    expect(res.confidence).toEqual({ category: true, amount: false });
  });

  it('對不到分類時使用「其他」且 confidence.category=false', () => {
    const res = parseQuickText('神秘消費 99', createContext());
    expect(res.amount).toBe(99);
    expect(res.categoryId).toBe('seed-cat-expense-other');
    expect(res.note).toBe('神秘消費');
    expect(res.confidence).toEqual({ category: false, amount: true });
  });

  it('解析「11/24 晚餐 120」（today=2026-11-26）為今年日期', () => {
    const res = parseQuickText('11/24 晚餐 120', createContext({ today: '2026-11-26' }));
    expect(res.date).toBe('2026-11-24');
    expect(res.categoryId).toBe('seed-cat-food-dinner');
    expect(res.amount).toBe(120);
  });

  it('解析「12/30 晚餐 120」（today=2026-11-26）晚於今天時取去年', () => {
    const res = parseQuickText('12/30 晚餐 120', createContext({ today: '2026-11-26' }));
    expect(res.date).toBe('2025-12-30');
    expect(res.categoryId).toBe('seed-cat-food-dinner');
    expect(res.amount).toBe(120);
  });

  it('比對常用地點名稱（不分大小寫、全半形）', () => {
    const places: Place[] = [
      {
        id: 'place-pxmart',
        name: '全聯',
        icon: '🛒',
        useCount: 5,
        lastUsedAt: 100,
        sortOrder: 1,
        archived: false,
        updatedAt: 1,
        deviceId: 'seed',
        deleted: false,
      },
    ];
    const res = parseQuickText('全聯 衛生紙 150', createContext({ places }));
    expect(res.placeId).toBe('place-pxmart');
    expect(res.categoryId).toBe('seed-cat-daily');
    expect(res.amount).toBe(150);
  });

  it('支援全形空白與全形數字「１８０」', () => {
    const res = parseQuickText('午餐　牛肉麵　１８０', createContext());
    expect(res.amount).toBe(180);
    expect(res.categoryId).toBe('seed-cat-food-lunch');
    expect(res.note).toBe('牛肉麵');
    expect(res.confidence).toEqual({ category: true, amount: true });
  });

  it('關鍵字表不對應已封存的分類', () => {
    const categories = buildSeedCategories().map((c) =>
      c.id === 'seed-cat-transport' ? { ...c, archived: true } : c,
    );
    const res = parseQuickText('計程車 250', createContext({ categories }));
    expect(res.categoryId).toBe('seed-cat-expense-other');
    expect(res.confidence.category).toBe(false);
  });

  it('解析句中多個 #標籤 且不計入備註', () => {
    const res = parseQuickText('晚餐 拉麵 #日本旅遊 #可報帳 1200', createContext());
    expect(res.categoryId).toBe('seed-cat-food-dinner');
    expect(res.amount).toBe(1200);
    expect(res.note).toBe('拉麵');
    expect(res.tags).toEqual(['日本旅遊', '可報帳']);
  });
});

describe('recordQuickTextTransaction 整合測試', () => {
  it('將解析結果正確寫入資料庫 transactions 與 outbox 並更新地點使用次數', async () => {
    const dbName = `quicktext-test-${Date.now()}-${Math.random()}`;
    const testDb = new ExpenseDatabase(dbName);
    await ensureSeeded(testDb);

    const place = await savePlace({ name: '7-ELEVEN', icon: '🏪' }, testDb);
    const [accounts, categories, places] = await Promise.all([
      testDb.accounts.toArray(),
      testDb.categories.toArray(),
      testDb.places.toArray(),
    ]);

    const parsed = parseQuickText('昨天 7-ELEVEN 咖啡 65 信用卡', {
      accounts,
      categories,
      places,
      today: '2026-11-26',
      defaultAccountId: 'seed-acc-cash',
    });

    const saved = await recordQuickTextTransaction(parsed, testDb);
    expect(saved.kind).toBe('expense');
    expect(saved.amount).toBe(65);
    expect(saved.date).toBe('2026-11-25');
    expect(saved.categoryId).toBe('seed-cat-food-snack');
    expect(saved.accountId).toBe('seed-acc-credit');
    expect(saved.placeId).toBe(place.id);
    expect(saved.deleted).toBe(false);

    const storedTx = await testDb.transactions.get(saved.id);
    expect(storedTx).toEqual(saved);

    const outboxEntry = await testDb.outbox.get(`transactions:${saved.id}`);
    expect(outboxEntry).toBeDefined();
    expect(outboxEntry?.recordId).toBe(saved.id);

    const updatedPlace = await testDb.places.get(place.id);
    expect(updatedPlace?.useCount).toBe(1);

    await testDb.delete();
  });
});
