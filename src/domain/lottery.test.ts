import { describe, expect, it } from 'vitest';
import type { LotteryDraw, Transaction } from '../db/types';
import {
  checkInvoice,
  claimDeadline,
  drawDateOfPeriod,
  extractDrawNumbers,
  matchPeriod,
  periodOfDate,
} from './lottery';

function makeDraw(overrides: Partial<LotteryDraw> = {}): LotteryDraw {
  return {
    id: 'draw-2026-09',
    period: '2026-09',
    special: '12345678',
    grand: '87654321',
    first: ['11111111', '22222222', '33333333'],
    extraSixth: ['999'],
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted: false,
    ...overrides,
  };
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    kind: 'expense',
    date: '2026-09-15',
    amount: 100,
    accountId: 'seed-acc-cash',
    toAccountId: null,
    categoryId: 'seed-cat-food',
    note: '午餐',
    invoiceNo: 'AB11111111',
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted: false,
    ...overrides,
  };
}

describe('lottery domain', () => {
  it('periodOfDate 依單數月起始回傳正確期別', () => {
    expect(periodOfDate('2026-01-05')).toBe('2026-01');
    expect(periodOfDate('2026-02-28')).toBe('2026-01');
    expect(periodOfDate('2026-03-01')).toBe('2026-03');
    expect(periodOfDate('2026-04-30')).toBe('2026-03');
    expect(periodOfDate('2026-09-10')).toBe('2026-09');
    expect(periodOfDate('2026-10-31')).toBe('2026-09');
    expect(periodOfDate('2026-11-01')).toBe('2026-11');
    expect(periodOfDate('2026-12-31')).toBe('2026-11');
  });

  it('drawDateOfPeriod 與 claimDeadline 計算開獎日與領獎期限（含跨年）', () => {
    expect(drawDateOfPeriod('2026-09')).toBe('2026-11-25');
    expect(drawDateOfPeriod('2026-11')).toBe('2027-01-25');
    expect(drawDateOfPeriod('2026-01')).toBe('2026-03-25');

    expect(claimDeadline('2026-09')).toBe('2027-03-05');
    expect(claimDeadline('2026-11')).toBe('2027-05-05');
    expect(claimDeadline('2026-07')).toBe('2027-01-05');
    expect(claimDeadline('2026-01')).toBe('2026-07-05');
  });

  it('checkInvoice 正確判斷各獎項並只回傳最高獎項', () => {
    const draw = makeDraw({
      special: '12345678',
      grand: '87654321',
      first: ['11111111', '22222222', '33333999'],
      extraSixth: ['999', '888'],
    });

    expect(checkInvoice('AB12345678', draw)).toEqual({ prize: 'special', amount: 10_000_000 });
    expect(checkInvoice('CD-87654321', draw)).toEqual({ prize: 'grand', amount: 2_000_000 });
    expect(checkInvoice('EF11111111', draw)).toEqual({ prize: 'first', amount: 200_000 });
    expect(checkInvoice('EF91111111', draw)).toEqual({ prize: 'second', amount: 40_000 });
    expect(checkInvoice('EF99111111', draw)).toEqual({ prize: 'third', amount: 10_000 });
    expect(checkInvoice('EF99911111', draw)).toEqual({ prize: 'fourth', amount: 4_000 });
    expect(checkInvoice('EF99991111', draw)).toEqual({ prize: 'fifth', amount: 1_000 });
    expect(checkInvoice('EF99999111', draw)).toEqual({ prize: 'sixth', amount: 200 });
    expect(checkInvoice('GH00000888', draw)).toEqual({ prize: 'extraSixth', amount: 200 });
    // 同時中頭獎末 3 碼與增開六獎時，回傳較高順位（sixth）
    expect(checkInvoice('GH00000999', draw)).toEqual({ prize: 'sixth', amount: 200 });
    expect(checkInvoice('IJ00000000', draw)).toEqual({ prize: null, amount: 0 });
    expect(checkInvoice('INVALID', draw)).toEqual({ prize: null, amount: 0 });
  });

  it('matchPeriod 僅比對該期未刪除且具發票號碼的交易並統計未填發票筆數', () => {
    const draw = makeDraw();
    const txs: Transaction[] = [
      makeTx({ id: 't1', date: '2026-09-02', invoiceNo: 'AA12345678' }), // 特別獎
      makeTx({ id: 't2', date: '2026-10-20', invoiceNo: 'BB99999111' }), // 六獎 200
      makeTx({ id: 't3', date: '2026-10-25', invoiceNo: 'CC00000000' }), // 未中
      makeTx({ id: 't4', date: '2026-09-18', invoiceNo: null }), // 缺發票號碼
      makeTx({ id: 't5', date: '2026-09-19', invoiceNo: 'DD87654321', deleted: true }), // 已刪除
      makeTx({ id: 't6', date: '2026-11-01', invoiceNo: 'EE87654321' }), // 不同期別
    ];

    const result = matchPeriod(txs, draw);
    expect(result.period).toBe('2026-09');
    expect(result.checkedCount).toBe(3);
    expect(result.missingInvoiceCount).toBe(1);
    expect(result.totalAmount).toBe(10_000_200);
    expect(result.matched.map((m) => m.transaction.id)).toEqual(['t1', 't2']);
  });

  it('extractDrawNumbers 能解析財政部開獎頁與新聞截圖雜訊（含全形數字、空白、換行）', () => {
    const mofText = `
      115年 09-10月 統一發票中獎號碼單
      特別獎 ２８６３０５２５
      同期統一發票收執聯8位數號碼與特別獎號碼相同者獎金1,000萬元
      特獎 ９００２８５８０
      頭獎
      ２７４３５９３４
      ３９６６６６０５
      ０２５５００３１
      增開六獎 ５１２
    `;
    const r1 = extractDrawNumbers(mofText);
    expect(r1.special).toBe('28630525');
    expect(r1.grand).toBe('90028580');
    expect(r1.first).toEqual(['27435934', '39666605', '02550031']);
    expect(r1.extraSixth).toEqual(['512']);
    expect(r1.lowConfidenceFields).toEqual([]);

    const newsText = `
      快訊／9-10月發票開獎！
      特別獎：1234 5678
      特 獎：8765-4321
      頭獎三組 11112222、33334444、55556666
    `;
    const r2 = extractDrawNumbers(newsText);
    expect(r2.special).toBe('12345678');
    expect(r2.grand).toBe('87654321');
    expect(r2.first).toEqual(['11112222', '33334444', '55556666']);
    expect(r2.extraSixth).toEqual([]);
    expect(r2.lowConfidenceFields).toEqual([]);
  });

  it('extractDrawNumbers 在無關鍵字或缺少號碼時會標記信心不足欄位', () => {
    const rawDigitsOnly = `
      11111111
      22222222
      33333333
      44444444
    `;
    const res = extractDrawNumbers(rawDigitsOnly);
    expect(res.special).toBe('11111111');
    expect(res.grand).toBe('22222222');
    expect(res.first).toEqual(['33333333', '44444444', '']);
    expect(res.lowConfidenceFields).toContain('special');
    expect(res.lowConfidenceFields).toContain('grand');
    expect(res.lowConfidenceFields).toContain('first.2');
  });
});
