export type BarcodeFormat = 'code39' | 'code128' | 'ean13' | 'qr';

const CODE39_PATTERNS: Record<string, readonly number[]> = {
  '0': [1, 1, 1, 3, 3, 1, 3, 1, 1],
  '1': [3, 1, 1, 3, 1, 1, 1, 1, 3],
  '2': [1, 1, 3, 3, 1, 1, 1, 1, 3],
  '3': [3, 1, 3, 3, 1, 1, 1, 1, 1],
  '4': [1, 1, 1, 3, 3, 1, 1, 1, 3],
  '5': [3, 1, 1, 3, 3, 1, 1, 1, 1],
  '6': [1, 1, 3, 3, 3, 1, 1, 1, 1],
  '7': [1, 1, 1, 3, 1, 1, 3, 1, 3],
  '8': [3, 1, 1, 3, 1, 1, 3, 1, 1],
  '9': [1, 1, 3, 3, 1, 1, 3, 1, 1],
  A: [3, 1, 1, 1, 1, 3, 1, 1, 3],
  B: [1, 1, 3, 1, 1, 3, 1, 1, 3],
  C: [3, 1, 3, 1, 1, 3, 1, 1, 1],
  D: [1, 1, 1, 1, 3, 3, 1, 1, 3],
  E: [3, 1, 1, 1, 3, 3, 1, 1, 1],
  F: [1, 1, 3, 1, 3, 3, 1, 1, 1],
  G: [1, 1, 1, 1, 1, 3, 3, 1, 3],
  H: [3, 1, 1, 1, 1, 3, 3, 1, 1],
  I: [1, 1, 3, 1, 1, 3, 3, 1, 1],
  J: [1, 1, 1, 1, 3, 3, 3, 1, 1],
  K: [3, 1, 1, 1, 1, 1, 1, 3, 3],
  L: [1, 1, 3, 1, 1, 1, 1, 3, 3],
  M: [3, 1, 3, 1, 1, 1, 1, 3, 1],
  N: [1, 1, 1, 1, 3, 1, 1, 3, 3],
  O: [3, 1, 1, 1, 3, 1, 1, 3, 1],
  P: [1, 1, 3, 1, 3, 1, 1, 3, 1],
  Q: [1, 1, 1, 1, 1, 1, 3, 3, 3],
  R: [3, 1, 1, 1, 1, 1, 3, 3, 1],
  S: [1, 1, 3, 1, 1, 1, 3, 3, 1],
  T: [1, 1, 1, 1, 3, 1, 3, 3, 1],
  U: [3, 3, 1, 1, 1, 1, 1, 1, 3],
  V: [1, 3, 3, 1, 1, 1, 1, 1, 3],
  W: [3, 3, 3, 1, 1, 1, 1, 1, 1],
  X: [1, 3, 1, 1, 3, 1, 1, 1, 3],
  Y: [3, 3, 1, 1, 3, 1, 1, 1, 1],
  Z: [1, 3, 3, 1, 3, 1, 1, 1, 1],
  '-': [1, 3, 1, 1, 1, 1, 3, 1, 3],
  '.': [3, 3, 1, 1, 1, 1, 3, 1, 1],
  ' ': [1, 3, 3, 1, 1, 1, 3, 1, 1],
  $: [1, 3, 1, 3, 1, 3, 1, 1, 1],
  '/': [1, 3, 1, 3, 1, 1, 1, 3, 1],
  '+': [1, 3, 1, 1, 1, 3, 1, 3, 1],
  '%': [1, 1, 1, 3, 1, 3, 1, 3, 1],
  '*': [1, 3, 1, 1, 3, 1, 3, 1, 1],
};

