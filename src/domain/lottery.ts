import type { LotteryDraw, Transaction } from '../db/types';
import { getTodayDateString } from './format';

export type LotteryPrize =
  | 'special'
  | 'grand'
  | 'first'
  | 'second'
  | 'third'
  | 'fourth'
  | 'fifth'
  | 'sixth'
  | 'extraSixth';

export interface CheckInvoiceResult {
  prize: LotteryPrize | null;
  amount: number;
}

export interface LotteryMatchItem {
  transaction: Transaction;
  invoiceDigits: string;
  prize: LotteryPrize;
  amount: number;
}

export interface MatchPeriodResult {
  period: string;
  matched: LotteryMatchItem[];
  totalAmount: number;
  checkedCount: number;
  missingInvoiceCount: number;
}

export interface ExtractDrawNumbersResult {
  special: string;
  grand: string;
  first: string[];
  extraSixth: string[];
  /** 信心不足的欄位鍵值：'special' | 'grand' | 'first.0' | 'first.1' | 'first.2' | 'extraSixth.0' ... */
  lowConfidenceFields: string[];
}

export const PRIZE_LABELS: Record<LotteryPrize, string> = {
  special: '特別獎',
  grand: '特獎',
  first: '頭獎',
  second: '二獎',
  third: '三獎',
  fourth: '四獎',
  fifth: '五獎',
  sixth: '六獎',
  extraSixth: '增開六獎',
};

const PRIZE_AMOUNTS: Record<LotteryPrize, number> = {
  special: 10_000_000,
  grand: 2_000_000,
  first: 200_000,
  second: 40_000,
  third: 10_000,
  fourth: 4_000,
  fifth: 1_000,
  sixth: 200,
  extraSixth: 200,
};

const PRIZE_RANK: Record<LotteryPrize, number> = {
  special: 9,
  grand: 8,
  first: 7,
  second: 6,
  third: 5,
  fourth: 4,
  fifth: 3,
  sixth: 2,
  extraSixth: 1,
};

const PERIOD_PATTERN = /^(\d{4})-(01|03|05|07|09|11)$/;

/**
 * 將全形數字（０–９）轉為半形數字（0–9）。
 */
export function normalizeFullWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/**
 * 僅保留數字並自動把全形數字轉為半形。
 */
export function sanitizeDigitsInput(text: string): string {
  return normalizeFullWidthDigits(text).replace(/\D/g, '');
}

/**
 * 取得日期所屬的統一發票期別（單數月起始 'YYYY-MM'）。
 */
export function periodOfDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date.trim());
  if (!match) {
    throw new Error(`日期格式不正確：${date}`);
  }
  const year = match[1];
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`月份不正確：${date}`);
  }
  const startMonth = month % 2 === 1 ? month : month - 1;
  return `${year}-${String(startMonth).padStart(2, '0')}`;
}

/**
 * 計算期別的開獎日（期別結束後的單數月 25 日）。
 */
export function drawDateOfPeriod(period: string): string {
  const match = PERIOD_PATTERN.exec(period.trim());
  if (!match) {
    throw new Error(`期別格式不正確：${period}`);
  }
  let year = Number(match[1]);
  let drawMonth = Number(match[2]) + 2;
  if (drawMonth > 12) {
    year += 1;
    drawMonth -= 12;
  }
  return `${year}-${String(drawMonth).padStart(2, '0')}-25`;
}

/**
 * 估算領獎期限（開獎次月 6 日起算三個月，例如 2026-09 期為 2027-03-05；實際仍以財政部公告為準）。
 */
export function claimDeadline(period: string): string {
  const drawDate = drawDateOfPeriod(period);
  let year = Number(drawDate.slice(0, 4));
  let month = Number(drawDate.slice(5, 7)) + 4; // 次月 (+1) + 3 個月 (+3)
  while (month > 12) {
    year += 1;
    month -= 12;
  }
  return `${year}-${String(month).padStart(2, '0')}-05`;
}

/**
 * 格式化期別顯示文字（例如 2026-09 → 2026 年 9–10 月）。
 */
export function formatPeriodLabel(period: string): string {
  const match = PERIOD_PATTERN.exec(period.trim());
  if (!match) {
    return period;
  }
  const year = match[1];
  const startMonth = Number(match[2]);
  return `${year} 年 ${startMonth}–${startMonth + 1} 月`;
}

/**
 * 格式化期別簡短月份區間（例如 2026-09 → 9–10 月）。
 */
export function formatPeriodShortLabel(period: string): string {
  const match = PERIOD_PATTERN.exec(period.trim());
  if (!match) {
    return period;
  }
  const startMonth = Number(match[2]);
  return `${startMonth}–${startMonth + 1} 月`;
}

/**
 * 將期別往前或往後推移指定期數（正數往未來、負數往過去）。
 */
