import { describe, expect, it } from 'vitest';
import { formatInvoiceNote, isInvoiceRightQr, parseInvoiceQr } from './invoice';

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function buildInvoicePrefix(overrides?: {
  invoiceNo?: string;
  rocDate?: string;
  randomCode?: string;
  salesHex?: string;
  totalHex?: string;
  buyerId?: string;
  sellerId?: string;
  aes?: string;
}): string {
  const invoiceNo = overrides?.invoiceNo ?? 'AB12345678';
  const rocDate = overrides?.rocDate ?? '1151126';
  const randomCode = overrides?.randomCode ?? '1234';
  const salesHex = overrides?.salesHex ?? '000000c8'; // 200
  const totalHex = overrides?.totalHex ?? '000000d2'; // 210
  const buyerId = overrides?.buyerId ?? '00000000';
  const sellerId = overrides?.sellerId ?? '12345678';
  const aes = overrides?.aes ?? 'ABCDEFGHIJKLMNOPQRSTUVWX';
  return `${invoiceNo}${rocDate}${randomCode}${salesHex}${totalHex}${buyerId}${sellerId}${aes}`;
}

describe('parseInvoiceQr', () => {
  it('正確解析 UTF-8 品名、民國年與 16 進位金額', () => {
    const qr = `${buildInvoicePrefix({
      invoiceNo: 'ab12345678',
      rocDate: '1151126',
      salesHex: '0000012c',
      totalHex: '00000140', // 320
      sellerId: '87654321',
    })}:**********:2:2:1:拿鐵咖啡:1:120:火腿蛋吐司:2:100`;

    const parsed = parseInvoiceQr(qr);
    expect(parsed).toEqual({
      invoiceNo: 'AB12345678',
      date: '2026-11-26',
      amount: 320,
      sellerId: '87654321',
      items: [
        { name: '拿鐵咖啡', qty: 1, unitPrice: 120 },
        { name: '火腿蛋吐司', qty: 2, unitPrice: 100 },
      ],
    });
  });

  it('正確解析 Base64 編碼的中文品名', () => {
    const item1 = encodeBase64Utf8('排骨便當');
    const item2 = encodeBase64Utf8('紅茶冰');
    const qr = `${buildInvoicePrefix({
      totalHex: '00000096', // 150
    })}:**********:2:2:2:${item1}:1:110:${item2}:1:40`;

    const parsed = parseInvoiceQr(qr);
    expect(parsed).not.toBeNull();
    expect(parsed?.amount).toBe(150);
    expect(parsed?.items).toEqual([
      { name: '排骨便當', qty: 1, unitPrice: 110 },
      { name: '紅茶冰', qty: 1, unitPrice: 40 },
    ]);
  });

  it('無品目資料或品目不完整時，只要前 77 碼有效仍回傳結果且 items 為空陣列', () => {
    const onlyHeader = buildInvoicePrefix({ totalHex: '00000064' }); // 100
    expect(parseInvoiceQr(onlyHeader)).toEqual({
      invoiceNo: 'AB12345678',
      date: '2026-11-26',
      amount: 100,
      sellerId: '12345678',
      items: [],
    });

    const brokenItems = `${onlyHeader}:**********:1:1:1:缺少單價:2`;
    expect(parseInvoiceQr(brokenItems)?.items).toEqual([]);
  });

  it('格式錯誤（字軌、日期不合法、16 進位錯誤、長度不足）時回傳 null', () => {
    expect(parseInvoiceQr('1234567890')).toBeNull();
    expect(parseInvoiceQr(buildInvoicePrefix({ invoiceNo: '1234567890' }))).toBeNull();
    expect(parseInvoiceQr(buildInvoicePrefix({ rocDate: '1150230' }))).toBeNull();
    expect(parseInvoiceQr(buildInvoicePrefix({ rocDate: '1151301' }))).toBeNull();
    expect(parseInvoiceQr(buildInvoicePrefix({ salesHex: 'ZZZZZZZZ' }))).toBeNull();
    expect(parseInvoiceQr(buildInvoicePrefix({ totalHex: '000000GG' }))).toBeNull();
  });

  it('右側 QR Code（以 ** 開頭）回傳 null 並可被 isInvoiceRightQr 辨識', () => {
    const rightQr = '**品名續行:1:50:品名二:2:30';
    expect(isInvoiceRightQr(rightQr)).toBe(true);
    expect(parseInvoiceQr(rightQr)).toBeNull();
  });

  it('formatInvoiceNote 依品目數量格式化備註', () => {
    expect(
      formatInvoiceNote({
        invoiceNo: 'AB12345678',
        date: '2026-11-26',
        amount: 100,
        sellerId: '12345678',
        items: [],
      }),
    ).toBe('發票 AB12345678');

    expect(
      formatInvoiceNote({
        invoiceNo: 'AB12345678',
        date: '2026-11-26',
        amount: 300,
        sellerId: '12345678',
        items: [
          { name: '品項A', qty: 1, unitPrice: 100 },
          { name: '品項B', qty: 1, unitPrice: 100 },
          { name: '品項C', qty: 1, unitPrice: 100 },
          { name: '品項D', qty: 1, unitPrice: 100 },
        ],
      }),
    ).toBe('品項A、品項B、品項C等 4 項');
  });
});
