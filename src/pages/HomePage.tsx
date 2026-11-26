import { useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { TransactionRow } from '../components/TransactionRow';
import type { TransactionDraft } from '../components/TransactionSheet';
import {
  type AmountColors,
  confirmRecurringOccurrence,
  type PendingRecurringOccurrence,
  skipRecurringOccurrence,
} from '../db/repository';
import type { Account, Category, LotteryDraw, Place, Shortcut, Transaction } from '../db/types';
import {
  formatCurrency,
  formatMonthLabel,
  formatPeriodShortLabel,
  getCurrentMonthString,
  getLatestDrawnPeriod,
  matchPeriod,
  monthSummary,
} from '../domain';
import { useOutboxCount } from '../hooks/useExpenseData';
import {
  formatSyncStatusText,
  formatSyncTimeLabel,
  loginAndSync,
  type SyncState,
  triggerSync,
} from '../sync/syncManager';

interface HomePageProps {
  transactions: readonly Transaction[];
  shortcuts: readonly Shortcut[];
  lotteryDraws: readonly LotteryDraw[];
  accountMap: ReadonlyMap<string, Account>;
  categoryMap: ReadonlyMap<string, Category>;
  placeMap: ReadonlyMap<string, Place>;
  amountColors: AmountColors;
  syncState: SyncState;
  pendingRecurring: readonly PendingRecurringOccurrence[];
  onOpenCreate: (draft?: TransactionDraft) => void;
  onEditTransaction: (tx: Transaction) => void;
  onQuickRecordShortcut: (shortcut: Shortcut) => void;
  onEditShortcut: (shortcut: Shortcut) => void;
}

export function HomePage({
  transactions,
  shortcuts,
  lotteryDraws,
  accountMap,
  categoryMap,
  placeMap,
  amountColors,
  syncState,
  pendingRecurring,
  onOpenCreate,
  onEditTransaction,
  onQuickRecordShortcut,
  onEditShortcut,
}: HomePageProps) {
  const currentMonth = getCurrentMonthString();
  const summary = useMemo(() => monthSummary(transactions, currentMonth), [transactions, currentMonth]);
  const recentTransactions = useMemo(() => transactions.slice(0, 10), [transactions]);
  const visibleShortcuts = useMemo(() => shortcuts.slice(0, 8), [shortcuts]);
  const latestDrawnPeriod = getLatestDrawnPeriod();
  const latestDraw = useMemo(
    () => lotteryDraws.find((d) => d.period === latestDrawnPeriod) ?? null,
    [lotteryDraws, latestDrawnPeriod],
  );
  const latestMatchResult = useMemo(
    () => (latestDraw ? matchPeriod(transactions, latestDraw) : null),
    [transactions, latestDraw],
  );
  const outboxCount = useOutboxCount();
  const syncStatusText = formatSyncStatusText(syncState);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  return (
    <div className="space-y-4 pb-40">
      <div className="flex items-center justify-end px-1">
        {syncState.status !== 'disabled' && syncState.status !== 'syncing' && outboxCount > 0 ? (
          <button
            type="button"
            onClick={() => void triggerSync()}
            className="text-xs font-medium text-amber-600 underline-offset-2 hover:underline dark:text-amber-400"
          >
            有 {outboxCount} 筆尚未同步
          </button>
        ) : (
          <span className="text-xs text-slate-500 dark:text-slate-400">{syncStatusText}</span>
        )}
      </div>

      {syncState.status === 'error' && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900 dark:border-red-800/70 dark:bg-red-950/40 dark:text-red-100"
        >
          <div className="min-w-0 space-y-0.5">
            <div className="font-semibold">
              同步失敗：{syncState.errorMessage ?? '未知錯誤'}
            </div>
            <div className="text-red-700 dark:text-red-300">
              上次成功同步：
              {syncState.lastSyncAt ? formatSyncTimeLabel(syncState.lastSyncAt) : '尚未同步'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void triggerSync()}
            className="shrink-0 rounded-xl bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700"
          >
            重試
          </button>
        </div>
      )}

      {syncState.status === 'reauth' && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <div className="font-semibold">Google 登入已過期，請重新登入</div>
          <button
            type="button"
            onClick={() => void loginAndSync()}
            className="shrink-0 rounded-xl bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700"
          >
            重新登入
          </button>
        </div>
      )}

      {syncState.status === 'offline' && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-100 px-4 py-3 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-100"
        >
          <div className="font-medium">目前離線，資料已存在手機，恢復網路後會自動同步</div>
          <span className="shrink-0 font-semibold tabular-nums text-slate-600 dark:text-slate-300">
            未同步 {outboxCount} 筆
          </span>
        </div>
      )}

      {/* 本月收支摘要卡片 */}
      <section className="rounded-2xl bg-slate-900 p-5 text-white shadow-sm dark:bg-slate-800">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-base font-semibold">{formatMonthLabel(currentMonth)}收支</h1>
          <span className="text-xs text-slate-300">僅計入一般收支</span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-xs text-slate-300">本月支出</div>
            <div className="mt-1 text-lg font-bold tabular-nums" style={{ color: amountColors.expense }}>
              {formatCurrency(summary.expense)}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-300">本月收入</div>
            <div className="mt-1 text-lg font-bold tabular-nums" style={{ color: amountColors.income }}>
              {formatCurrency(summary.income)}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-300">結餘</div>
            <div className="mt-1 text-lg font-bold tabular-nums text-white">
              {formatCurrency(summary.net)}
            </div>
          </div>
        </div>
      </section>

      {/* 發票對獎提醒小卡 */}
      {!latestDraw ? (
        <Link
          to="/lottery"
          className="flex items-center justify-between rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100 dark:hover:bg-amber-950/50"
        >
          <span>🎟️ {formatPeriodShortLabel(latestDrawnPeriod)}發票開獎了，去對獎</span>
          <span className="text-xs text-amber-700 dark:text-amber-300">前往 →</span>
        </Link>
      ) : (
        latestMatchResult &&
        latestMatchResult.matched.length > 0 && (
          <Link
            to="/lottery"
            className="flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900 transition-colors hover:bg-emerald-100 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-100 dark:hover:bg-emerald-950/60"
          >
            <span>
              🎉 中獎 {latestMatchResult.matched.length} 張，共{' '}
              {formatCurrency(latestMatchResult.totalAmount)}
            </span>
            <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
              查看明細 →
            </span>
          </Link>
        )
      )}

      {/* 待確認週期性收支卡片 */}
      {pendingRecurring.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/70 dark:border-amber-800/70 dark:bg-amber-950/30">
          <div className="flex items-center justify-between border-b border-amber-200/70 px-4 py-2.5 dark:border-amber-800/60">
            <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              待確認週期收支（{pendingRecurring.length}）
            </h2>
          </div>
          <div className="divide-y divide-amber-200/60 dark:divide-amber-800/50">
            {pendingRecurring.map((item) => {
              const { rule, occurrenceDate } = item;
              const category = rule.categoryId ? categoryMap.get(rule.categoryId) : undefined;
              const account = accountMap.get(rule.accountId);
              const toAccount = rule.toAccountId ? accountMap.get(rule.toAccountId) : undefined;
              const title =
                rule.note ||
                (rule.kind === 'transfer'
                  ? `${account?.name ?? '帳戶'} → ${toAccount?.name ?? '帳戶'}`
                  : (category?.name ?? '週期收支'));

              return (
                <div
                  key={item.transactionId}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      <span>🔁</span>
                      <span className="truncate">{title}</span>
                    </div>
                    <div className="text-xs text-slate-600 dark:text-slate-400">
                      {occurrenceDate} · {account?.name ?? ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className="text-sm font-semibold tabular-nums"
                      style={
                        rule.kind === 'expense'
                          ? { color: amountColors.expense }
                          : rule.kind === 'income'
                            ? { color: amountColors.income }
                            : undefined
                      }
                    >
                      {formatCurrency(rule.amount)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void confirmRecurringOccurrence(rule, occurrenceDate)}
                      className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                    >
                      入帳
                    </button>
                    <button
                      type="button"
                      onClick={() => void skipRecurringOccurrence(rule, occurrenceDate)}
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    >
                      略過這期
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 最近 10 筆紀錄 */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">最近紀錄</h2>
          <Link to="/transactions" className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            查看全部
          </Link>
        </div>

        {recentTransactions.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            尚無記帳紀錄，點擊右下角「＋」開始記一筆
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {recentTransactions.map((tx) => (
              <TransactionRow
                key={tx.id}
                transaction={tx}
                accountMap={accountMap}
                categoryMap={categoryMap}
                placeMap={placeMap}
                amountColors={amountColors}
                onSelect={onEditTransaction}
                showDate
              />
            ))}
          </div>
        )}
      </section>

      {/* 首頁捷徑列（「＋」按鈕上方） */}
      <div className="fixed bottom-[148px] left-1/2 z-20 w-full max-w-[720px] -translate-x-1/2 px-4">
        {visibleShortcuts.length === 0 ? (
          <div className="pointer-events-none flex justify-end">
            <span className="rounded-full border border-slate-200/80 bg-white/90 px-3 py-1 text-[11px] text-slate-500 shadow-sm backdrop-blur dark:border-slate-700/80 dark:bg-slate-900/90 dark:text-slate-400">
              記帳後點「存成捷徑」或至設定頁新增首頁捷徑
            </span>
          </div>
        ) : (
          <div
            className="flex items-center gap-2 overflow-x-auto py-1"
            aria-label="首頁捷徑列"
          >
            {visibleShortcuts.map((shortcut) => (
              <button
                key={shortcut.id}
                type="button"
                onClick={() => {
                  if (longPressTriggeredRef.current) {
                    longPressTriggeredRef.current = false;
                    return;
                  }
                  if (shortcut.amount !== null) {
                    onQuickRecordShortcut(shortcut);
                  } else {
                    onOpenCreate({
                      kind: shortcut.kind,
                      amount: null,
                      accountId: shortcut.accountId,
                      toAccountId: shortcut.toAccountId,
                      categoryId: shortcut.categoryId,
                      note: shortcut.note,
                    });
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onEditShortcut(shortcut);
                }}
                onTouchStart={() => {
                  longPressTriggeredRef.current = false;
                  clearLongPressTimer();
                  longPressTimerRef.current = window.setTimeout(() => {
                    longPressTriggeredRef.current = true;
                    onEditShortcut(shortcut);
                  }, 500);
                }}
                onTouchEnd={clearLongPressTimer}
                onTouchMove={clearLongPressTimer}
                onTouchCancel={clearLongPressTimer}
                title="點一下記帳，長按或右鍵可編輯／刪除"
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-slate-800 shadow-sm backdrop-blur transition-colors hover:border-emerald-400 hover:bg-emerald-50 active:scale-95 dark:border-slate-700 dark:bg-slate-800/95 dark:text-slate-100 dark:hover:border-emerald-500 dark:hover:bg-slate-800"
              >
                <span aria-hidden="true">{shortcut.icon}</span>
                <span>{shortcut.label}</span>
                {shortcut.amount !== null && (
                  <span
                    className="tabular-nums font-semibold"
                    style={
                      shortcut.kind === 'expense'
                        ? { color: amountColors.expense }
                        : shortcut.kind === 'income'
                          ? { color: amountColors.income }
                          : undefined
                    }
                  >
                    {formatCurrency(shortcut.amount)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 右下角固定新增按鈕 */}
      <button
        type="button"
        onClick={() => onOpenCreate()}
        aria-label="記一筆"
        className="fixed bottom-20 right-5 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-2xl font-bold text-white shadow-lg transition-transform hover:scale-105 hover:bg-emerald-700 active:scale-95 dark:bg-emerald-500 dark:hover:bg-emerald-600"
      >
        ＋
      </button>
    </div>
  );
}