// Code 128 符號寬度表（索引 0–105 為 6 條碼寬度，106 為終止符 7 條碼寬度）
const CODE128_PATTERNS: readonly (readonly number[])[] = [
  [2, 1, 2, 2, 2, 2], [2, 2, 2, 1, 2, 2], [2, 2, 2, 2, 2, 1], [1, 2, 1, 2, 2, 3],
  [1, 2, 1, 3, 2, 2], [1, 3, 1, 2, 2, 2], [1, 2, 2, 2, 1, 3], [1, 2, 2, 3, 1, 2],
  [1, 3, 2, 2, 1, 2], [2, 2, 1, 2, 1, 3], [2, 2, 1, 3, 1, 2], [2, 3, 1, 2, 1, 2],
  [1, 1, 2, 2, 3, 2], [1, 2, 2, 1, 3, 2], [1, 2, 2, 2, 3, 1], [1, 1, 3, 2, 2, 2],
  [1, 2, 3, 1, 2, 2], [1, 2, 3, 2, 2, 1], [2, 2, 3, 2, 1, 1], [2, 2, 1, 1, 3, 2],
  [2, 2, 1, 2, 3, 1], [2, 1, 3, 2, 1, 2], [2, 2, 3, 1, 1, 2], [3, 1, 2, 1, 3, 1],
  [3, 1, 1, 2, 2, 2], [3, 2, 1, 1, 2, 2], [3, 2, 1, 2, 2, 1], [3, 1, 2, 2, 1, 2],
  [3, 2, 2, 1, 1, 2], [3, 2, 2, 2, 1, 1], [2, 1, 2, 1, 2, 3], [2, 1, 2, 3, 2, 1],
  [2, 3, 2, 1, 2, 1], [1, 1, 1, 3, 2, 3], [1, 3, 1, 1, 2, 3], [1, 3, 1, 3, 2, 1],
  [1, 1, 2, 3, 1, 3], [1, 3, 2, 1, 1, 3], [1, 3, 2, 3, 1, 1], [2, 1, 1, 3, 1, 3],
  [2, 3, 1, 1, 1, 3], [2, 3, 1, 3, 1, 1], [1, 1, 2, 1, 3, 3], [1, 1, 2, 3, 3, 1],
  [1, 3, 2, 1, 3, 1], [1, 1, 3, 1, 2, 3], [1, 1, 3, 3, 2, 1], [1, 3, 3, 1, 2, 1],
  [3, 1, 3, 1, 2, 1], [2, 1, 1, 3, 3, 1], [2, 3, 1, 1, 3, 1], [2, 1, 3, 1, 1, 3],
  [2, 1, 3, 3, 1, 1], [2, 1, 3, 1, 3, 1], [3, 1, 1, 1, 2, 3], [3, 1, 1, 3, 2, 1],
  [3, 3, 1, 1, 2, 1], [3, 1, 2, 1, 1, 3], [3, 1, 2, 3, 1, 1], [3, 3, 2, 1, 1, 1],
  [3, 1, 4, 1, 1, 1], [2, 2, 1, 4, 1, 1], [4, 3, 1, 1, 1, 1], [1, 1, 1, 2, 2, 4],
  [1, 1, 1, 4, 2, 2], [1, 2, 1, 1, 2, 4], [1, 2, 1, 4, 2, 1], [1, 4, 1, 1, 2, 2],
  [1, 4, 1, 2, 2, 1], [1, 1, 2, 2, 1, 4], [1, 1, 2, 4, 1, 2], [1, 2, 2, 1, 1, 4],
  [1, 2, 2, 4, 1, 1], [1, 4, 2, 1, 1, 2], [1, 4, 2, 2, 1, 1], [2, 4, 1, 2, 1, 1],
  [2, 2, 1, 1, 1, 4], [4, 1, 3, 1, 1, 1], [2, 4, 1, 1, 1, 2], [1, 3, 4, 1, 1, 1],
  [1, 1, 1, 2, 4, 2], [1, 2, 1, 1, 4, 2], [1, 2, 1, 2, 4, 1], [1, 1, 4, 2, 1, 2],
  [1, 2, 4, 1, 1, 2], [1, 2, 4, 2, 1, 1], [4, 1, 1, 2, 1, 2], [4, 2, 1, 1, 1, 2],
  [4, 2, 1, 2, 1, 1], [2, 1, 2, 1, 4, 1], [2, 1, 4, 1, 2, 1], [4, 1, 2, 1, 2, 1],
  [1, 1, 1, 1, 4, 3], [1, 1, 1, 3, 4, 1], [1, 3, 1, 1, 4, 1], [1, 1, 4, 1, 1, 3],
  [1, 1, 4, 3, 1, 1], [4, 1, 1, 1, 1, 3], [4, 1, 1, 3, 1, 1], [1, 1, 3, 1, 4, 1],
  [1, 1, 4, 1, 3, 1], [3, 1, 1, 1, 4, 1], [4, 1, 1, 1, 3, 1], [2, 1, 1, 4, 1, 2],
  [2, 1, 1, 2, 1, 4], [2, 1, 1, 2, 3, 2], [2, 3, 3, 1, 1, 1, 2],
];

