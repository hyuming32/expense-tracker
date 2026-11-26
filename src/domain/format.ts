const WEEKDAYS_ZH = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'] as const;

export const HIDDEN_AMOUNT_TEXT = 'NT$ ••••';

/**
 * 格式化新台幣金額，例如 NT$1,234 或 -NT$1,234。
 */
export function formatCurrency(amount: number): string {
  const absFormatted = Math.abs(Math.trunc(amount)).toLocaleString('en-US');
  return amount < 0 ? `-NT$${absFormatted}` : `NT$${absFormatted}`;
}

/**
 * 依隱藏金額設定格式化顯示金額；隱藏時固定回傳「NT$ ••••」。
 */
export function formatDisplayCurrency(amount: number, hideAmounts: boolean): string {
  return hideAmounts ? HIDDEN_AMOUNT_TEXT : formatCurrency(amount);
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
