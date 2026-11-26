import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMoney } from '../contexts/PrivacyContext';
import { TransactionRow } from '../components/TransactionRow';
import type { AmountColors } from '../db/repository';
import type { Account, Category, Place, Transaction, TransactionKind } from '../db/types';
import {
  collectRecentTags,
  filterTransactions,
  formatDateWithWeekday,
  formatMonthLabel,
  getCurrentMonthString,
  groupByDay,
  shiftMonth,
  summarizeFiltered,
  type InvoiceFilterOption,
  type TransactionFilterRange,
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

type RangeMode = 'month' | 'all' | 'custom';

const KIND_OPTIONS: Array<{ value: TransactionKind; label: string }> = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '轉帳' },
];

const KIND_LABELS: Record<TransactionKind, string> = {
  expense: '支出',
  income: '收入',
  transfer: '轉帳',
};

const INVOICE_OPTIONS: Array<{ value: InvoiceFilterOption; label: string }> = [
  { value: 'any', label: '全部' },
  { value: 'with', label: '有發票' },
  { value: 'without', label: '無發票' },
];

function parseOptionalAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }
  return num;
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
  const [rangeMode, setRangeMode] = useState<RangeMode>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [searchText, setSearchText] = useState('');
  const [selectedKinds, setSelectedKinds] = useState<TransactionKind[]>([]);
  const [minAmount, setMinAmount] = useState<number | null>(null);
  const [maxAmount, setMaxAmount] = useState<number | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId);
  const [selectedPlaceId, setSelectedPlaceId] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceFilterOption>('any');

  // 進階篩選底部面板狀態（暫存，按「套用」才生效）
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [draftRangeMode, setDraftRangeMode] = useState<RangeMode>('month');
  const [draftCustomFrom, setDraftCustomFrom] = useState('');
  const [draftCustomTo, setDraftCustomTo] = useState('');
  const [draftKinds, setDraftKinds] = useState<TransactionKind[]>([]);
  const [draftMinAmountText, setDraftMinAmountText] = useState('');
  const [draftMaxAmountText, setDraftMaxAmountText] = useState('');
  const [draftCategoryId, setDraftCategoryId] = useState('');
  const [draftAccountId, setDraftAccountId] = useState('');
  const [draftPlaceId, setDraftPlaceId] = useState('');
  const [draftTag, setDraftTag] = useState('');
  const [draftInvoice, setDraftInvoice] = useState<InvoiceFilterOption>('any');

  useEffect(() => {
    setSelectedAccountId(initialAccountId);
  }, [initialAccountId]);

  const filterCategories = useMemo(() => {
    return categories.filter((c) => !c.archived);
  }, [categories]);

  const availableTags = useMemo(() => collectRecentTags(transactions, 100), [transactions]);

  const activeRange: TransactionFilterRange = useMemo(() => {
    if (rangeMode === 'all') {
      return { kind: 'all' };
    }
    if (rangeMode === 'custom') {
      return { kind: 'custom', from: customFrom, to: customTo };
    }
    return { kind: 'month', month };
  }, [rangeMode, month, customFrom, customTo]);

  const filteredTransactions = useMemo(() => {
    return filterTransactions(
      transactions,
      {
        range: activeRange,
        keyword: searchText,
        kinds: selectedKinds,
        minAmount,
        maxAmount,
        categoryId: selectedCategoryId,
        accountId: selectedAccountId,
        placeId: selectedPlaceId,
        tag: selectedTag,
        invoice: invoiceFilter,
      },
      { categoryMap, accountMap, placeMap },
    );
  }, [
    transactions,
    activeRange,
    searchText,
    selectedKinds,
    minAmount,
    maxAmount,
    selectedCategoryId,
    selectedAccountId,
    selectedPlaceId,
    selectedTag,
    invoiceFilter,
    categoryMap,
    accountMap,
    placeMap,
  ]);

  const summary = useMemo(() => summarizeFiltered(filteredTransactions), [filteredTransactions]);
  const dayGroups = useMemo(() => groupByDay(filteredTransactions), [filteredTransactions]);

  const advancedFilterCount = useMemo(() => {
    let count = 0;
    if (rangeMode !== 'month') count += 1;
    if (selectedKinds.length > 0) count += 1;
    if (minAmount !== null || maxAmount !== null) count += 1;
    if (invoiceFilter !== 'any') count += 1;
    if (selectedCategoryId) count += 1;
    if (selectedAccountId) count += 1;
    if (selectedPlaceId) count += 1;
    if (selectedTag) count += 1;
    return count;
  }, [
    rangeMode,
    selectedKinds,
    minAmount,
    maxAmount,
    invoiceFilter,
    selectedCategoryId,
    selectedAccountId,
    selectedPlaceId,
    selectedTag,
  ]);

  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];

    if (rangeMode === 'all') {
      chips.push({
        key: 'range-all',
        label: '期間：全部月份',
        onRemove: () => setRangeMode('month'),
      });
    } else if (rangeMode === 'custom') {
      chips.push({
        key: 'range-custom',
        label: `期間：${customFrom || '不限'} ～ ${customTo || '不限'}`,
        onRemove: () => {
          setRangeMode('month');
          setCustomFrom('');
          setCustomTo('');
        },
      });
    }

    if (searchText.trim()) {
      chips.push({
        key: 'keyword',
        label: `關鍵字：${searchText.trim()}`,
        onRemove: () => setSearchText(''),
      });
    }

    for (const kind of selectedKinds) {
      chips.push({
        key: `kind-${kind}`,
        label: `類型：${KIND_LABELS[kind]}`,
        onRemove: () => setSelectedKinds((prev) => prev.filter((k) => k !== kind)),
      });
    }

    if (minAmount !== null || maxAmount !== null) {
      let amountLabel = '金額：';
      if (minAmount !== null && maxAmount !== null) {
        amountLabel += `${minAmount.toLocaleString('en-US')} ～ ${maxAmount.toLocaleString('en-US')}`;
      } else if (minAmount !== null) {
        amountLabel += `≥ ${minAmount.toLocaleString('en-US')}`;
      } else if (maxAmount !== null) {
        amountLabel += `≤ ${maxAmount.toLocaleString('en-US')}`;
      }
      chips.push({
        key: 'amount',
        label: amountLabel,
        onRemove: () => {
          setMinAmount(null);
          setMaxAmount(null);
        },
      });
    }

    if (invoiceFilter !== 'any') {
      chips.push({
        key: 'invoice',
        label: invoiceFilter === 'with' ? '有發票' : '無發票',
        onRemove: () => setInvoiceFilter('any'),
      });
    }

    if (selectedCategoryId) {
      chips.push({
        key: 'category',
        label: `分類：${categoryMap.get(selectedCategoryId)?.name ?? '已選分類'}`,
        onRemove: () => setSelectedCategoryId(''),
      });
    }

    if (selectedAccountId) {
      chips.push({
        key: 'account',
        label: `帳戶：${accountMap.get(selectedAccountId)?.name ?? '已選帳戶'}`,
        onRemove: () => setSelectedAccountId(''),
      });
    }

    if (selectedPlaceId) {
      chips.push({
        key: 'place',
        label: `地點：${placeMap.get(selectedPlaceId)?.name ?? '已選地點'}`,
        onRemove: () => setSelectedPlaceId(''),
      });
    }

    if (selectedTag) {
      chips.push({
        key: 'tag',
        label: `標籤：#${selectedTag}`,
        onRemove: () => setSelectedTag(''),
      });
    }

    return chips;
  }, [
    rangeMode,
    customFrom,
    customTo,
    searchText,
    selectedKinds,
    minAmount,
    maxAmount,
    invoiceFilter,
    selectedCategoryId,
    selectedAccountId,
    selectedPlaceId,
    selectedTag,
    categoryMap,
    accountMap,
    placeMap,
  ]);

  function openFilterSheet() {
    setDraftRangeMode(rangeMode);
    setDraftCustomFrom(customFrom);
    setDraftCustomTo(customTo);
    setDraftKinds(selectedKinds);
    setDraftMinAmountText(minAmount !== null ? String(minAmount) : '');
    setDraftMaxAmountText(maxAmount !== null ? String(maxAmount) : '');
    setDraftCategoryId(selectedCategoryId);
    setDraftAccountId(selectedAccountId);
    setDraftPlaceId(selectedPlaceId);
    setDraftTag(selectedTag);
    setDraftInvoice(invoiceFilter);
    setFilterSheetOpen(true);
  }

  function toggleDraftKind(kind: TransactionKind) {
    setDraftKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );
  }

  function handleClearDraft() {
    setDraftRangeMode('month');
    setDraftCustomFrom('');
    setDraftCustomTo('');
    setDraftKinds([]);
    setDraftMinAmountText('');
    setDraftMaxAmountText('');
    setDraftCategoryId('');
    setDraftAccountId('');
    setDraftPlaceId('');
    setDraftTag('');
    setDraftInvoice('any');
  }

  function handleApplyFilter() {
    setRangeMode(draftRangeMode);
    setCustomFrom(draftCustomFrom);
    setCustomTo(draftCustomTo);
    setSelectedKinds(draftKinds);
    setMinAmount(parseOptionalAmount(draftMinAmountText));
    setMaxAmount(parseOptionalAmount(draftMaxAmountText));
    setSelectedCategoryId(draftCategoryId);
    setSelectedAccountId(draftAccountId);
    setSelectedPlaceId(draftPlaceId);
    setSelectedTag(draftTag);
    setInvoiceFilter(draftInvoice);
    setFilterSheetOpen(false);
  }

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

      {/* 期間切換列 */}
      {rangeMode === 'month' ? (
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
      ) : (
        <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {rangeMode === 'all'
              ? '全部月份'
              : `自訂期間：${customFrom || '不限'} ～ ${customTo || '不限'}`}
          </h1>
          <button
            type="button"
            onClick={() => {
              setRangeMode('month');
              setMonth(getCurrentMonthString());
            }}
            className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            切回本月
          </button>
        </div>
      )}

      {/* 搜尋框與篩選按鈕 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="搜尋備註、#標籤、分類、地點、帳戶、發票或金額..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <button
            type="button"
            onClick={openFilterSheet}
            className={`inline-flex shrink-0 items-center gap-1 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
              advancedFilterCount > 0
                ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-300'
                : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
            }`}
          >
            <span>篩選</span>
            {advancedFilterCount > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1.5 text-xs font-semibold text-white">
                {advancedFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* 已套用條件膠囊與合計 */}
      {activeChips.length > 0 && (
        <div className="space-y-2 rounded-2xl border border-slate-200 bg-white px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap gap-1.5">
            {activeChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
              >
                <span>{chip.label}</span>
                <button
                  type="button"
                  onClick={chip.onRemove}
                  aria-label={`移除${chip.label}`}
                  className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-emerald-600 hover:bg-emerald-200/70 dark:text-emerald-300 dark:hover:bg-emerald-800"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-slate-600 tabular-nums dark:text-slate-300">
            <span>共 {summary.count} 筆</span>
            <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">
              ｜
            </span>
            <span style={{ color: amountColors.expense }}>
              支出 {formatMoney(summary.expenseTotal)}
            </span>
            <span style={{ color: amountColors.income }}>
              收入 {formatMoney(summary.incomeTotal)}
            </span>
          </div>
        </div>
      )}

      {/* 每日分組清單 */}
      {dayGroups.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-12 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          {rangeMode === 'month' && searchText.trim() !== '' ? (
            <div className="space-y-3">
              <p>本月沒有符合條件的紀錄</p>
              <button
                type="button"
                onClick={() => setRangeMode('all')}
                className="inline-flex items-center rounded-xl bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-700"
              >
                本月沒有符合的紀錄，要搜尋全部月份嗎？
              </button>
            </div>
          ) : rangeMode === 'month' ? (
            '本月沒有符合條件的紀錄'
          ) : (
            '沒有符合條件的紀錄'
          )}
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

      {/* 進階篩選底部面板 */}
      {filterSheetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-[1px]"
          onClick={() => setFilterSheetOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="進階篩選"
        >
          <div
            className="max-h-[92vh] w-full max-w-[720px] overflow-y-auto rounded-t-2xl bg-white p-4 pb-6 shadow-2xl dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                進階篩選
              </h2>
              <button
                type="button"
                onClick={() => setFilterSheetOpen(false)}
                className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                關閉
              </button>
            </div>

            <div className="space-y-4">
              {/* 期間 */}
              <div>
                <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  期間
                </div>
                <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
                  {[
                    { value: 'month' as const, label: '本月' },
                    { value: 'all' as const, label: '全部' },
                    { value: 'custom' as const, label: '自訂起訖日' },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setDraftRangeMode(opt.value)}
                      className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                        draftRangeMode === opt.value
                          ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                          : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {draftRangeMode === 'custom' && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">
                        開始日期
                      </span>
                      <input
                        type="date"
                        value={draftCustomFrom}
                        onChange={(e) => setDraftCustomFrom(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">
                        結束日期
                      </span>
                      <input
                        type="date"
                        value={draftCustomTo}
                        onChange={(e) => setDraftCustomTo(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* 類型（可多選） */}
              <div>
                <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  類型（可多選）
                </div>
                <div className="flex flex-wrap gap-2">
                  {KIND_OPTIONS.map((opt) => {
                    const selected = draftKinds.includes(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => toggleDraftKind(opt.value)}
                        className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
                          selected
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-300'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 金額範圍 */}
              <div>
                <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  金額範圍
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    placeholder="最低金額"
                    value={draftMinAmountText}
                    onChange={(e) => setDraftMinAmountText(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    placeholder="最高金額"
                    value={draftMaxAmountText}
                    onChange={(e) => setDraftMaxAmountText(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                </div>
              </div>

              {/* 有無發票 */}
              <div>
                <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  有無發票
                </div>
                <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
                  {INVOICE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setDraftInvoice(opt.value)}
                      className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                        draftInvoice === opt.value
                          ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                          : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 分類／帳戶／地點／標籤下拉 */}
              <div>
                <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  其他條件
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    aria-label="篩選分類"
                    value={draftCategoryId}
                    onChange={(e) => setDraftCategoryId(e.target.value)}
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
                    value={draftAccountId}
                    onChange={(e) => setDraftAccountId(e.target.value)}
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
                    value={draftPlaceId}
                    onChange={(e) => setDraftPlaceId(e.target.value)}
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
                    value={draftTag}
                    onChange={(e) => setDraftTag(e.target.value)}
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
            </div>

            {/* 底部按鈕 */}
            <div className="mt-6 flex items-center gap-2">
              <button
                type="button"
                onClick={handleClearDraft}
                className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                清除全部
              </button>
              <button
                type="button"
                onClick={handleApplyFilter}
                className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                套用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