export function shiftPeriodKey(period: string, offset: number): string {
  const match = PERIOD_PATTERN.exec(period.trim());
  if (!match) {
    throw new Error(`期別格式不正確：${period}`);
  }
  const year = Number(match[1]);
  const startMonth = Number(match[2]);
  const periodIndex = year * 6 + Math.floor((startMonth - 1) / 2) + offset;
  const nextYear = Math.floor(periodIndex / 6);
  const nextStartMonth = (periodIndex % 6) * 2 + 1;
  return `${nextYear}-${String(nextStartMonth).padStart(2, '0')}`;
}

/**
 * 判斷指定期別是否已到開獎日（含當日）。
 */
export function isPeriodDrawn(period: string, today: string = getTodayDateString()): boolean {
  return today >= drawDateOfPeriod(period);
}

/**
 * 取得截至指定日期為止最近一期已開獎的期別。
 */
export function getLatestDrawnPeriod(today: string = getTodayDateString()): string {
  let candidate = periodOfDate(today);
  while (!isPeriodDrawn(candidate, today)) {
    candidate = shiftPeriodKey(candidate, -1);
  }
  return candidate;
}

/**
 * 取得包含當期在內由新到舊的期別清單。
 */
export function getRecentPeriods(
  today: string = getTodayDateString(),
  count = 12,
): string[] {
  const current = periodOfDate(today);
  const periods: string[] = [];
  for (let i = 0; i < count; i += 1) {
    periods.push(shiftPeriodKey(current, -i));
  }
  return periods;
}

/**
 * 從發票號碼字串擷取 8 碼純數字（去除英文字軌、空白與連字號）。
 */
export function extractInvoiceDigits(invoiceNo: string | null | undefined): string | null {
  if (!invoiceNo) {
    return null;
  }
  const digits = sanitizeDigitsInput(invoiceNo);
  if (digits.length === 8) {
    return digits;
  }
  return null;
}

/**
 * 依統一發票對獎規則檢查單張發票號碼，僅回傳最高獎項與獎金。
 */
export function checkInvoice(
  invoiceNo: string,
  draw: Pick<LotteryDraw, 'special' | 'grand' | 'first' | 'extraSixth'>,
): CheckInvoiceResult {
  const digits = extractInvoiceDigits(invoiceNo);
  if (!digits) {
    return { prize: null, amount: 0 };
  }

  let bestPrize: LotteryPrize | null = null;
  const consider = (prize: LotteryPrize) => {
    if (!bestPrize || PRIZE_RANK[prize] > PRIZE_RANK[bestPrize]) {
      bestPrize = prize;
    }
  };

  if (/^\d{8}$/.test(draw.special) && digits === draw.special) {
    consider('special');
  }
  if (/^\d{8}$/.test(draw.grand) && digits === draw.grand) {
    consider('grand');
  }

  for (const firstNo of draw.first) {
    if (!/^\d{8}$/.test(firstNo)) {
      continue;
    }
    if (digits === firstNo) {
      consider('first');
    } else if (digits.slice(1) === firstNo.slice(1)) {
      consider('second');
    } else if (digits.slice(2) === firstNo.slice(2)) {
      consider('third');
    } else if (digits.slice(3) === firstNo.slice(3)) {
      consider('fourth');
    } else if (digits.slice(4) === firstNo.slice(4)) {
      consider('fifth');
    } else if (digits.slice(5) === firstNo.slice(5)) {
      consider('sixth');
    }
  }

  for (const extraNo of draw.extraSixth) {
    if (/^\d{3}$/.test(extraNo) && digits.slice(5) === extraNo) {
      consider('extraSixth');
    }
  }

  if (!bestPrize) {
    return { prize: null, amount: 0 };
  }
  return {
    prize: bestPrize,
    amount: PRIZE_AMOUNTS[bestPrize],
  };
}

/**
 * 比對指定期別所有未刪除且填有發票號碼的交易，回傳中獎清單、總獎金與統計筆數。
 */
export function matchPeriod(
  transactions: readonly Transaction[],
  draw: LotteryDraw,
): MatchPeriodResult {
  const matched: LotteryMatchItem[] = [];
  let totalAmount = 0;
  let checkedCount = 0;
  let missingInvoiceCount = 0;

  for (const tx of transactions) {
    if (tx.deleted) {
      continue;
    }
    let txPeriod: string;
    try {
      txPeriod = periodOfDate(tx.date);
    } catch {
      continue;
    }
    if (txPeriod !== draw.period) {
      continue;
    }

    const rawInvoice = tx.invoiceNo?.trim() ?? '';
    if (!rawInvoice) {
      missingInvoiceCount += 1;
      continue;
    }

    const invoiceDigits = extractInvoiceDigits(rawInvoice);
    if (!invoiceDigits) {
      missingInvoiceCount += 1;
      continue;
    }

    checkedCount += 1;
    const result = checkInvoice(invoiceDigits, draw);
    if (result.prize) {
      matched.push({
        transaction: tx,
        invoiceDigits,
        prize: result.prize,
        amount: result.amount,
      });
      totalAmount += result.amount;
    }
  }

  matched.sort((a, b) => b.amount - a.amount || b.transaction.date.localeCompare(a.transaction.date));

  return {
    period: draw.period,
    matched,
    totalAmount,
    checkedCount,
    missingInvoiceCount,
  };
}

