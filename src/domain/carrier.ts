/** 載具卡片的固定識別碼（確保多裝置同步不重複） */
export const CARRIER_CARD_ID = 'card-carrier';

/** 載具卡片固定名稱 */
export const CARRIER_CARD_NAME = '手機條碼';

/** 會員卡名稱最長字數 */
export const MEMBER_CARD_NAME_MAX_LENGTH = 20;

/** 會員卡預設配色清單 */
export const CARD_COLOR_PALETTE = [
  '#0f766e', // 深青
  '#1d4ed8', // 寶藍
  '#b45309', // 琥珀
  '#be123c', // 玫紅
  '#6d28d9', // 紫羅蘭
  '#15803d', // 翠綠
  '#334155', // 岩灰
  '#c2410c', // 橘紅
] as const;

const CARRIER_PATTERN = /^\/[0-9A-Z.\-+]{7}$/;

/**
 * 依卡片名稱穩定挑選一組預設底色
 */
export function pickCardColor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return CARD_COLOR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    hash = (hash * 31 + trimmed.charCodeAt(i)) >>> 0;
  }
  return CARD_COLOR_PALETTE[hash % CARD_COLOR_PALETTE.length] ?? CARD_COLOR_PALETTE[0];
}

/**
 * 將手機條碼載具輸入正規化：全形轉半形、移除空白、轉為大寫
 */
export function normalizeCarrier(input: string): string {
  let halfWidth = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0xff01 && code <= 0xff5e) {
      halfWidth += String.fromCharCode(code - 0xfee0);
    } else if (code === 0x3000) {
      halfWidth += ' ';
    } else {
      halfWidth += input[i];
    }
  }
  return halfWidth.replace(/\s+/g, '').toUpperCase();
}

/**
 * 檢查是否為合法的台灣電子發票手機條碼格式（/ 開頭加 7 碼 0-9 A-Z . - +）
 */
export function isValidCarrier(code: string): boolean {
  return CARRIER_PATTERN.test(code);
}
