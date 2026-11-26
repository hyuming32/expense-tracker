import { describe, expect, it } from 'vitest';
import {
  barcodeToRects,
  barcodeToSvg,
  computeEan13CheckDigit,
  encodeCode128,
  encodeCode39,
  encodeEan13,
  guessFormat,
} from './barcode';

describe('barcode', () => {
  describe('encodeCode39', () => {
    it('包含 * 起止符、正確的元素總數（(字元數+2)×10 - 1），且可編碼 /ABC1234', () => {
      const bars = encodeCode39('/ABC1234');
      // 8 個字元 + 2 個起止符 * = 10 個字元，每個 9 元素 + 9 個間隔 = 99
      expect(bars.length).toBe((8 + 2) * 10 - 1);
      // 起止字元 * 的條寬序列為 [1,3,1,1,3,1,3,1,1]
      const starPattern = [1, 3, 1, 1, 3, 1, 3, 1, 1];
      expect(bars.slice(0, 9)).toEqual(starPattern);
      expect(bars.slice(-9)).toEqual(starPattern);
    });

    it('已知字串 A 的條寬序列正確', () => {
      // * (9) + gap(1) + A(9) + gap(1) + *(9) = 29
      const bars = encodeCode39('A');
      expect(bars).toEqual([
        1, 3, 1, 1, 3, 1, 3, 1, 1, // *
        1, // gap
        3, 1, 1, 1, 1, 3, 1, 1, 3, // A
        1, // gap
        1, 3, 1, 1, 3, 1, 3, 1, 1, // *
      ]);
    });

    it('遇到不支援字元或空字串會拋錯', () => {
      expect(() => encodeCode39('')).toThrow();
      expect(() => encodeCode39('abc')).toThrow();
      expect(() => encodeCode39('A*B')).toThrow();
      expect(() => encodeCode39('中文')).toThrow();
    });
  });

  describe('encodeCode128', () => {
    it('Code Set B 檢查碼計算正確（已知範例 Wikipedia "Code 128"）', () => {
      // Start B (104) + "Code 128"
      // C=35, o=79, d=68, e=69, ' '=0, 1=17, 2=18, 8=24
      // 104 + 1*35 + 2*79 + 3*68 + 4*69 + 5*0 + 6*17 + 7*18 + 8*24
      // = 104 + 35 + 158 + 204 + 276 + 0 + 102 + 126 + 192 = 1197
      // 1197 % 103 = 64 ([1, 1, 1, 4, 2, 2])
      const bars = encodeCode128('Code 128');
      // 1 (Start) + 8 (chars) + 1 (checksum) = 10 symbols * 6 = 60, + Stop (7) = 67
      expect(bars.length).toBe(67);
      // 檢查碼位置（倒數第 13..8 個元素，即 stop 7 碼之前 6 碼）
      const checksumBars = bars.slice(60 - 6, 60);
      expect(checksumBars).toEqual([1, 1, 1, 4, 2, 2]);
      // 檢查 Stop 碼（最後 7 碼）
      expect(bars.slice(-7)).toEqual([2, 3, 3, 1, 1, 1, 2]);
    });

    it('遇到非可列印 ASCII 或空字串會拋錯', () => {
      expect(() => encodeCode128('')).toThrow();
      expect(() => encodeCode128('測試')).toThrow();
    });
  });

  describe('encodeEan13', () => {
    it('12 碼會自動補齊檢查碼，13 碼會驗證檢查碼', () => {
      expect(computeEan13CheckDigit('400638133393')).toBe(1);
      const from12 = encodeEan13('400638133393');
      const from13 = encodeEan13('4006381333931');
      expect(from12).toEqual(from13);
      // 總模組數 = 95，元素數 = 59
      expect(from13.length).toBe(59);
      expect(from13.reduce((a, b) => a + b, 0)).toBe(95);
    });

    it('檢查碼錯誤或長度不符會拋錯', () => {
      expect(() => encodeEan13('4006381333932')).toThrow();
      expect(() => encodeEan13('12345')).toThrow();
      expect(() => encodeEan13('40063813339a')).toThrow();
    });
  });

  describe('barcodeToSvg 與 barcodeToRects', () => {
    it('產生含前後留白的 SVG 字串', () => {
      const bars = encodeCode39('/ABC1234');
      const { totalWidth, rects } = barcodeToRects(bars, 10);
      expect(rects.length).toBe((bars.length + 1) / 2);
      expect(rects[0]?.x).toBe(10);

      const svg = barcodeToSvg(bars, { height: 60, quietZone: 10 });
      expect(svg).toContain(`viewBox="0 0 ${totalWidth} 60"`);
      expect(svg).toContain('<rect ');
    });
  });

  describe('guessFormat', () => {
    it('正確判斷 ean13、code39、code128 與 qr', () => {
      expect(guessFormat('4006381333931')).toBe('ean13');
      // 13 位數字但檢查碼錯誤 -> 非 ean13，符合 code39 字元集 -> code39
      expect(guessFormat('4006381333932')).toBe('code39');
      expect(guessFormat('/ABC1234')).toBe('code39');
      expect(guessFormat('Hello-123')).toBe('code128');
      expect(guessFormat('會員卡測試')).toBe('qr');
      expect(guessFormat('A'.repeat(41))).toBe('qr');
    });
  });
});
