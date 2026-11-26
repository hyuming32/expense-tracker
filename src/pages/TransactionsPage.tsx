import { useMemo, useState } from 'react';
import { TransactionRow } from '../components/TransactionRow';
import type { Account, Category, Transaction } from '../db/types';
import {
  formatCurrency,
  formatDateWithWeekday,
  formatMonthLabel,
  getCurrentMonthString,
  groupByDay,
  shiftMonth,
} from '../domain';

interface TransactionsPageProps {
  transactions: readonly Transaction[];
  accounts: readonly Account[];
  categories: readonly Category[];
  accountMap: ReadonlyMap<string, Account>;
  categoryMap: ReadonlyMap<string, Category>;
  onEditTransaction: (tx: Transaction) => void;
}

export function TransactionsPage({
  transactions,
  accounts,
  categories,
  accountMap,
  categoryMap,
  onEditTransaction,
}: TransactionsPageProps) {
  const [month, setMonth] = useState(getCurrentMonthString);
  const [searchText, setSearchText] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');

  const filterCategories = useMemo(() => {
    return categories.filter((c) => !c.archived);
  }, [categories]);

  const filteredTransactions = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();

    return transactions.filter((tx) => {
      if (!tx.date.startsWith(month)) {
        return false;
      }
      if (keyword && !(tx.note ?? '').toLowerCase().includes(keyword)) {
        return false;
      }
      if (selectedCategoryId) {
        // 若選取的是父分類，同時比對其子分類
        const txCat = tx.categoryId ? categoryMap.get(tx.categoryId) : undefined;
        const matchesCat =
          tx.categoryId === selectedCategoryId || txCat?.parentId === selectedCategoryId;
        if (!matchesCat) {
          return false;
        }
      }
      if (selectedAccountId) {
        const matchesAcc =
          tx.accountId === selectedAccountId || tx.toAccountId === selectedAccountId;
        if (!matchesAcc) {
          return false;
        }
      }
      return true;
    });
  }, [transactions, month, searchText, selectedCategoryId, selectedAccountId, categoryMap]);

  const dayGroups = useMemo(() => groupByDay(filteredTransactions), [filteredTransactions]);

  return (
    <div className="space-y-3 pb-24">
      {/* 月份切換列 */}
      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
          aria-label="上個月"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          ◀
        </button>
        <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {formatMonthLabel(month)}
        </h1>
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
          aria-label="下個月"
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          ▶
        </button>
      </div>

      {/* 搜尋與篩選 */}
      <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <input
          type="search"
          placeholder="搜尋備註..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />

        <div className="grid grid-cols-2 gap-2">
          <select
            aria-label="篩選分類"
            value={selectedCategoryId}
            onChange={(e) => setSelectedCategoryId(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            <option value="">全部分類</option>
            {filterCategories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.icon} {cat.parentId ? `└ ${cat.name}` : cat.name}
              </option>
            ))}
          </select>

          <select
            aria-label="篩選帳戶"
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            <option value="">全部帳戶</option>
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 每日分組清單 */}
      {dayGroups.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-12 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          本月沒有符合條件的紀錄
        </div>
      ) : (
        <div className="space-y-3">
          {dayGroups.map((group) => (
            <section
              key={group.date}
              className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-800/50">
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {formatDateWithWeekday(group.date)}
                </span>
                <div className="flex items-center gap-3 tabular-nums">
                  {group.incomeTotal > 0 && (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      收 {formatCurrency(group.incomeTotal)}
                    </span>
                  )}
                  {group.expenseTotal > 0 && (
                    <span className="text-red-600 dark:text-red-400">
                      支 {formatCurrency(group.expenseTotal)}
                    </span>
                  )}
                </div>
              </div>

              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {group.transactions.map((tx) => (
                  <TransactionRow
                    key={tx.id}
                    transaction={tx}
                    accountMap={accountMap}
                    categoryMap={categoryMap}
                    onSelect={onEditTransaction}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
