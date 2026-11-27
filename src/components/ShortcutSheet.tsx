import { useEffect, useMemo, useState } from 'react';
import {
  type AmountColors,
  saveShortcut,
  softDeleteShortcut,
} from '../db/repository';
import type { Account, Category, Shortcut, TransactionKind } from '../db/types';
import { hasAtMostDecimals, type MainCurrencyInfo } from '../domain';
import type { LastUsedMeta } from '../hooks/useExpenseData';

export interface ShortcutDraft {
  label: string;
  icon: string;
  kind: TransactionKind;
  amount: number | null;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  note: string | null;
}

interface ShortcutSheetProps {
  open: boolean;
  editingShortcut: Shortcut | null;
  initialDraft: ShortcutDraft | null;
  accounts: readonly Account[];
  categories: readonly Category[];
  lastUsed: LastUsedMeta;
  amountColors: AmountColors;
  mainCurrency?: MainCurrencyInfo;
  onClose: () => void;
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

/**
 * 新增或編輯首頁捷徑的底部彈出面板。
 */
export function ShortcutSheet({
  open,
  editingShortcut,
  initialDraft,
  accounts,
  categories,
  lastUsed,
  amountColors,
  mainCurrency = DEFAULT_MAIN_CURRENCY,
  onClose,
}: ShortcutSheetProps) {
  const [kind, setKind] = useState<TransactionKind>('expense');
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState('⚡');
  const [iconEdited, setIconEdited] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [expandedParentId, setExpandedParentId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const activeCategories = useMemo(
    () => categories.filter((c) => !c.archived && c.kind === (kind === 'income' ? 'income' : 'expense')),
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

    setError(null);
    setConfirmingDelete(false);
    setSubmitting(false);

    const source = editingShortcut ?? initialDraft;
    if (source) {
      setKind(source.kind);
      setLabel(source.label);
      setIcon(source.icon);
      setIconEdited(Boolean(editingShortcut));
      setAmountText(source.amount !== null ? String(source.amount) : '');
      setAccountId(source.accountId);
      setToAccountId(source.toAccountId ?? '');
      setCategoryId(source.categoryId);
      setNote(source.note ?? '');

      if (source.categoryId) {
        const currentCat = categories.find((c) => c.id === source.categoryId);
        setExpandedParentId(currentCat?.parentId ?? currentCat?.id ?? null);
      } else {
        setExpandedParentId(null);
      }
      return;
    }

    const defaultAcc =
      (lastUsed.lastAccountId && accounts.some((a) => a.id === lastUsed.lastAccountId)
        ? lastUsed.lastAccountId
        : accounts[0]?.id) ?? '';
    const otherAcc = accounts.find((a) => a.id !== defaultAcc)?.id ?? '';
    const defaultExpCat =
      lastUsed.lastExpenseCategoryId &&
      categories.some((c) => c.id === lastUsed.lastExpenseCategoryId && !c.archived)
        ? lastUsed.lastExpenseCategoryId
        : (categories.find((c) => c.kind === 'expense' && !c.archived)?.id ?? null);
    const defaultCatObj = defaultExpCat ? categories.find((c) => c.id === defaultExpCat) : undefined;

    setKind('expense');
    setLabel('');
    setIcon(defaultCatObj?.icon ?? '⚡');
    setIconEdited(false);
    setAmountText('');
    setAccountId(defaultAcc);
    setToAccountId(otherAcc);
    setCategoryId(defaultExpCat);
    setExpandedParentId(defaultCatObj?.parentId ?? null);
    setNote('');
  }, [open, editingShortcut, initialDraft, accounts, categories, lastUsed]);

  if (!open) {
    return null;
  }

  function handleKindChange(nextKind: TransactionKind) {
    setKind(nextKind);
    setError(null);
    setExpandedParentId(null);

    if (nextKind === 'transfer') {
      setCategoryId(null);
      if (!iconEdited) {
        setIcon('🔄');
      }
      if (!toAccountId || toAccountId === accountId) {
        setToAccountId(accounts.find((a) => a.id !== accountId)?.id ?? '');
      }
      return;
    }

    const candidateId =
      nextKind === 'expense' ? lastUsed.lastExpenseCategoryId : lastUsed.lastIncomeCategoryId;
    const valid =
      (candidateId
        ? categories.find((c) => c.id === candidateId && c.kind === nextKind && !c.archived)
        : undefined) ?? categories.find((c) => c.kind === nextKind && !c.archived);
    setCategoryId(valid?.id ?? null);
    setExpandedParentId(valid?.parentId ?? null);
    if (!iconEdited) {
      setIcon(valid?.icon ?? '⚡');
    }
  }

  function handleSelectCategory(cat: Category) {
    setCategoryId(cat.id);
    if (!iconEdited) {
      setIcon(cat.icon);
    }
  }

  function handleParentCategoryClick(parent: Category) {
    const children = childrenByParent.get(parent.id);
    if (children && children.length > 0) {
      setExpandedParentId((prev) => (prev === parent.id ? null : parent.id));
    } else {
      setExpandedParentId(null);
    }
    handleSelectCategory(parent);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) {
      return;
    }

    const trimmedAmount = amountText.trim();
    let parsedAmount: number | null = null;
    if (trimmedAmount) {
      const n = Number(trimmedAmount);
      if (
        !Number.isFinite(n) ||
        n <= 0 ||
        !hasAtMostDecimals(n, mainCurrency.decimals)
      ) {
        setError(
          mainCurrency.decimals <= 0
            ? '金額需為正整數（或留空代表點擊時輸入）'
            : `金額需為正數且最多 ${mainCurrency.decimals} 位小數（或留空代表點擊時輸入）`,
        );
        return;
      }
      parsedAmount = n;
    }

    setSubmitting(true);
    setError(null);
    try {
      await saveShortcut({
        id: editingShortcut?.id,
        label,
        icon,
        kind,
        amount: parsedAmount,
        accountId,
        toAccountId: kind === 'transfer' ? toAccountId || null : null,
        categoryId: kind === 'transfer' ? null : categoryId,
        note: note.trim() ? note.trim() : null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存捷徑失敗');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!editingShortcut || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await softDeleteShortcut(editingShortcut.id);
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
      aria-label={editingShortcut ? '編輯首頁捷徑' : '新增首頁捷徑'}
    >
      <div
        className="max-h-[92vh] w-full max-w-[720px] overflow-y-auto rounded-t-2xl bg-white p-4 pb-6 shadow-2xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {editingShortcut ? '編輯首頁捷徑' : '新增首頁捷徑'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            關閉
          </button>
        </div>

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
          <div className="grid grid-cols-[76px_1fr] gap-2">
            <div>
              <label
                htmlFor="shortcut-icon"
                className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
              >
                圖示
              </label>
              <input
                id="shortcut-icon"
                type="text"
                maxLength={4}
                value={icon}
                onChange={(e) => {
                  setIcon(e.target.value);
                  setIconEdited(true);
                }}
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-center text-lg outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800"
              />
            </div>
            <div>
              <label
                htmlFor="shortcut-label"
                className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
              >
                捷徑名稱
              </label>
              <input
                id="shortcut-label"
                type="text"
                placeholder="例如：早餐、捷運"
                maxLength={20}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="shortcut-amount"
              className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
            >
              固定金額（選填；留空則點選後開啟面板輸入）
            </label>
            <input
              id="shortcut-amount"
              type="text"
              inputMode={mainCurrency.decimals > 0 ? 'decimal' : 'numeric'}
              placeholder="留空代表每次輸入金額"
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
              className={`w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xl font-bold tabular-nums outline-none placeholder:text-sm placeholder:font-normal placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:focus:bg-slate-900 dark:placeholder:text-slate-500 ${
                kind === 'transfer' ? 'text-slate-900 dark:text-slate-100' : ''
              }`}
            />
          </div>

          {kind !== 'transfer' && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">分類</div>
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
                          onClick={() => handleSelectCategory(child)}
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="shortcut-account"
                className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
              >
                {kind === 'transfer' ? '轉出帳戶' : '帳戶'}
              </label>
              <select
                id="shortcut-account"
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
                  htmlFor="shortcut-to-account"
                  className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
                >
                  轉入帳戶
                </label>
                <select
                  id="shortcut-to-account"
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

          <div>
            <label
              htmlFor="shortcut-note"
              className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
            >
              備註（選填）
            </label>
            <input
              id="shortcut-note"
              type="text"
              placeholder="輸入預設備註..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>

          {error && (
            <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/50 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            {editingShortcut && !confirmingDelete && (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                刪除
              </button>
            )}

            {editingShortcut && confirmingDelete && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleDelete()}
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
              儲存捷徑
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
