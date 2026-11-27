import { useEffect, useMemo, useState } from 'react';
import {
  type AmountColors,
  processRecurringRules,
  saveRecurringRule,
  softDeleteRecurringRule,
} from '../db/repository';
import type {
  Account,
  Category,
  RecurringFrequency,
  RecurringRule,
  TransactionKind,
} from '../db/types';
import {
  getTodayDateString,
  type MainCurrencyInfo,
  validateRecurringRule,
} from '../domain';
import type { LastUsedMeta } from '../hooks/useExpenseData';

export interface RecurringRuleDraft {
  kind: TransactionKind;
  amount: number;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  note: string | null;
  frequency: RecurringFrequency;
  dayOfMonth: number;
  weekday: number;
  monthOfYear: number;
  startDate: string;
  endDate: string | null;
  autoPost: boolean;
}

interface RecurringRuleSheetProps {
  open: boolean;
  editingRule: RecurringRule | null;
  initialDraft?: RecurringRuleDraft | null;
  accounts: readonly Account[];
  categories: readonly Category[];
  lastUsed: LastUsedMeta;
  amountColors: AmountColors;
  mainCurrency?: MainCurrencyInfo;
  onClose: () => void;
  onSaved?: (rule: RecurringRule) => void;
}

const DEFAULT_MAIN_CURRENCY: MainCurrencyInfo = {
  code: 'TWD',
  name: '新台幣',
  decimals: 0,
  symbol: 'NT$',
};

const KIND_TABS: Array<{ value: TransactionKind; label: string }> = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '轉帳' },
];

const FREQUENCY_TABS: Array<{ value: RecurringFrequency; label: string }> = [
  { value: 'monthly', label: '每月' },
  { value: 'weekly', label: '每週' },
  { value: 'yearly', label: '每年' },
];

const WEEKDAY_OPTIONS = [
  { value: 0, label: '週日' },
  { value: 1, label: '週一' },
  { value: 2, label: '週二' },
  { value: 3, label: '週三' },
  { value: 4, label: '週四' },
  { value: 5, label: '週五' },
  { value: 6, label: '週六' },
];

