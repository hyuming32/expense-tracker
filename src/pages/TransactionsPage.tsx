import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMoney } from '../contexts/PrivacyContext';
import { TransactionRow } from '../components/TransactionRow';
import type { AmountColors } from '../db/repository';
import type { Account, Category, Place, Transaction } from '../db/types';
import {
  collectRecentTags,
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
  places: readonly Place[];
  accountMap: ReadonlyMap<string, Account>;
  categoryMap: ReadonlyMap<string, Category>;
  placeMap: ReadonlyMap<string, Place>;
  amountColors: AmountColors;
  onEditTransaction: (tx: Transaction) => void;
  initialAccountId?: string;
  onBack?: () => void;
}

export function TransactionsPage({
  transactions,
  accounts,
  categories,
  places,
  accountMap,
  categoryMap,
  placeMap,
  amountColors,
  onEditTransaction,
  initialAccountId = '',
  onBack,
}: TransactionsPageProps) {
  const formatMoney = useMoney();
  const [month, setMonth] = useState(getCurrentMonthString);
  const [searchText, setSearchText] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId);
  const [selectedPlaceId, setSelectedPlaceId] = useState('');
  const [selectedTag, setSelectedTag] = useState('');

  useEffect(() => {
    setSelectedAccountId(initialAccountId);
  }, [initialAccountId]);

  const filterCategories = useMemo(() => {
    return categories.filter((c) => !c.archived);
  }, [categories]);

  const availableTags = useMemo(() => collectRecentTags(transactions, 100), [transactions]);

  const filteredTransactions = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();

    return transactions.filter((tx) => {
      if (!tx.date.startsWith(month)) {
        return false;
      }
      if (keyword) {
        const txTags = tx.tags ?? [];
        if (keyword.startsWith('#')) {
          const tagKeyword = keyword.slice(1).trim();
          const matchesTag = tagKeyword
            ? txTags.some((t) => t.toLowerCase().includes(tagKeyword))
            : txTags.length > 0;
          if (!matchesTag) {
            return false;
          }
        } else {
          const matchesNote = (tx.note ?? '').toLowerCase().includes(keyword);
          const matchesTag = txTags.some((t) => t.toLowerCase().includes(keyword));
          if (!matchesNote && !matchesTag) {
            return false;
          }
        }
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
      if (selectedPlaceId) {
        if (tx.placeId !== selectedPlaceId) {
          return false;
        }
      }
      if (selectedTag) {
        const targetTag = selectedTag.toLowerCase();
        if (!(tx.tags ?? []).some((t) => t.toLowerCase() === targetTag)) {
          return false;
        }
      }
      return true;
    });
  }, [
    transactions,
    month,
    searchText,
    selectedCategoryId,
    selectedAccountId,
    selectedPlaceId,
    selectedTag,
    categoryMap,
  ]);

  const dayGroups = useMemo(() => groupByDay(filteredTransactions), [filteredTransactions]);

  return (
    <div className="space-y-3 pb-24">
      {onBack && (
        <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900">
          <button
            type="button"
            onClick={onBack}
            className="text-sm font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
          >
            ← 返回帳戶
          </button>
          {selectedAccountId && (
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {accountMap.get(selectedAccountId)?.name ?? '帳戶明細'}
            </span>
          )}
        </div>
      )}

      {/* 補帳日曆入口 */}
      {!onBack && (
        <div className="flex justify-end">
          <Link
            to="/calendar"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-emerald-300 hover:text-emerald-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-emerald-700 dark:hover:text-emerald-300"
          >
            <span aria-hidden="true">📅</span>
            <span>補帳日曆 →</span>
          </Link>
        </div>
      )}

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
          placeholder="搜尋備註或 #標籤..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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

          <select
            aria-label="篩選地點"
            value={selectedPlaceId}
            onChange={(e) => setSelectedPlaceId(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            <option value="">全部地點</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.icon} {place.name}
              </option>
            ))}
          </select>

          <select
            aria-label="篩選標籤"
            value={selectedTag}
            onChange={(e) => setSelectedTag(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            <option value="">全部標籤</option>
            {availableTags.map((tag) => (
              <option key={tag} value={tag}>
                #{tag}
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
                    <span style={{ color: amountColors.income }}>
                      收 {formatMoney(group.incomeTotal)}
                    </span>
                  )}
                  {group.expenseTotal > 0 && (
                    <span style={{ color: amountColors.expense }}>
                      支 {formatMoney(group.expenseTotal)}
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
                    placeMap={placeMap}
                    amountColors={amountColors}
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
