import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOME_SECTION_KEYS,
  formatDisplayCurrency,
  HIDDEN_AMOUNT_TEXT,
  resolveHomeLayout,
} from './index';

describe('resolveHomeLayout', () => {
  it('空設定時回傳預設順序且全部顯示', () => {
    const result = resolveHomeLayout(null, DEFAULT_HOME_SECTION_KEYS);
    expect(result).toEqual(DEFAULT_HOME_SECTION_KEYS.map((key) => ({ key, visible: true })));

    const emptyResult = resolveHomeLayout([], DEFAULT_HOME_SECTION_KEYS);
    expect(emptyResult).toEqual(DEFAULT_HOME_SECTION_KEYS.map((key) => ({ key, visible: true })));
  });

  it('保留自訂順序與隱藏狀態', () => {
    const keys = ['a', 'b', 'c'] as const;
    const saved = [
      { key: 'c', visible: true },
      { key: 'a', visible: false },
      { key: 'b', visible: true },
    ];
    expect(resolveHomeLayout(saved, keys)).toEqual([
      { key: 'c', visible: true },
      { key: 'a', visible: false },
      { key: 'b', visible: true },
    ]);
  });

  it('新增的區塊會依預設順序插入並預設顯示', () => {
    const keys = ['a', 'b', 'c', 'd'] as const;
    const saved = [
      { key: 'c', visible: true },
      { key: 'a', visible: false },
    ];
    // 'b' 在預設順序中位於 'a' 之後；'d' 在 'c' 之後
    expect(resolveHomeLayout(saved, keys)).toEqual([
      { key: 'c', visible: true },
      { key: 'd', visible: true },
      { key: 'a', visible: false },
      { key: 'b', visible: true },
    ]);
  });

  it('忽略已不存在於 allKeys 的舊區塊 key', () => {
    const keys = ['a', 'b'] as const;
    const saved = [
      { key: 'removed_old', visible: true },
      { key: 'b', visible: false },
      { key: 'a', visible: true },
    ];
    expect(resolveHomeLayout(saved, keys)).toEqual([
      { key: 'b', visible: false },
      { key: 'a', visible: true },
    ]);
  });
});

describe('formatDisplayCurrency', () => {
  it('未隱藏時正常格式化金額，隱藏時一律輸出 NT$ ••••', () => {
    expect(formatDisplayCurrency(1234, false)).toBe('NT$1,234');
    expect(formatDisplayCurrency(-500, false)).toBe('-NT$500');
    expect(formatDisplayCurrency(1234, true)).toBe(HIDDEN_AMOUNT_TEXT);
    expect(formatDisplayCurrency(-500, true)).toBe(HIDDEN_AMOUNT_TEXT);
    expect(formatDisplayCurrency(0, true)).toBe(HIDDEN_AMOUNT_TEXT);
  });
});
