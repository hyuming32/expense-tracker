import { describe, expect, it } from 'vitest';
import type { Category, Transaction } from '../db/types';
import { collectRecentTags, normalizeTag, normalizeTags, summarizeAllTags, summarizeByTag } from './tags';

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: overrides.id ?? 'tx-1',
    kind: overrides.kind ?? 'expense',
    date: overrides.date ?? '2026-11-26',
    time: overrides.time ?? null,
    amount: overrides.amount ?? 100,
    accountId: overrides.accountId ?? 'acc-1',
    toAccountId: overrides.toAccountId ?? null,
    categoryId: overrides.categoryId ?? null,
    placeId: overrides.placeId ?? null,
    note: overrides.note ?? null,
    tags: overrides.tags,
    updatedAt: overrides.updatedAt ?? 1000,
    deviceId: overrides.deviceId ?? 'dev-1',
    deleted: overrides.deleted ?? false,
  };
}

function makeCat(overrides: Partial<Category>): Category {
  return {
    id: overrides.id ?? 'cat-1',
    name: overrides.name ?? '飲食',
    icon: overrides.icon ?? '🍽️',
    kind: overrides.kind ?? 'expense',
    parentId: overrides.parentId ?? null,
    sortOrder: overrides.sortOrder ?? 1,
    archived: overrides.archived ?? false,
    updatedAt: overrides.updatedAt ?? 1000,
    deviceId: overrides.deviceId ?? 'dev-1',
    deleted: overrides.deleted ?? false,
  };
}

describe('tags domain', () => {
  it('normalizeTag 會修剪空白、去掉開頭 #、全形空白轉半形並限制最長 20 字', () => {
    expect(normalizeTag('  #日本旅遊　')).toBe('日本旅遊');
    expect(normalizeTag('###可報帳')).toBe('可報帳');
    expect(normalizeTag('＃東京 自由行　')).toBe('東京 自由行');
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('#   ')).toBeNull();
    expect(normalizeTag('1234567890123456789012345')).toBe('12345678901234567890');
  });

  it('normalizeTags 會不分大小寫去重保留第一次寫法，且最多 5 個', () => {
    const result = normalizeTags([
      ' #Japan ',
      'japan',
      '可報帳',
      '  ',
      'Tag3',
      'Tag4',
      'Tag5',
      'Tag6',
    ]);
    expect(result).toEqual(['Japan', '可報帳', 'Tag3', 'Tag4', 'Tag5']);
  });

  it('collectRecentTags 依最近使用排序並排除已刪除交易', () => {
    const txs = [
      makeTx({ id: '1', date: '2026-11-20', tags: ['舊標籤', '共同'] }),
      makeTx({ id: '2', date: '2026-11-25', tags: ['日本旅遊', '共同'] }),
      makeTx({ id: '3', date: '2026-11-26', tags: ['已刪除交易標籤'], deleted: true }),
      makeTx({ id: '4', date: '2026-11-24', tags: ['可報帳', 'japan'] }),
      makeTx({ id: '5', date: '2026-11-23', tags: ['JAPAN', '交通'] }),
    ];

    expect(collectRecentTags(txs, 8)).toEqual([
      '日本旅遊',
      '共同',
      '可報帳',
      'japan',
      '交通',
      '舊標籤',
    ]);
    expect(collectRecentTags(txs, 3)).toEqual(['日本旅遊', '共同', '可報帳']);
  });

  it('summarizeByTag 只算未刪除交易，支出收入分開並依主分類彙整分布', () => {
    const categories = [
      makeCat({ id: 'cat-food', name: '飲食', icon: '🍽️' }),
      makeCat({ id: 'cat-dinner', name: '晚餐', icon: '🍜', parentId: 'cat-food' }),
      makeCat({ id: 'cat-transport', name: '交通', icon: '🚇' }),
      makeCat({ id: 'cat-salary', name: '薪資', icon: '💰', kind: 'income' }),
    ];

    const txs = [
      makeTx({
        id: '1',
        kind: 'expense',
        date: '2026-11-10',
        amount: 1200,
        categoryId: 'cat-dinner',
        tags: ['日本旅遊', '可報帳'],
      }),
      makeTx({
        id: '2',
        kind: 'expense',
        date: '2026-11-12',
        amount: 800,
        categoryId: 'cat-transport',
        tags: ['日本旅遊'],
      }),
      makeTx({
        id: '3',
        kind: 'income',
        date: '2026-11-15',
        amount: 500,
        categoryId: 'cat-salary',
        tags: ['日本旅遊'],
      }),
      makeTx({
        id: '4',
        kind: 'expense',
        date: '2026-11-16',
        amount: 9999,
        categoryId: 'cat-food',
        tags: ['日本旅遊'],
        deleted: true,
      }),
      makeTx({
        id: '5',
        kind: 'expense',
        date: '2026-11-18',
        amount: 300,
        categoryId: 'cat-food',
        tags: ['其他標籤'],
      }),
    ];

    const summary = summarizeByTag(txs, '#日本旅遊', categories);
    expect(summary.tag).toBe('日本旅遊');
    expect(summary.expenseTotal).toBe(2000);
    expect(summary.incomeTotal).toBe(500);
    expect(summary.count).toBe(3);
    expect(summary.dateRange).toEqual({ start: '2026-11-10', end: '2026-11-15' });
    expect(summary.categoryBreakdown).toEqual([
      { categoryId: 'cat-food', name: '飲食', icon: '🍽️', amount: 1200, percentage: 60 },
      { categoryId: 'cat-transport', name: '交通', icon: '🚇', amount: 800, percentage: 40 },
    ]);
  });

  it('summarizeAllTags 會列出所有未刪除交易的標籤與總支出', () => {
    const txs = [
      makeTx({ id: '1', kind: 'expense', date: '2026-11-10', amount: 500, tags: ['日本旅遊'] }),
      makeTx({ id: '2', kind: 'expense', date: '2026-11-11', amount: 1000, tags: ['可報帳', '日本旅遊'] }),
      makeTx({ id: '3', kind: 'expense', date: '2026-11-12', amount: 300, tags: ['已刪除'], deleted: true }),
    ];

    expect(summarizeAllTags(txs)).toEqual([
      { tag: '日本旅遊', expenseTotal: 1500, incomeTotal: 0, count: 2, lastDate: '2026-11-11' },
      { tag: '可報帳', expenseTotal: 1000, incomeTotal: 0, count: 1, lastDate: '2026-11-11' },
    ]);
  });
});
