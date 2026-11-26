import { describe, expect, it } from 'vitest';
import { isValidCarrier, normalizeCarrier, pickCardColor } from './carrier';

describe('carrier', () => {
  it('normalizeCarrier 會將小寫轉大寫、全形轉半形並移除空白', () => {
    expect(normalizeCarrier('/abc1234')).toBe('/ABC1234');
    expect(normalizeCarrier(' ／ａｂｃ １２３４　')).toBe('/ABC1234');
    expect(normalizeCarrier('／ＡＢ－１２＋．３')).toBe('/AB-12+.3');
  });

  it('isValidCarrier 正確驗證合法與不合法手機條碼', () => {
    expect(isValidCarrier('/ABC1234')).toBe(true);
    expect(isValidCarrier('/0A.-+9Z')).toBe(true);

    // 缺少開頭 /
    expect(isValidCarrier('ABC12345')).toBe(false);
    // 長度錯誤
    expect(isValidCarrier('/ABC123')).toBe(false);
    expect(isValidCarrier('/ABC12345')).toBe(false);
    // 小寫或非法字元
    expect(isValidCarrier('/abc1234')).toBe(false);
    expect(isValidCarrier('/ABC123*')).toBe(false);
    expect(isValidCarrier('/ABC_123')).toBe(false);
    expect(isValidCarrier('/ABC 123')).toBe(false);
  });

  it('pickCardColor 依名稱穩定回傳色碼', () => {
    const c1 = pickCardColor('全聯福利卡');
    const c2 = pickCardColor('全聯福利卡');
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
