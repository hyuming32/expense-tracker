import type {
  Account,
  Budget,
  CurrencyRate,
  RecurringRule,
  Shortcut,
  Transaction,
} from '../db/types';

export interface CommonCurrencySpec {
  code: string;
  name: string;
  decimals: 0 | 2;
  symbol: string;
}

export interface MainCurrencyInfo {
  code: string;
  name: string;
  decimals: number;
  symbol: string;
}

export const CURRENCY_NAME_MAX_LENGTH = 10;

export const ZERO_DECIMAL_CURRENCY_CODES: ReadonlySet<string> = new Set([
  'TWD',
  'JPY',
  'KRW',
  'VND',
  'IDR',
]);

export const COMMON_CURRENCIES: readonly CommonCurrencySpec[] = [
  { code: 'TWD', name: '新台幣', decimals: 0, symbol: 'NT$' },
  { code: 'USD', name: '美元', decimals: 2, symbol: 'US$' },
  { code: 'JPY', name: '日圓', decimals: 0, symbol: '¥' },
  { code: 'EUR', name: '歐元', decimals: 2, symbol: '€' },
  { code: 'CNY', name: '人民幣', decimals: 2, symbol: 'CN¥' },
  { code: 'HKD', name: '港幣', decimals: 2, symbol: 'HK$' },
  { code: 'KRW', name: '韓元', decimals: 0, symbol: '₩' },
  { code: 'GBP', name: '英鎊', decimals: 2, symbol: '£' },
  { code: 'AUD', name: '澳幣', decimals: 2, symbol: 'A$' },
  { code: 'SGD', name: '新加坡幣', decimals: 2, symbol: 'S$' },
  { code: 'THB', name: '泰銖', decimals: 2, symbol: '฿' },
  { code: 'VND', name: '越南盾', decimals: 0, symbol: '₫' },
];

const COMMON_CURRENCY_MAP = new Map<string, CommonCurrencySpec>(
  COMMON_CURRENCIES.map((item) => [item.code, item]),
);

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * 檢查是否為 3 個大寫英文字母的幣別代碼。
 */
export function isValidCurrencyCode(code: string): boolean {
  return CURRENCY_CODE_PATTERN.test(code.trim().toUpperCase());
}

/**
 * 依幣別代碼回傳預設小數位（TWD、JPY、KRW、VND、IDR 為 0，其餘為 2）。
 */
export function getDefaultCurrencyDecimals(code: string): 0 | 2 {
  const upper = code.trim().toUpperCase();
  const common = COMMON_CURRENCY_MAP.get(upper);
  if (common) {
    return common.decimals;
  }
  return ZERO_DECIMAL_CURRENCY_CODES.has(upper) ? 0 : 2;
}

/**
 * 依幣別代碼回傳常用中文名稱（未知代碼時回傳代碼本身）。
 */
export function getDefaultCurrencyName(code: string): string {
  const upper = code.trim().toUpperCase();
  return COMMON_CURRENCY_MAP.get(upper)?.name ?? upper;
}

/**
 * 依幣別代碼回傳顯示符號（未知代碼時回傳 `${code} `）。
 */
export function getCurrencySymbol(code: string): string {
  const upper = code.trim().toUpperCase();
  return COMMON_CURRENCY_MAP.get(upper)?.symbol ?? `${upper} `;
}

/**
 * 依指定小數位四捨五入（避免二進位浮點數誤差並正規化 -0 為 0）。
 */
export function roundToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const d = Math.max(0, Math.trunc(decimals));
  if (d === 0) {
    const rounded = Math.round(value);
    return rounded === 0 ? 0 : rounded;
  }

  const str = String(value);
  if (!str.includes('e') && !str.includes('E')) {
    const shifted = Number(`${str}e+${d}`);
    if (Number.isFinite(shifted)) {
      const rounded = Math.round(shifted);
      const result = Number(`${rounded}e-${d}`);
      return result === 0 ? 0 : result;
    }
  }

  const factor = 10 ** d;
  const result = Math.round(value * factor) / factor;
  return result === 0 ? 0 : result;
}

/**
 * 將原幣金額依匯率換算成主幣別金額並四捨五入至主幣別小數位。
 */
export function convertToMain(
  originalAmount: number,
  rate: number,
  mainDecimals: number,
): number {
  return roundToDecimals(originalAmount * rate, mainDecimals);
}

/**
 * 驗證匯率是否合法：大於 0 且為有限數字。
 */
export function isValidRate(rate: number): boolean {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
}

