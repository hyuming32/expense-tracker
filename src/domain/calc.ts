import { roundToDecimals } from './currency';

export type CalcResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

type Operator = '+' | '-' | '*' | '/';

const OPERATOR_MAP: Record<string, Operator> = {
  '+': '+',
  '＋': '+',
  '-': '-',
  '−': '-',
  '*': '*',
  '×': '*',
  '/': '/',
  '÷': '/',
};

/**
 * 將全形／數學符號運算子正規化為半形 + - * / 並移除空白。
 */
export function normalizeExpression(expression: string): string {
  let result = '';
  for (const ch of expression) {
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      continue;
    }
    result += OPERATOR_MAP[ch] ?? ch;
  }
  return result;
}

function isOperatorChar(ch: string): ch is Operator {
  return ch === '+' || ch === '-' || ch === '*' || ch === '/';
}

/**
 * 判斷算式是否包含運算子（用於決定是否顯示即時試算結果）。
 */
export function hasCalcOperator(expression: string): boolean {
  const normalized = normalizeExpression(expression);
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (isOperatorChar(ch)) {
      if (i === 0 && ch === '-') {
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * 處理計算機按鍵輸入：支援數字、00、小數點與運算子替換。
 */
export function appendCalcToken(current: string, token: string): string {
  if (token === 'C') {
    return '';
  }
  if (token === '⌫') {
    return current.slice(0, -1);
  }

  const normalizedToken = OPERATOR_MAP[token] ?? token;

  if (isOperatorChar(normalizedToken)) {
    if (!current) {
      return normalizedToken === '-' ? '-' : '';
    }
    const last = current[current.length - 1]!;
    const mappedLast = OPERATOR_MAP[last] ?? last;
    if (isOperatorChar(mappedLast)) {
      if (current.length === 1 && mappedLast === '-') {
        return normalizedToken === '-' ? '-' : '';
      }
      return current.slice(0, -1) + token;
    }
    return current + token;
  }

  if (normalizedToken === '.') {
    // 檢查目前最後一段數字是否已有小數點
    let i = current.length - 1;
    while (i >= 0) {
      const ch = current[i]!;
      if (isOperatorChar(OPERATOR_MAP[ch] ?? ch)) {
        break;
      }
      if (ch === '.') {
        return current;
      }
      i--;
    }
    if (i === current.length - 1) {
      return `${current}0.`;
    }
    return `${current}.`;
  }

  if (normalizedToken === '00') {
    // 避免開頭或運算子後直接出現 00
    const last = current[current.length - 1];
    if (!current || (last !== undefined && isOperatorChar(OPERATOR_MAP[last] ?? last))) {
      return `${current}0`;
    }
    // 避免目前數字只有單一 0 時再補 00
    const prev = current.length >= 2 ? current[current.length - 2] : undefined;
    if (last === '0' && (!prev || isOperatorChar(OPERATOR_MAP[prev] ?? prev))) {
      return current;
    }
    return `${current}00`;
  }

  if (/^\d$/.test(normalizedToken)) {
    const last = current[current.length - 1];
    const prev = current.length >= 2 ? current[current.length - 2] : undefined;
    if (last === '0' && (!prev || isOperatorChar(OPERATOR_MAP[prev] ?? prev))) {
      return current.slice(0, -1) + normalizedToken;
    }
    return current + normalizedToken;
  }

  return current;
}

/**
 * 自行實作的算式解析器（不使用 eval / new Function）：
 * 支援先乘除後加減、連續運算、小數過程、尾端運算子自動忽略、除以 0 回傳錯誤，
 * 最終結果依指定小數位（預設 0）四捨五入。
 */
export function evaluateExpression(expression: string, decimals = 0): CalcResult {
  let normalized = normalizeExpression(expression);
  if (!normalized) {
    return { ok: false, error: '請輸入金額' };
  }

  // 移除尾端尚未輸入完的運算子（例如「12+」視為「12」）
  while (normalized.length > 0 && isOperatorChar(normalized[normalized.length - 1]!)) {
    normalized = normalized.slice(0, -1);
  }

  if (!normalized) {
    return { ok: false, error: '算式格式不正確' };
  }

  const numbers: number[] = [];
  const operators: Operator[] = [];
  let idx = 0;

  while (idx < normalized.length) {
    // 讀取數字（僅允許第一個字元帶負號）
    let numStart = idx;
    if (idx === 0 && normalized[idx] === '-') {
      idx++;
    }

    let dotCount = 0;
    let digitCount = 0;
    while (idx < normalized.length) {
      const ch = normalized[idx]!;
      if (ch >= '0' && ch <= '9') {
        digitCount++;
        idx++;
      } else if (ch === '.') {
        dotCount++;
        if (dotCount > 1) {
          return { ok: false, error: '算式格式不正確' };
        }
        idx++;
      } else {
        break;
      }
    }

    if (digitCount === 0) {
      return { ok: false, error: '算式格式不正確' };
    }

    const numStr = normalized.slice(numStart, idx);
    const parsed = Number(numStr);
    if (!Number.isFinite(parsed)) {
      return { ok: false, error: '數值超出範圍' };
    }
    numbers.push(parsed);

    if (idx < normalized.length) {
      const op = normalized[idx]!;
      if (!isOperatorChar(op)) {
        return { ok: false, error: '算式包含不支援的字元' };
      }
      operators.push(op);
      idx++;
    }
  }

  if (numbers.length !== operators.length + 1) {
    return { ok: false, error: '算式格式不正確' };
  }

  // 第一階段：由左至右計算乘除
  const addSubNumbers: number[] = [numbers[0]!];
  const addSubOps: Array<'+' | '-'> = [];

  for (let i = 0; i < operators.length; i++) {
    const op = operators[i]!;
    const right = numbers[i + 1]!;
    if (op === '*' || op === '/') {
      const left = addSubNumbers[addSubNumbers.length - 1]!;
      if (op === '/' && right === 0) {
        return { ok: false, error: '不可除以 0' };
      }
      const nextVal = op === '*' ? left * right : left / right;
      if (!Number.isFinite(nextVal)) {
        return { ok: false, error: '數值超出範圍' };
      }
      addSubNumbers[addSubNumbers.length - 1] = nextVal;
    } else {
      addSubOps.push(op);
      addSubNumbers.push(right);
    }
  }

  // 第二階段：由左至右計算加減
  let total = addSubNumbers[0]!;
  for (let i = 0; i < addSubOps.length; i++) {
    const op = addSubOps[i]!;
    const right = addSubNumbers[i + 1]!;
    total = op === '+' ? total + right : total - right;
  }

  if (!Number.isFinite(total)) {
    return { ok: false, error: '數值超出範圍' };
  }

  const rounded = roundToDecimals(total, decimals);
  return { ok: true, value: rounded === 0 ? 0 : rounded };
}

/**
 * 計算算式並驗證最終記帳金額是否大於 0。
 */
export function resolveAmountExpression(expression: string, decimals = 0): CalcResult {
  const evaluated = evaluateExpression(expression, decimals);
  if (!evaluated.ok) {
    return evaluated;
  }
  if (evaluated.value <= 0) {
    return { ok: false, error: '金額需大於 0' };
  }
  return evaluated;
}