type SectionKind = 'special' | 'grand' | 'first' | 'extraSixth';

function detectSectionKeyword(lineWithoutSpaces: string): SectionKind | null {
  if (/特別獎|特別/.test(lineWithoutSpaces)) {
    return 'special';
  }
  if (/特獎/.test(lineWithoutSpaces)) {
    return 'grand';
  }
  if (/頭獎/.test(lineWithoutSpaces)) {
    return 'first';
  }
  if (/增開六獎|增開/.test(lineWithoutSpaces)) {
    return 'extraSixth';
  }
  return null;
}

function extractEightDigitCandidates(text: string): string[] {
  // 允許 8 碼數字中間被單一空白或連字號斷開（例如 "1234 5678" 或 "1234-5678"）
  const matches = text.match(/(?<!\d)\d{4}[\s-]?\d{4}(?!\d)/g) ?? [];
  return matches.map((m) => m.replace(/\D/g, '')).filter((m) => m.length === 8);
}

function extractThreeDigitCandidates(text: string): string[] {
  const matches = text.match(/(?<!\d)\d{3}(?!\d)/g) ?? [];
  return matches;
}

/**
 * 從 OCR 辨識文字擷取 8 碼與 3 碼開獎號碼，依關鍵字與出現順序推測歸屬並標記信心不足欄位。
 */
export function extractDrawNumbers(ocrText: string): ExtractDrawNumbersResult {
  const normalized = normalizeFullWidthDigits(ocrText);
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let special = '';
  let grand = '';
  const first: string[] = [];
  const extraSixth: string[] = [];
  const lowConfidence = new Set<string>();

  let currentSection: SectionKind | null = null;
  let sawAnyKeyword = false;

  for (const line of lines) {
    const compact = line.replace(/\s+/g, '');
    const detected = detectSectionKeyword(compact);
    if (detected) {
      currentSection = detected;
      sawAnyKeyword = true;
    }

    const eights = extractEightDigitCandidates(line);
    const threes = extractThreeDigitCandidates(line);

    if (currentSection === 'special') {
      if (eights.length > 0 && !special) {
        special = eights[0] ?? '';
        if (eights.length > 1) {
          // 同一區塊出現多組 8 碼，其餘可能其實是特獎或頭獎
          if (!grand && eights[1]) {
            grand = eights[1];
            lowConfidence.add('grand');
          }
        }
      }
    } else if (currentSection === 'grand') {
      if (eights.length > 0 && !grand) {
        grand = eights[0] ?? '';
      }
    } else if (currentSection === 'first') {
      for (const num of eights) {
        if (first.length < 3) {
          first.push(num);
        }
      }
    } else if (currentSection === 'extraSixth') {
      for (const num of threes) {
        // 排除常見金額/日期雜訊如 200
        if (num !== '200') {
          extraSixth.push(num);
        }
      }
    }
  }

  // 若沒有關鍵字或部分欄位仍缺失，以全文出現的 8 碼數字依序補齊
  const allEights = extractEightDigitCandidates(normalized);
  if (!sawAnyKeyword || !special || !grand || first.length < 3) {
    const used = new Set<string>([
      ...(special ? [special] : []),
      ...(grand ? [grand] : []),
      ...first,
    ]);
    const remaining = allEights.filter((n) => !used.has(n));

    if (!special && remaining.length > 0) {
      special = remaining.shift()!;
      if (!sawAnyKeyword) {
        lowConfidence.add('special');
      }
    }
    if (!grand && remaining.length > 0) {
      grand = remaining.shift()!;
      if (!sawAnyKeyword) {
        lowConfidence.add('grand');
      }
    }
    while (first.length < 3 && remaining.length > 0) {
      const idx = first.length;
      first.push(remaining.shift()!);
      if (!sawAnyKeyword) {
        lowConfidence.add(`first.${idx}`);
      }
    }
  }

  // 確保至少有 3 個頭獎欄位，缺少的補空字串並標記信心不足
  while (first.length < 3) {
    const idx = first.length;
    first.push('');
    lowConfidence.add(`first.${idx}`);
  }

  if (!/^\d{8}$/.test(special)) {
    lowConfidence.add('special');
  }
  if (!/^\d{8}$/.test(grand)) {
    lowConfidence.add('grand');
  }
  for (let i = 0; i < first.length; i += 1) {
    if (!/^\d{8}$/.test(first[i] ?? '')) {
      lowConfidence.add(`first.${i}`);
    }
  }

  // 若沒有關鍵字，不主動亂猜增開六獎（避免把年份/金額 200/日期當成增開六獎）
  if (!sawAnyKeyword && allEights.length > 5) {
    // 超過預期的 5 組 8 碼，提醒使用者檢查頭獎與特別獎
    lowConfidence.add('special');
    lowConfidence.add('grand');
    lowConfidence.add('first.0');
    lowConfidence.add('first.1');
    lowConfidence.add('first.2');
  }

  return {
    special,
    grand,
    first,
    extraSixth,
    lowConfidenceFields: Array.from(lowConfidence),
  };
}