// EAN-13 左半部 L-code（空白起頭、黑條結尾）
const EAN_L_CODES: readonly (readonly number[])[] = [
  [3, 2, 1, 1],
  [2, 2, 2, 1],
  [2, 1, 2, 2],
  [1, 4, 1, 1],
  [1, 1, 3, 2],
  [1, 2, 3, 1],
  [1, 1, 1, 4],
  [1, 3, 1, 2],
  [1, 2, 1, 3],
  [3, 1, 1, 2],
];

// EAN-13 左半部 G-code（空白起頭、黑條結尾，為 L-code 的反序）
const EAN_G_CODES: readonly (readonly number[])[] = EAN_L_CODES.map((pat) => [...pat].reverse());

// EAN-13 右半部 R-code（黑條起頭、空白結尾，與 L-code 寬度相同但黑白反轉）
const EAN_R_CODES = EAN_L_CODES;

// 依首位數字決定的左側 6 碼 L/G 組合（0=L, 1=G）
const EAN13_PARITY: readonly string[] = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

const CODE39_DATA_PATTERN = /^[0-9A-Z \-.$/+%]+$/;

/**
 * 將字串編碼為 Code 39 黑白條寬度陣列（含起止字元 `*` 與字元間窄間隔）
 */
export function encodeCode39(text: string): number[] {
  if (!text) {
    throw new Error('Code 39 內容不可為空');
  }

  const full = `*${text}*`;
  const bars: number[] = [];

  for (let i = 0; i < full.length; i += 1) {
    const ch = full[i] ?? '';
    if (i > 0 && i < full.length - 1 && ch === '*') {
      throw new Error('Code 39 內容不可包含起止符號 *');
    }
    const pattern = CODE39_PATTERNS[ch];
    if (!pattern) {
      throw new Error(`Code 39 不支援的字元：${ch}`);
    }
    if (i > 0) {
      bars.push(1);
    }
    bars.push(...pattern);
  }

  return bars;
}

/**
 * 將可列印 ASCII 字串編碼為 Code 128（Code Set B，含檢查碼與起止符）
 */
export function encodeCode128(text: string): number[] {
  if (!text) {
    throw new Error('Code 128 內容不可為空');
  }

  const startB = 104;
  const stopCode = 106;
  const values: number[] = [startB];
  let checksum = startB;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 126) {
      throw new Error(`Code 128 不支援的字元：${text[i]}`);
    }
    const value = code - 32;
    values.push(value);
    checksum += (i + 1) * value;
  }

  values.push(checksum % 103);
  values.push(stopCode);

  const bars: number[] = [];
  for (const val of values) {
    const pat = CODE128_PATTERNS[val];
    if (pat) {
      bars.push(...pat);
    }
  }
  return bars;
}

/**
 * 計算 EAN-13 前 12 碼對應的檢查碼（0–9）
 */