/**
 * 將匯率格式化為輸入框與介面顯示字串（最多保留 8 位有效數字，避免科學記號）。
 */
export function formatRateDisplay(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) {
    return '';
  }
  const significant = Number(rate.toPrecision(8));
  const str = String(significant);
  if (!str.includes('e') && !str.includes('E')) {
    return str;
  }
  return significant.toFixed(12).replace(/\.?0+$/, '');
}

/**
 * 檢查數值小數位數是否不超過指定上限。
 */
export function hasAtMostDecimals(value: number, maxDecimals: number): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  const d = Math.max(0, Math.trunc(maxDecimals));
  if (d === 0) {
    return Number.isInteger(value);
  }
  return Math.abs(roundToDecimals(value, d) - value) < 1e-9;
}

/**
 * 從幣別清單取得目前主幣別；若無任何 isMain 記錄，預設回傳新台幣（TWD、小數 0）。
 */
export function getMainCurrency(currencies: readonly CurrencyRate[]): MainCurrencyInfo {
  const main = currencies.find((c) => !c.deleted && c.isMain);
  if (!main) {
    return {
      code: 'TWD',
      name: '新台幣',
      decimals: 0,
      symbol: 'NT$',
    };
  }
  return {
    code: main.code,
    name: main.name,
    decimals: main.decimals,
    symbol: getCurrencySymbol(main.code),
  };
}

export interface MainCurrencySwitchInput {
  newCode: string;
  newName?: string;
  newDecimals?: number;
  /** 1 NEW = rate OLD */
  rate: number;
  transactions: readonly Transaction[];
  accounts: readonly Account[];
  budgets: readonly Budget[];
  recurringRules: readonly RecurringRule[];
  shortcuts: readonly Shortcut[];
  currencies: readonly CurrencyRate[];
  now: number;
  deviceId: string;
}

export interface MainCurrencySwitchPlan {
  oldMain: MainCurrencyInfo;
  newMain: MainCurrencyInfo;
  transactions: Transaction[];
  accounts: Account[];
  budgets: Budget[];
  recurringRules: RecurringRule[];
  shortcuts: Shortcut[];
  currencies: CurrencyRate[];
  /** 不含已刪除紀錄的實際換算筆數，供介面提示使用 */
  convertedActiveTransactionCount: number;
}

/**
 * 規劃切換主幣別時要寫入資料庫的所有紀錄（純函式）：
 * - 將所有交易（含已刪除，避免同步時新舊混雜）、帳戶初期餘額、預算、週期規則、捷徑與幣別匯率一次換算。
 */
