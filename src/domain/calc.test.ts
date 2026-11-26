import { describe, expect, it } from 'vitest';
import {
  appendCalcToken,
  evaluateExpression,
  hasCalcOperator,
  resolveAmountExpression,
} from './calc';

describe('calc 算式解析器', () => {
  it('支援先乘除後加減的運算優先順序', () => {
    expect(evaluateExpression('120+85×2')).toEqual({ ok: true, value: 290 });
    expect(evaluateExpression('120+85*2')).toEqual({ ok: true, value: 290 });
    expect(evaluateExpression('100-60÷3')).toEqual({ ok: true, value: 80 });
    expect(evaluateExpression('2×3+4×5')).toEqual({ ok: true, value: 26 });
  });

  it('支援連續運算與由左至右結合', () => {
    expect(evaluateExpression('100-20-10')).toEqual({ ok: true, value: 70 });
    expect(evaluateExpression('100÷4÷5')).toEqual({ ok: true, value: 5 });
    expect(evaluateExpression('10＋20−5×2÷5')).toEqual({ ok: true, value: 28 });
  });

  it('尾端運算子自動忽略（例如「12+」視為 12）', () => {
    expect(evaluateExpression('12+')).toEqual({ ok: true, value: 12 });
    expect(evaluateExpression('120+85×')).toEqual({ ok: true, value: 205 });
    expect(evaluateExpression('50÷')).toEqual({ ok: true, value: 50 });
  });

  it('除以 0 回傳錯誤', () => {
    const res1 = evaluateExpression('100÷0');
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.error).toContain('0');
    }

    const res2 = evaluateExpression('50+20/0');
    expect(res2.ok).toBe(false);
  });

  it('支援小數運算過程並將最終結果四捨五入為整數元', () => {
    expect(evaluateExpression('10÷4×2')).toEqual({ ok: true, value: 5 });
    expect(evaluateExpression('10÷3×3')).toEqual({ ok: true, value: 10 });
    expect(evaluateExpression('10÷3')).toEqual({ ok: true, value: 3 });
    expect(evaluateExpression('5÷2')).toEqual({ ok: true, value: 3 });
    expect(evaluateExpression('1.4+1.2')).toEqual({ ok: true, value: 3 });
  });

  it('負數與零結果在金額驗證時視為無效並回傳原因', () => {
    expect(evaluateExpression('10-25')).toEqual({ ok: true, value: -15 });
    expect(evaluateExpression('10-10')).toEqual({ ok: true, value: 0 });

    const neg = resolveAmountExpression('10-25');
    expect(neg.ok).toBe(false);
    if (!neg.ok) {
      expect(neg.error).toBe('金額需大於 0');
    }

    const zero = resolveAmountExpression('10-10');
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.error).toBe('金額需大於 0');
    }
  });

  it('空字串與非法字元回傳錯誤', () => {
    expect(evaluateExpression('').ok).toBe(false);
    expect(evaluateExpression('abc').ok).toBe(false);
    expect(evaluateExpression('12++3').ok).toBe(false);
  });

  it('hasCalcOperator 與 appendCalcToken 行為正確', () => {
    expect(hasCalcOperator('120')).toBe(false);
    expect(hasCalcOperator('120+85')).toBe(true);
    expect(hasCalcOperator('-50')).toBe(false);

    let expr = '';
    expr = appendCalcToken(expr, '1');
    expr = appendCalcToken(expr, '00');
    expr = appendCalcToken(expr, '＋');
    expr = appendCalcToken(expr, '−');
    expr = appendCalcToken(expr, '2');
    expr = appendCalcToken(expr, '5');
    expect(expr).toBe('100−25');
    expect(appendCalcToken(expr, '⌫')).toBe('100−2');
    expect(appendCalcToken(expr, 'C')).toBe('');
  });
});