export function computeEan13CheckDigit(twelveDigits: string): number {
  if (!/^\d{12}$/.test(twelveDigits)) {
    throw new Error('計算 EAN-13 檢查碼需要 12 位數字');
  }
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const d = twelveDigits.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * 檢查 13 位數字是否為檢查碼正確的 EAN-13
 */
export function isValidEan13(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false;
  return computeEan13CheckDigit(digits.slice(0, 12)) === digits.charCodeAt(12) - 48;
}

/**
 * 將 12 或 13 位數字編碼為 EAN-13 黑白條寬度陣列（12 碼自動補檢查碼，13 碼會驗證檢查碼）
 */
export function encodeEan13(digits: string): number[] {
  if (!/^\d{12,13}$/.test(digits)) {
    throw new Error('EAN-13 需要 12 或 13 位數字');
  }

  const normalized =
    digits.length === 12
      ? `${digits}${computeEan13CheckDigit(digits)}`
      : digits;

  if (!isValidEan13(normalized)) {
    throw new Error('EAN-13 檢查碼錯誤');
  }

  const firstDigit = normalized.charCodeAt(0) - 48;
  const parity = EAN13_PARITY[firstDigit] ?? 'LLLLLL';
  const bars: number[] = [1, 1, 1]; // 左側警戒線

  for (let i = 0; i < 6; i += 1) {
    const digit = normalized.charCodeAt(i + 1) - 48;
    const pat = parity[i] === 'L' ? EAN_L_CODES[digit] : EAN_G_CODES[digit];
    if (pat) {
      bars.push(...pat);
    }
  }

  bars.push(1, 1, 1, 1, 1); // 中央警戒線

  for (let i = 7; i < 13; i += 1) {
    const digit = normalized.charCodeAt(i) - 48;
    const pat = EAN_R_CODES[digit];
    if (pat) {
      bars.push(...pat);
    }
  }

  bars.push(1, 1, 1); // 右側警戒線
  return bars;
}

export interface BarcodeRect {
  x: number;
  width: number;
}

export interface BarcodeRenderOptions {
  height?: number;
  quietZone?: number;
  barColor?: string;
  backgroundColor?: string;
}

/**
 * 將黑白條寬度陣列轉為 SVG 矩形座標與總寬度（供 React 或 SVG 輸出使用）
 */
export function barcodeToRects(
  bars: readonly number[],
  quietZone = 10,
): { totalWidth: number; rects: BarcodeRect[] } {
  const rects: BarcodeRect[] = [];
  let cursor = quietZone;

  for (let i = 0; i < bars.length; i += 1) {
    const width = bars[i] ?? 0;
    if (i % 2 === 0 && width > 0) {
      rects.push({ x: cursor, width });
    }
    cursor += width;
  }

  return {
    totalWidth: cursor + quietZone,
    rects,
  };
}

/**
 * 將黑白條寬度陣列轉為完整 SVG 字串（含前後留白）
 */
export function barcodeToSvg(
  bars: readonly number[],
  options: BarcodeRenderOptions = {},
): string {
  const {
    height = 80,
    quietZone = 10,
    barColor = '#000000',
    backgroundColor = '#ffffff',
  } = options;

  const { totalWidth, rects } = barcodeToRects(bars, quietZone);
  const rectElements = rects
    .map((r) => `<rect x="${r.x}" y="0" width="${r.width}" height="${height}" fill="${barColor}"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${height}" shape-rendering="crispEdges"><rect width="${totalWidth}" height="${height}" fill="${backgroundColor}"/>${rectElements}</svg>`;
}

/**
 * 依條碼內容自動判斷最適合的一維／二維條碼格式
 */
export function guessFormat(code: string): BarcodeFormat {
  if (!code) return 'code128';

  if (code.length > 40) {
    return 'qr';
  }

  for (let i = 0; i < code.length; i += 1) {
    const ch = code.charCodeAt(i);
    if (ch < 32 || ch > 126) {
      return 'qr';
    }
  }

  if (isValidEan13(code)) {
    return 'ean13';
  }

  if (CODE39_DATA_PATTERN.test(code)) {
    return 'code39';
  }

  return 'code128';
}