export function planMainCurrencySwitch(input: MainCurrencySwitchInput): MainCurrencySwitchPlan {
  const newCode = input.newCode.trim().toUpperCase();
  if (!isValidCurrencyCode(newCode)) {
    throw new Error('新主幣別代碼格式不正確（需為 3 碼大寫英文）');
  }
  if (!isValidRate(input.rate)) {
    throw new Error('匯率需為大於 0 的數字');
  }

  const oldMain = getMainCurrency(input.currencies);
  if (newCode === oldMain.code) {
    throw new Error('新主幣別不可與目前主幣別相同');
  }

  const existingNew = input.currencies.find((c) => c.id === newCode || c.code === newCode);
  const existingOld = input.currencies.find(
    (c) => c.id === oldMain.code || c.code === oldMain.code,
  );

  const newNameRaw = (input.newName ?? existingNew?.name ?? getDefaultCurrencyName(newCode)).trim();
  const newName = newNameRaw.slice(0, CURRENCY_NAME_MAX_LENGTH) || newCode;
  const newDecimals =
    input.newDecimals === 0 || input.newDecimals === 2
      ? input.newDecimals
      : existingNew && (existingNew.decimals === 0 || existingNew.decimals === 2)
        ? existingNew.decimals
        : getDefaultCurrencyDecimals(newCode);

  const newMain: MainCurrencyInfo = {
    code: newCode,
    name: newName,
    decimals: newDecimals,
    symbol: getCurrencySymbol(newCode),
  };

  const r = input.rate;
  const { now, deviceId } = input;

  let convertedActiveTransactionCount = 0;

  const updatedTransactions: Transaction[] = input.transactions.map((tx) => {
    if (!tx.deleted) {
      convertedActiveTransactionCount += 1;
    }

    const txCurrency = tx.currency ? tx.currency.trim().toUpperCase() : null;

    if (!txCurrency || txCurrency === oldMain.code) {
      const originalAmount =
        txCurrency === oldMain.code && tx.originalAmount != null ? tx.originalAmount : tx.amount;
      const newTxRate = 1 / r;
      return {
        ...tx,
        currency: oldMain.code,
        originalAmount,
        rate: newTxRate,
        amount: convertToMain(originalAmount, newTxRate, newDecimals),
        updatedAt: now,
        deviceId,
      };
    }

    if (txCurrency === newCode) {
      const originalAmount = tx.originalAmount != null ? tx.originalAmount : tx.amount;
      return {
        ...tx,
        currency: null,
        originalAmount: null,
        rate: null,
        amount: roundToDecimals(originalAmount, newDecimals),
        updatedAt: now,
        deviceId,
      };
    }

    const originalAmount = tx.originalAmount != null ? tx.originalAmount : tx.amount;
    const oldRate = tx.rate != null && tx.rate > 0 ? tx.rate : 1;
    const newTxRate = oldRate / r;
    return {
      ...tx,
      currency: txCurrency,
      originalAmount,
      rate: newTxRate,
      amount: convertToMain(originalAmount, newTxRate, newDecimals),
      updatedAt: now,
      deviceId,
    };
  });

  const updatedAccounts: Account[] = input.accounts.map((acc) => ({
    ...acc,
    initialBalance: roundToDecimals(acc.initialBalance / r, newDecimals),
    updatedAt: now,
    deviceId,
  }));

  const updatedBudgets: Budget[] = input.budgets.map((budget) => ({
    ...budget,
    amount: roundToDecimals(budget.amount / r, newDecimals),
    updatedAt: now,
    deviceId,
  }));

  const updatedRecurringRules: RecurringRule[] = input.recurringRules.map((rule) => ({
    ...rule,
    amount: roundToDecimals(rule.amount / r, newDecimals),
    updatedAt: now,
    deviceId,
  }));

  const updatedShortcuts: Shortcut[] = input.shortcuts.map((shortcut) => ({
    ...shortcut,
    amount: shortcut.amount !== null ? roundToDecimals(shortcut.amount / r, newDecimals) : null,
    updatedAt: now,
    deviceId,
  }));

  let maxSortOrder = input.currencies.reduce((max, c) => Math.max(max, c.sortOrder), 0);
  const updatedCurrencies: CurrencyRate[] = [];
  const handledCodes = new Set<string>();

  for (const cur of input.currencies) {
    handledCodes.add(cur.code);
    if (cur.code === oldMain.code) {
      updatedCurrencies.push({
        ...cur,
        id: oldMain.code,
        code: oldMain.code,
        name: existingOld?.name || oldMain.name,
        decimals: oldMain.decimals,
        rate: 1 / r,
        isMain: false,
        archived: false,
        deleted: false,
        updatedAt: now,
        deviceId,
      });
    } else if (cur.code === newCode) {
      updatedCurrencies.push({
        ...cur,
        id: newCode,
        code: newCode,
        name: newName,
        decimals: newDecimals,
        rate: 1,
        isMain: true,
        archived: false,
        deleted: false,
        updatedAt: now,
        deviceId,
      });
    } else {
      updatedCurrencies.push({
        ...cur,
        rate: cur.rate / r,
        isMain: false,
        updatedAt: now,
        deviceId,
      });
    }
  }

  if (!handledCodes.has(oldMain.code)) {
    maxSortOrder += 1;
    updatedCurrencies.push({
      id: oldMain.code,
      code: oldMain.code,
      name: oldMain.name.slice(0, CURRENCY_NAME_MAX_LENGTH),
      rate: 1 / r,
      decimals: oldMain.decimals,
      isMain: false,
      sortOrder: maxSortOrder,
      archived: false,
      updatedAt: now,
      deviceId,
      deleted: false,
    });
  }

  if (!handledCodes.has(newCode)) {
    maxSortOrder += 1;
    updatedCurrencies.push({
      id: newCode,
      code: newCode,
      name: newName,
      rate: 1,
      decimals: newDecimals,
      isMain: true,
      sortOrder: maxSortOrder,
      archived: false,
      updatedAt: now,
      deviceId,
      deleted: false,
    });
  }

  return {
    oldMain,
    newMain,
    transactions: updatedTransactions,
    accounts: updatedAccounts,
    budgets: updatedBudgets,
    recurringRules: updatedRecurringRules,
    shortcuts: updatedShortcuts,
    currencies: updatedCurrencies,
    convertedActiveTransactionCount,
  };
}