export function RecurringRuleSheet({
  open,
  editingRule,
  initialDraft,
  accounts,
  categories,
  lastUsed,
  amountColors,
  mainCurrency = DEFAULT_MAIN_CURRENCY,
  onClose,
  onSaved,
}: RecurringRuleSheetProps) {
  const [kind, setKind] = useState<TransactionKind>('expense');
  const [amountText, setAmountText] = useState('');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [expandedParentId, setExpandedParentId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [frequency, setFrequency] = useState<RecurringFrequency>('monthly');
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [weekday, setWeekday] = useState(1);
  const [monthOfYear, setMonthOfYear] = useState(1);
  const [startDate, setStartDate] = useState(getTodayDateString);
  const [endDate, setEndDate] = useState('');
  const [autoPost, setAutoPost] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const activeCategories = useMemo(
    () =>
      categories.filter((c) => !c.archived && c.kind === (kind === 'income' ? 'income' : 'expense')),
    [categories, kind],
  );

  const parentCategories = useMemo(
    () => activeCategories.filter((c) => c.parentId === null),
    [activeCategories],
  );

  const childrenByParent = useMemo(() => {
    const map = new Map<string, Category[]>();
    for (const cat of activeCategories) {
      if (cat.parentId) {
        const list = map.get(cat.parentId) ?? [];
        list.push(cat);
        map.set(cat.parentId, list);
      }
    }
    return map;
  }, [activeCategories]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setErrors([]);
    setConfirmingDelete(false);
    setSubmitting(false);

    const source = editingRule ?? initialDraft ?? null;
    if (source) {
      setKind(source.kind);
      setAmountText(source.amount > 0 ? String(source.amount) : '');
      setAccountId(source.accountId);
      setToAccountId(source.toAccountId ?? '');
      setCategoryId(source.categoryId);
      setNote(source.note ?? '');
      setFrequency(source.frequency);
      setDayOfMonth(source.dayOfMonth);
      setWeekday(source.weekday);
      setMonthOfYear(source.monthOfYear);
      setStartDate(source.startDate);
      setEndDate(source.endDate ?? '');
      setAutoPost(source.autoPost);

      if (source.categoryId) {
        const currentCat = categories.find((c) => c.id === source.categoryId);
        setExpandedParentId(currentCat?.parentId ?? currentCat?.id ?? null);
      } else {
        setExpandedParentId(null);
      }
    } else {
      const today = getTodayDateString();
      const now = new Date();
      const defaultAcc =
        (lastUsed.lastAccountId && accounts.some((a) => a.id === lastUsed.lastAccountId)
          ? lastUsed.lastAccountId
          : accounts[0]?.id) ?? '';
      const otherAcc = accounts.find((a) => a.id !== defaultAcc)?.id ?? '';
      const defaultExpCat =
        lastUsed.lastExpenseCategoryId &&
        categories.some((c) => c.id === lastUsed.lastExpenseCategoryId && !c.archived)
          ? lastUsed.lastExpenseCategoryId
          : null;

      setKind('expense');
      setAmountText('');
      setAccountId(defaultAcc);
      setToAccountId(otherAcc);
      setCategoryId(defaultExpCat);
      if (defaultExpCat) {
        const cat = categories.find((c) => c.id === defaultExpCat);
        setExpandedParentId(cat?.parentId ?? null);
      } else {
        setExpandedParentId(null);
      }
      setNote('');
      setFrequency('monthly');
      setDayOfMonth(now.getDate());
      setWeekday(now.getDay());
      setMonthOfYear(now.getMonth() + 1);
      setStartDate(today);
      setEndDate('');
      setAutoPost(true);
    }
  }, [open, editingRule, initialDraft, accounts, categories, lastUsed]);

  if (!open) {
    return null;
  }

  function handleKindChange(nextKind: TransactionKind) {
    setKind(nextKind);
    setErrors([]);
    setExpandedParentId(null);

    if (nextKind === 'transfer') {
      setCategoryId(null);
      if (!toAccountId || toAccountId === accountId) {
        setToAccountId(accounts.find((a) => a.id !== accountId)?.id ?? '');
      }
      return;
    }

    const candidateId =
      nextKind === 'expense' ? lastUsed.lastExpenseCategoryId : lastUsed.lastIncomeCategoryId;
    const valid = candidateId
      ? categories.find((c) => c.id === candidateId && c.kind === nextKind && !c.archived)
      : undefined;
    setCategoryId(valid?.id ?? null);
    setExpandedParentId(valid?.parentId ?? null);
  }

  function handleParentCategoryClick(parent: Category) {
    const children = childrenByParent.get(parent.id);
    if (children && children.length > 0) {
      setExpandedParentId((prev) => (prev === parent.id ? null : parent.id));
      setCategoryId(parent.id);
    } else {
      setExpandedParentId(null);
      setCategoryId(parent.id);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) {
      return;
    }

    const parsedAmount = Number(amountText.trim());
    const normalizedEndDate = endDate.trim() ? endDate.trim() : null;
    const payload = {
      kind,
      amount: parsedAmount,
      accountId,
      toAccountId: kind === 'transfer' ? toAccountId || null : null,
      categoryId: kind === 'transfer' ? null : categoryId,
      frequency,
      dayOfMonth,
      weekday,
      monthOfYear,
      startDate,
      endDate: normalizedEndDate,
    };

    const validationErrors = validateRecurringRule(payload, mainCurrency.decimals);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    setSubmitting(true);
    try {
      const saved = await saveRecurringRule({
        id: editingRule?.id,
        ...payload,
        note: note || null,
        paused: editingRule?.paused ?? false,
        autoPost,
      });
      if (!editingRule && saved.autoPost && !saved.paused) {
        await processRecurringRules();
      }
      onSaved?.(saved);
      onClose();
    } catch {
      setErrors(['儲存失敗，請稍後再試']);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!editingRule || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await softDeleteRecurringRule(editingRule.id);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const expandedChildren = expandedParentId ? (childrenByParent.get(expandedParentId) ?? []) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-[1px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={editingRule ? '編輯週期性收支' : '新增週期性收支'}
    >
      <div
        className="max-h-[92vh] w-full max-w-[720px] overflow-y-auto rounded-t-2xl bg-white p-4 pb-6 shadow-2xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {editingRule ? '編輯週期性收支' : '新增週期性收支'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            關閉
          </button>
        </div>

        {/* 收支類型切換 */}
        <div className="mb-4 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {KIND_TABS.map((tab) => {
            const active = kind === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                onClick={() => handleKindChange(tab.value)}
                className={`rounded-lg py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 金額輸入 */}
          <div>
            <label
              htmlFor="rec-amount"
              className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
            >
              金額（{mainCurrency.symbol.trimEnd()}）
            </label>
            <input
              id="rec-amount"
              type="text"
              inputMode={mainCurrency.decimals > 0 ? 'decimal' : 'numeric'}
              placeholder="0"
              value={amountText}
              onChange={(e) => {
                if (mainCurrency.decimals <= 0) {
                  setAmountText(e.target.value.replace(/[^\d]/g, ''));
                } else {
                  const cleaned = e.target.value.replace(/[^\d.]/g, '');
                  const dotIdx = cleaned.indexOf('.');
                  setAmountText(
                    dotIdx === -1
                      ? cleaned
                      : cleaned.slice(0, dotIdx + 1) + cleaned.slice(dotIdx + 1).replace(/\./g, ''),
                  );
                }
              }}
              style={
                kind === 'expense'
                  ? { color: amountColors.expense }
                  : kind === 'income'
                    ? { color: amountColors.income }
                    : undefined
              }
              className={`w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-2xl font-bold tabular-nums outline-none placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:placeholder:text-slate-500 dark:focus:border-emerald-400 dark:focus:bg-slate-800 ${
                kind === 'transfer' ? 'text-slate-900 dark:text-slate-100' : ''
              }`}
            />
          </div>

          {/* 分類選擇（僅支出與收入顯示） */}
          {kind !== 'transfer' && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                分類
              </div>
              <div className="grid grid-cols-5 gap-2">
                {parentCategories.map((cat) => {
                  const children = childrenByParent.get(cat.id) ?? [];
                  const isChildSelected = children.some((c) => c.id === categoryId);
                  const isSelected = categoryId === cat.id || isChildSelected;
                  const isExpanded = expandedParentId === cat.id;

                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => handleParentCategoryClick(cat)}
                      className={`flex flex-col items-center justify-center gap-1 rounded-xl border px-1 py-2 text-xs transition-colors ${
                        isSelected
                          ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-400 dark:bg-emerald-950/50 dark:text-emerald-300'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300 dark:hover:bg-slate-800'
                      }`}
                    >
                      <span className="text-xl leading-none">{cat.icon}</span>
                      <span className="max-w-full truncate">
                        {cat.name}
                        {children.length > 0 ? (isExpanded ? ' ▾' : ' ▸') : ''}
                      </span>
                    </button>
                  );
                })}
              </div>

              {expandedChildren.length > 0 && (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/60">
                  <div className="mb-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    子分類
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {expandedChildren.map((child) => {
                      const selected = categoryId === child.id;
                      return (
                        <button
                          key={child.id}
                          type="button"
                          onClick={() => setCategoryId(child.id)}
                          className={`flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                            selected
                              ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-400 dark:bg-emerald-950/60 dark:text-emerald-300'
                              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
                          }`}
                        >
                          <span>{child.icon}</span>
                          <span>{child.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 帳戶 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="rec-account"
                className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
              >
                {kind === 'transfer' ? '轉出帳戶' : '帳戶'}
              </label>
              <select
                id="rec-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name}
                  </option>
                ))}
              </select>
            </div>

            {kind === 'transfer' && (
              <div>
                <label
                  htmlFor="rec-to-account"
                  className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
                >
                  轉入帳戶
                </label>
                <select
                  id="rec-to-account"
                  value={toAccountId}
                  onChange={(e) => setToAccountId(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                >
                  <option value="">請選擇帳戶</option>
                  {accounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* 備註 */}
          <div>
            <label
              htmlFor="rec-note"
              className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
            >
              名稱／備註（選填）
            </label>
            <input
              id="rec-note"
              type="text"
              placeholder="例如：房租、Netflix、薪水..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
          </div>

          {/* 週期設定 */}
          <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
            <div>
              <div className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                重複頻率
              </div>
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-200/70 p-1 dark:bg-slate-900/60">
                {FREQUENCY_TABS.map((tab) => {
                  const active = frequency === tab.value;
                  return (
                    <button
                      key={tab.value}
                      type="button"
                      onClick={() => setFrequency(tab.value)}
                      className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                        active
                          ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {frequency === 'monthly' && (
              <div>
                <label
                  htmlFor="rec-day-of-month"
                  className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
                >
                  每月日期（若當月無該日則自動取月底）
                </label>
                <select
                  id="rec-day-of-month"
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      每月 {d} 日
                    </option>
                  ))}
                </select>
              </div>
            )}

            {frequency === 'weekly' && (
              <div>
                <label
                  htmlFor="rec-weekday"
                  className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
                >
                  每週幾
                </label>
                <select
                  id="rec-weekday"
                  value={weekday}
                  onChange={(e) => setWeekday(Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  {WEEKDAY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      每{opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {frequency === 'yearly' && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label
                    htmlFor="rec-month-of-year"
                    className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
                  >
                    月份
                  </label>
                  <select
                    id="rec-month-of-year"
                    value={monthOfYear}
                    onChange={(e) => setMonthOfYear(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={m}>
                        {m} 月
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="rec-yearly-day"
                    className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
                  >
                    日期
                  </label>
                  <select
                    id="rec-yearly-day"
                    value={dayOfMonth}
                    onChange={(e) => setDayOfMonth(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d} 日
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="rec-start-date"
                  className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
                >
                  開始日期
                </label>
                <input
                  id="rec-start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor="rec-end-date"
                  className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
                >
                  結束日期（選填）
                </label>
                <input
                  id="rec-end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-700 dark:bg-slate-900">
              <div>
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                  到期自動入帳
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  關閉時會在首頁顯示「待確認」卡片，由您手動確認入帳或略過
                </div>
              </div>
              <input
                type="checkbox"
                checked={autoPost}
                onChange={(e) => setAutoPost(e.target.checked)}
                className="h-4 w-4 accent-emerald-600"
              />
            </label>
          </div>

          {errors.length > 0 && (
            <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/50 dark:text-red-300">
              {errors.map((err) => (
                <div key={err}>• {err}</div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            {editingRule && !confirmingDelete && (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                刪除
              </button>
            )}

            {editingRule && confirmingDelete && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={submitting}
                  className="rounded-xl bg-red-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  確認刪除
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300"
                >
                  取消
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="ml-auto flex-1 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500 dark:hover:bg-emerald-600"
            >
              儲存規則
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
