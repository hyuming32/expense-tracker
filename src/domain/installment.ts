import type { Transaction } from '../db/types';
import { roundToDecimals } from './currency';
import { daysInMonth } from './recurring';

export const INSTALLMENT_MIN_COUNT = 2;
export const INSTALLMENT_MAX_COUNT = 60;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface InstallmentProgress {
  count: number;
  total: number;
  paidCount: number;
  paidAmount: number;
  remainingCount: number;
  remainingAmount: number;
}

function assertValidInstallmentCount(count: number): void {
  if (!Number.isInteger(count) || count < INSTALLMENT_MIN_COUNT || count > INSTALLMENT_MAX_COUNT) {
    throw new Error(`分期期數需介於 ${INSTALLMENT_MIN_COUNT} 到 ${INSTALLMENT_MAX_COUNT} 期`);
  }
}

function toMinorUnits(value: number, decimals: number): number {
  const d = Math.max(0, Math.trunc(decimals));
  if (d === 0) {
    return Math.round(value);
  }
  const str = String(value);
  if (!str.includes('e') && !str.includes('E')) {
    const shifted = Number(`${str}e+${d}`);
    if (Number.isFinite(shifted)) {
      return Math.round(shifted);
    }
  }
  return Math.round(value * 10 ** d);
}

function fromMinorUnits(units: number, decimals: number): number {
  const d = Math.max(0, Math.trunc(decimals));
  if (d === 0) {
    return units === 0 ? 0 : units;
  }
  const result = Number(`${units}e-${d}`);
  return result === 0 ? 0 : result;
}

function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  if (!DATE_PATTERN.test(dateStr)) {
    throw new Error('首期日期格式不正確');
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) {
    throw new Error('首期日期格式不正確');
  }
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) {
    throw new Error('首期日期格式不正確');
  }
  return { year: y, month: m, day: d };
}

function formatDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 將總金額依期數拆成每期金額，除不盡的零頭全部加在第 1 期。
 * 以最小單位整數運算避免浮點誤差，回傳陣列總和必等於 total。
 */
export function splitInstallment(total: number, count: number, decimals: number): number[] {
  assertValidInstallmentCount(count);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('分期總額必須大於 0');
  }

  const d = Math.max(0, Math.trunc(decimals));
  const totalUnits = toMinorUnits(total, d);
  if (totalUnits <= 0) {
    throw new Error('分期總額必須大於 0');
  }

  const baseUnits = Math.floor(totalUnits / count);
  const remainderUnits = totalUnits - baseUnits * count;

  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const units = i === 0 ? baseUnits + remainderUnits : baseUnits;
    result.push(fromMinorUnits(units, d));
  }
  return result;
}

/**
 * 依首期日期產生每月同一天的分期日期清單；當月無該日則取月底，且以首期的日為準。
 */
export function buildInstallmentDates(firstDate: string, count: number): string[] {
  assertValidInstallmentCount(count);
  const { year, month, day } = parseDateParts(firstDate);

  const dates: string[] = [];
  const startMonthIndex = year * 12 + (month - 1);
  for (let i = 0; i < count; i++) {
    const totalMonths = startMonthIndex + i;
    const targetYear = Math.floor(totalMonths / 12);
    const targetMonth = (totalMonths % 12) + 1;
    const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
    dates.push(formatDateParts(targetYear, targetMonth, targetDay));
  }
  return dates;
}

/**
 * 計算指定分期群組的已入帳與剩餘進度（date <= today 視為已入帳，忽略 deleted）。
 */
export function getInstallmentProgress(
  txs: readonly Transaction[],
  installmentId: string,
  today: string,
): InstallmentProgress {
  let count = 0;
  let total = 0;
  let paidCount = 0;
  let paidAmount = 0;
  let remainingCount = 0;
  let remainingAmount = 0;

  for (const tx of txs) {
    if (tx.deleted || tx.installmentId !== installmentId) {
      continue;
    }
    count += 1;
    total += tx.amount;
    if (tx.date <= today) {
      paidCount += 1;
      paidAmount += tx.amount;
    } else {
      remainingCount += 1;
      remainingAmount += tx.amount;
    }
  }

  return {
    count,
    total: roundToDecimals(total, 2),
    paidCount,
    paidAmount: roundToDecimals(paidAmount, 2),
    remainingCount,
    remainingAmount: roundToDecimals(remainingAmount, 2),
  };
}
