import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { TransactionRow } from '../components/TransactionRow';
import type { Account, Category, Transaction } from '../db/types';
import { formatCurrency, formatMonthLabel, getCurrentMonthString, monthSummary } from '../domain';
import { formatSyncStatusText, type SyncState } from '../sync/syncManager';

interface HomePageProps {
  transactions: readonly Transaction[];
  accountMap: ReadonlyMap<string, Account>;
  categoryMap: ReadonlyMap<string, Category>;
  syncState: SyncState;
  onOpenCreate: () => void;
  onEditTransaction: (tx: Transaction) => void;
}

export function HomePage({
  transactions,
  accountMap,
  categoryMap,
  syncState,
  onOpenCreate,
  onEditTransaction,
}: HomePageProps) {
  const currentMonth = getCurrentMonthString();
  const summary = useMemo(() => monthSummary(transactions, currentMonth), [transactions, currentMonth]);
  const recentTransactions = useMemo(() => transactions.slice(0, 10), [transactions]);
  const syncStatusText = formatSyncStatusText(syncState);

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-end px-1">
        <span className="text-xs text-slate-500 dark:text-slate-400">{syncStatusText}</span>
      </div>

      {/* 本月收支摘要卡片 */}
      <section className="rounded-2xl bg-slate-900 p-5 text-white shadow-sm dark:bg-slate-800">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-base font-semibold">{formatMonthLabel(currentMonth)}收支</h1>
          <span className="text-xs text-slate-300">僅計入一般收支</span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-xs text-slate-300">本月支出</div>
            <div className="mt-1 text-lg font-bold tabular-nums text-red-400">
              {formatCurrency(summary.expense)}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-300">本月收入</div>
            <div className="mt-1 text-lg font-bold tabular-nums text-emerald-400">
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
                onSelect={onEditTransaction}
                showDate
              />
            ))}
          </div>
        )}
      </section>

      {/* 右下角固定新增按鈕 */}
      <button
        type="button"
        onClick={onOpenCreate}
        aria-label="記一筆"
        className="fixed bottom-20 right-5 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-2xl font-bold text-white shadow-lg transition-transform hover:scale-105 hover:bg-emerald-700 active:scale-95 dark:bg-emerald-500 dark:hover:bg-emerald-600"
      >
        ＋
      </button>
    </div>
  );
}
