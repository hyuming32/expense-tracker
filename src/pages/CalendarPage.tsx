import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMoney } from '../contexts/PrivacyContext';
import { TransactionRow } from '../components/TransactionRow';
import type { TransactionDraft } from '../components/TransactionSheet';
import { type AmountColors, setNoSpendDay } from '../db/repository';
import type { Account, Category, Member, NoSpendDay, Place, Transaction } from '../db/types';
import {
  collectActiveDays,
  computeMonthHabitStats,
  formatDateWithWeekday,
  formatMonthLabel,
  getCurrentMonthString,
  getTodayDateString,
  shiftMonth,
} from '../domain';

interface CalendarPageProps {
  transactions: readonly Transaction[];
  noSpendDays: readonly NoSpendDay[];
  defaultAccountId: string;
  accountMap: ReadonlyMap<string, Account>;
  categoryMap: ReadonlyMap<string, Category>;
  placeMap: ReadonlyMap<string, Place>;
  members?: readonly Member[];
  isFamilyMode?: boolean;
  amountColors: AmountColors;
  onOpenCreate: (draft?: TransactionDraft) => void;
  onEditTransaction: (tx: Transaction) => void;
}

const WEEKDAY_HEADERS = ['日', '一', '二', '三', '四', '五', '六'] as const;

