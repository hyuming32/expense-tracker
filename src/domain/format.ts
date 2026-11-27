import type { CurrencyRate } from '../db/types';
import {
  getCurrencySymbol,
  getDefaultCurrencyDecimals,
  type MainCurrencyInfo,
  roundToDecimals,
} from './currency';

const WEEKDAYS_ZH = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'] as const;

export const HIDDEN_AMOUNT_TEXT = 'NT$ ••••';

let displayMainCurrency: MainCurrencyInfo = {
  code: 'TWD',
  name: '新台幣',
  decimals: 0,
  symbol: 'NT$',
};

let currencyDecimalsOverride = new Map<string, number>();

/**
 * 設定全域顯示用的主幣別與幣別小數位對照表（由載入 currencies 的 hook 在資料變動時呼叫）。
 */
export function setDisplayCurrency(
  main: MainCurrencyInfo,
  currencies?: readonly CurrencyRate[],
): void {
  displayMainCurrency = {
    code: main.code,
    name: main.name,
    decimals: main.decimals,
    symbol: main.symbol || getCurrencySymbol(main.code),
  };
  if (currencies) {
    const nextMap = new Map<string, number>();
    for (const c of currencies) {
      if (!c.deleted) {
        nextMap.set(c.code.toUpperCase(), c.decimals);
      }
    }
    currencyDecimalsOverride = nextMap;
  }
}

/**
 * 取得目前顯示用的主幣別資訊。
 */
export function getDisplayCurrency(): MainCurrencyInfo {
  return displayMainCurrency;
}

/**
 * 取得指定幣別（或目前主幣別）的隱藏金額遮罩文字。
 */
export function getHiddenAmountText(code?: string): string {
  const symbol = code ? getCurrencySymbol(code) : displayMainCurrency.symbol;
  return `${symbol.trimEnd()} ••••`;
}

/**
 * 依指定幣別代碼格式化金額（例如 NT$1,234、US$12.50、¥21,200）。
 */
export function formatMoney(amount: number, code: string, decimals?: number): string {
  const upper = code.trim().toUpperCase();
  const d =
    decimals !== undefined
      ? Math.max(0, Math.trunc(decimals))
      : (currencyDecimalsOverride.get(upper) ?? getDefaultCurrencyDecimals(upper));
  const symbol = getCurrencySymbol(upper);
  const rounded = roundToDecimals(amount, d);
  const absVal = Math.abs(rounded);
  const absFormatted =
    d === 0
      ? Math.trunc(absVal).toLocaleString('en-US')
      : absVal.toLocaleString('en-US', {
          minimumFractionDigits: d,
          maximumFractionDigits: d,
        });
  return rounded < 0 ? `-${symbol}${absFormatted}` : `${symbol}${absFormatted}`;
}

/**
 * 依目前主幣別格式化金額，例如 NT$1,234 或 US$12.50。
 */
export function formatCurrency(amount: number): string {
  return formatMoney(amount, displayMainCurrency.code, displayMainCurrency.decimals);
}

/**
 * 依隱藏金額設定格式化顯示金額；隱藏時回傳對應幣別遮罩文字（TWD 時固定回傳「NT$ ••••」）。
 */
export function formatDisplayCurrency(amount: number, hideAmounts: boolean): string {
  return hideAmounts ? getHiddenAmountText() : formatCurrency(amount);
}

/**
 * 取得本地今日日期字串 YYYY-MM-DD。
 */
export function getTodayDateString(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 取得本地現在時間字串 HH:mm（取到分鐘）。
 */
export function getCurrentTimeString(now = new Date()): string {
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * 取得本地當月字串 YYYY-MM。
 */
export function getCurrentMonthString(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * 將 YYYY-MM 格式化為「2026年11月」。
 */
export function formatMonthLabel(monthStr: string): string {
  const [year, month] = monthStr.split('-');
  return `${year ?? ''}年${Number(month ?? 1)}月`;
}

/**
 * 切換月份（delta 為 +1 或 -1）。
 */
export function shiftMonth(monthStr: string, delta: number): string {
  const [yearStr, monthNumStr] = monthStr.split('-');
  const date = new Date(Number(yearStr), Number(monthNumStr) - 1 + delta, 1);
  return getCurrentMonthString(date);
}

/**
 * 將 YYYY-MM-DD 格式化為「11/26 週四」。
 */
export function formatDateWithWeekday(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) {
    return dateStr;
  }
  const date = new Date(y, m - 1, d);
  const weekday = WEEKDAYS_ZH[date.getDay()] ?? '';
  return `${m}/${d} ${weekday}`;
}