export function CalendarPage({
  transactions,
  noSpendDays,
  defaultAccountId,
  accountMap,
  categoryMap,
  placeMap,
  members = [],
  isFamilyMode = false,
  amountColors,
  onOpenCreate,
  onEditTransaction,
}: CalendarPageProps) {
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const formatMoney = useMoney();
  const today = getTodayDateString();
  const [month, setMonth] = useState(getCurrentMonthString);
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [togglingNoSpend, setTogglingNoSpend] = useState(false);

  const activeDays = useMemo(
    () => collectActiveDays(transactions, noSpendDays),
    [transactions, noSpendDays],
  );

  const userRecordedDays = useMemo(() => {
    const set = new Set<string>();
    for (const tx of transactions) {
      if (!tx.deleted && !tx.recurringId) {
        set.add(tx.date);
      }
    }
    return set;
  }, [transactions]);

  const noSpendSet = useMemo(() => {
    const set = new Set<string>();
    for (const item of noSpendDays) {
      if (!item.deleted) {
        set.add(item.date);
      }
    }
    return set;
  }, [noSpendDays]);

  // 第一個有記帳的日子：在這之前的日期不算「空白日」
  const firstActiveDay = useMemo(() => {
    let first: string | null = null;
    for (const d of activeDays) {
      if (first === null || d < first) {
        first = d;
      }
    }
    return first;
  }, [activeDays]);

  const monthStats = useMemo(
    () => computeMonthHabitStats(month, activeDays, today, firstActiveDay),
    [month, activeDays, today, firstActiveDay],
  );

  const { txsByDate, expenseByDate } = useMemo(() => {
    const byDate = new Map<string, Transaction[]>();
    const expByDate = new Map<string, number>();

    for (const tx of transactions) {
      if (tx.deleted || !tx.date.startsWith(month)) {
        continue;
      }
      const list = byDate.get(tx.date) ?? [];
      list.push(tx);
      byDate.set(tx.date, list);

      if (tx.kind === 'expense') {
        expByDate.set(tx.date, (expByDate.get(tx.date) ?? 0) + tx.amount);
      }
    }

    return { txsByDate: byDate, expenseByDate: expByDate };
  }, [transactions, month]);

  const calendarCells = useMemo(() => {
    const [yearStr, monthStr] = month.split('-');
    const year = Number(yearStr);
    const monthNum = Number(monthStr);
    if (!year || !monthNum) {
      return [];
    }
    const firstWeekday = new Date(year, monthNum - 1, 1).getDay();
    const daysInMonth = new Date(year, monthNum, 0).getDate();

    const cells: Array<{ dateStr: string; day: number } | null> = [];
    for (let i = 0; i < firstWeekday; i += 1) {
      cells.push(null);
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push({
        dateStr: `${month}-${String(day).padStart(2, '0')}`,
        day,
      });
    }
    return cells;
  }, [month]);

  const selectedDayTxs = useMemo(
    () => (selectedDate ? (txsByDate.get(selectedDate) ?? []) : []),
    [selectedDate, txsByDate],
  );

  const isSelectedNoSpend = selectedDate ? noSpendSet.has(selectedDate) : false;

  function handleMonthChange(delta: number) {
    const nextMonth = shiftMonth(month, delta);
    setMonth(nextMonth);
    const currentMonth = getCurrentMonthString();
    if (nextMonth === currentMonth) {
      setSelectedDate(today);
    } else if (nextMonth < currentMonth) {
      setSelectedDate(`${nextMonth}-01`);
    } else {
      setSelectedDate('');
    }
  }

  async function handleToggleNoSpend() {
    if (!selectedDate || selectedDate > today || togglingNoSpend) {
      return;
    }
    setTogglingNoSpend(true);
    try {
      await setNoSpendDay(selectedDate, !isSelectedNoSpend);
    } finally {
      setTogglingNoSpend(false);
    }
  }

  function handleBackfillCreate() {
    if (!selectedDate || selectedDate > today) {
      return;
    }
    onOpenCreate({
      kind: 'expense',
      amount: null,
      accountId: defaultAccountId,
      toAccountId: null,
      categoryId: null,
      note: null,
      date: selectedDate,
    });
  }

  return (
    <div className="space-y-3 pb-24">
      <div className="flex items-center justify-between px-1">
        <Link
          to="/"
          className="text-sm font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
        >
          ← 回首頁
        </Link>
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
          已記 {monthStats.recordedDays} 天／空白 {monthStats.blankDays} 天
        </span>
      </div>

      {/* 月份切換列 */}
      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <button
          type="button"
          onClick={() => handleMonthChange(-1)}
          aria-label="上個月"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          ◀
        </button>
        <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {formatMonthLabel(month)} 補帳日曆
        </h1>
        <button
          type="button"
          onClick={() => handleMonthChange(1)}
          aria-label="下個月"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          ▶
        </button>
      </div>

      {/* 月曆格子 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-2 grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-slate-400 dark:text-slate-500">
          {WEEKDAY_HEADERS.map((label) => (
            <div key={label} className="py-1">
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {calendarCells.map((cell, index) => {
            if (!cell) {
              return <div key={`empty-${index}`} className="min-h-[54px]" />;
            }

            const { dateStr, day } = cell;
            const isFuture = dateStr > today;
            const isToday = dateStr === today;
            const isSelected = dateStr === selectedDate;
            const isUserRecorded = userRecordedDays.has(dateStr);
            const isNoSpend = noSpendSet.has(dateStr);
            const dayExpense = expenseByDate.get(dateStr) ?? 0;

            let cellStyle =
              'border-slate-200 bg-white text-slate-800 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-700';

            if (isFuture) {
              cellStyle =
                'cursor-not-allowed border-transparent bg-slate-100/70 text-slate-300 dark:bg-slate-800/40 dark:text-slate-600';
            } else if (isNoSpend && !isUserRecorded) {
              cellStyle =
                'border-emerald-200 bg-emerald-50 text-emerald-800 hover:border-emerald-300 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200';
            } else if (
              !isUserRecorded &&
              dateStr < today &&
              firstActiveDay !== null &&
              dateStr >= firstActiveDay
            ) {
              cellStyle =
                'border-red-200 bg-red-50 text-red-700 hover:border-red-300 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300';
            }

            return (
              <button
                key={dateStr}
                type="button"
                disabled={isFuture}
                onClick={() => setSelectedDate(dateStr)}
                aria-label={`${dateStr}`}
                className={`flex min-h-[54px] flex-col items-center justify-between rounded-xl border px-1 py-1.5 transition-colors ${cellStyle} ${
                  isSelected
                    ? 'ring-2 ring-emerald-500 ring-offset-1 dark:ring-offset-slate-900'
                    : isToday && !isFuture
                      ? 'ring-1 ring-slate-400 dark:ring-slate-500'
                      : ''
                }`}
              >
                <span className="text-xs font-semibold tabular-nums">{day}</span>
                {isNoSpend && !isUserRecorded ? (
                  <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                    ✓
                  </span>
                ) : dayExpense > 0 ? (
                  <span className="max-w-full truncate text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
                    {formatMoney(dayExpense)}
                  </span>
                ) : (
                  <span className="text-[10px] text-transparent">-</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 pt-2.5 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900" />
            有記帳
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded border border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/40" />
            空白日
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded border border-emerald-200 bg-emerald-50 dark:border-emerald-800/70 dark:bg-emerald-950/40" />
            沒花錢 ✓
          </span>
        </div>
      </section>

      {/* 選取日期的明細或補記操作 */}
      {selectedDate && selectedDate <= today && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {formatDateWithWeekday(selectedDate)}
            </div>
            {selectedDayTxs.length > 0 && (
              <button
                type="button"
                onClick={handleBackfillCreate}
                className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
              >
                ＋ 補記一筆
              </button>
            )}
          </div>

          {selectedDayTxs.length > 0 ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {selectedDayTxs.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  transaction={tx}
                  accountMap={accountMap}
                  categoryMap={categoryMap}
                  placeMap={placeMap}
                  memberMap={isFamilyMode ? memberMap : undefined}
                  isFamilyMode={isFamilyMode}
                  amountColors={amountColors}
                  onSelect={onEditTransaction}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-3 p-4">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isSelectedNoSpend
                  ? '這天已標記為「沒花錢」，不會中斷連續記帳天數。'
                  : '這天還沒有手動記帳紀錄，你可以補記一筆或標記為沒花錢。'}
              </p>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={handleBackfillCreate}
                  className="rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
                >
                  補記一筆
                </button>
                <button
                  type="button"
                  disabled={togglingNoSpend}
                  onClick={() => void handleToggleNoSpend()}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                    isSelectedNoSpend
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                      : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {isSelectedNoSpend ? '✓ 已標記沒花錢（點此取消）' : '這天沒花錢'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
