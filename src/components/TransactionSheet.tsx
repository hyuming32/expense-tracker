import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type AmountColors,
  DuplicateInvoiceError,
  DuplicateNotePresetError,
  findActiveTransactionByInvoiceNo,
  saveNotePreset,
  saveTransaction,
  softDeleteNotePreset,
  softDeleteTransaction,
} from '../db/repository';
import type { Account, Category, NotePreset, Transaction, TransactionKind } from '../db/types';
import {
  formatInvoiceNote,
  getTodayDateString,
  selectQuickNotePresets,
  validateTransaction,
  type ParsedInvoice,
} from '../domain';
import type { LastUsedMeta } from '../hooks/useExpenseData';
import { InvoiceScannerModal } from './InvoiceScannerModal';

interface TransactionSheetProps {
  open: boolean;
  editingTransaction: Transaction | null;
  accounts: readonly Account[];
  categories: readonly Category[];
  lastUsed: LastUsedMeta;
  amountColors: AmountColors;
  notePresets: readonly NotePreset[];
  onClose: () => void;
}

const KIND_TABS: Array<{ value: TransactionKind; label: string }> = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '轉帳' },
];

export function TransactionSheet({
  open,
  editingTransaction,
  accounts,
  categories,
  lastUsed,
  amountColors,
  notePresets,
  onClose,
}: TransactionSheetProps) {
  const amountInputRef = useRef<HTMLInputElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);

  const [kind, setKind] = useState<TransactionKind>('expense');
  const [amountText, setAmountText] = useState('');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [expandedParentId, setExpandedParentId] = useState<string | null>(null);
  const [date, setDate] = useState(getTodayDateString);
  const [note, setNote] = useState('');
  const [invoiceNo, setInvoiceNo] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingPreset, setDeletingPreset] = useState<NotePreset | null>(null);
  const [presetMessage, setPresetMessage] = useState<string | null>(null);

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

  const quickPresets = useMemo(
    () =>
      selectQuickNotePresets({
        presets: notePresets,
        categories,
        categoryId: kind === 'transfer' ? null : categoryId,
        query: note,
      }),
    [notePresets, categories, kind, categoryId, note],
  );

  // 開啟面板或切換編輯對象時初始化表單
  useEffect(() => {
    if (!open) {
      return;
    }

    setErrors([]);
    setDuplicateMessage(null);
    setScannerOpen(false);
    setConfirmingDelete(false);
    setSubmitting(false);
    setDeletingPreset(null);
    setPresetMessage(null);

    if (editingTransaction) {
      setKind(editingTransaction.kind);
      setAmountText(String(editingTransaction.amount));
      setAccountId(editingTransaction.accountId);
      setToAccountId(editingTransaction.toAccountId ?? '');
      setCategoryId(editingTransaction.categoryId);
      setDate(editingTransaction.date);
      setNote(editingTransaction.note ?? '');
      setInvoiceNo(editingTransaction.invoiceNo ?? null);

      if (editingTransaction.categoryId) {
        const currentCat = categories.find((c) => c.id === editingTransaction.categoryId);
        setExpandedParentId(currentCat?.parentId ?? currentCat?.id ?? null);
      } else {
        setExpandedParentId(null);
      }
    } else {
      const defaultAcc =
        (lastUsed.lastAccountId && accounts.some((a) => a.id === lastUsed.lastAccountId)
          ? lastUsed.lastAccountId
          : accounts[0]?.id) ?? '';
      const otherAcc = accounts.find((a) => a.id !== defaultAcc)?.id ?? '';

      setKind('expense');
      setAmountText('');
      setAccountId(defaultAcc);
      setToAccountId(otherAcc);
      setDate(getTodayDateString());
      setNote('');
      setInvoiceNo(null);

      const defaultExpCat =
        lastUsed.lastExpenseCategoryId && categories.some((c) => c.id === lastUsed.lastExpenseCategoryId && !c.archived)
          ? lastUsed.lastExpenseCategoryId
          : null;
      setCategoryId(defaultExpCat);
      if (defaultExpCat) {
        const cat = categories.find((c) => c.id === defaultExpCat);
        setExpandedParentId(cat?.parentId ?? null);
      } else {
        setExpandedParentId(null);
      }
    }

    const timer = window.setTimeout(() => {
      amountInputRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [open, editingTransaction, accounts, categories, lastUsed]);

  if (!open) {
    return null;
  }

  function handleKindChange(nextKind: TransactionKind) {
    setKind(nextKind);
    setErrors([]);
    setDuplicateMessage(null);
    setExpandedParentId(null);

    if (nextKind !== 'expense') {
      setInvoiceNo(null);
    }

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
      // 展開子分類時同步選取父分類作為預設，點選子分類後會覆寫
      setCategoryId(parent.id);
    } else {
      setExpandedParentId(null);
      setCategoryId(parent.id);
    }
  }

  function handleInvoiceDetected(parsed: ParsedInvoice) {
    setScannerOpen(false);
    setErrors([]);
    setDuplicateMessage(null);
    setAmountText(String(parsed.amount));
    setDate(parsed.date);
    setInvoiceNo(parsed.invoiceNo);
    setNote(formatInvoiceNote(parsed));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) {
      return;
    }

    setDuplicateMessage(null);
    const parsedAmount = Number(amountText.trim());
    const payload = {
      kind,
      date,
      amount: parsedAmount,
      accountId,
      toAccountId: kind === 'transfer' ? toAccountId || null : null,
      categoryId: kind === 'transfer' ? null : categoryId,
    };

    const validationErrors = validateTransaction(payload);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    setSubmitting(true);
    try {
      const effectiveInvoiceNo = kind === 'expense' ? invoiceNo : null;
      if (effectiveInvoiceNo) {
        const duplicate = await findActiveTransactionByInvoiceNo(
          effectiveInvoiceNo,
          editingTransaction?.id,
        );
        if (duplicate) {
          setDuplicateMessage(`這張發票已經記過了（${duplicate.date} ${duplicate.amount}）`);
          return;
        }
      }

      await saveTransaction({
        id: editingTransaction?.id,
        ...payload,
        note: note || null,
        invoiceNo: effectiveInvoiceNo,
      });
      onClose();
    } catch (err) {
      if (err instanceof DuplicateInvoiceError) {
        setDuplicateMessage(err.message);
      } else {
        setErrors(['儲存失敗，請稍後再試']);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!editingTransaction || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await softDeleteTransaction(editingTransaction.id);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddQuickPreset() {
    if (!note.trim()) {
      return;
    }
    setPresetMessage(null);
    try {
      await saveNotePreset({
        text: note,
        categoryId: kind === 'transfer' ? null : categoryId,
      });
      setPresetMessage('已加入常用備註');
    } catch (err) {
      if (err instanceof DuplicateNotePresetError) {
        setPresetMessage('此常用備註已存在');
      } else {
        setPresetMessage(err instanceof Error ? err.message : '加入常用備註失敗');
      }
    }
  }

  async function handleConfirmDeletePreset() {
    if (!deletingPreset) {
      return;
    }
    await softDeleteNotePreset(deletingPreset.id);
    setDeletingPreset(null);
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  const expandedChildren = expandedParentId ? (childrenByParent.get(expandedParentId) ?? []) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-[1px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={editingTransaction ? '編輯紀錄' : '記一筆'}
    >
      <div
        className="max-h-[92vh] w-full max-w-[720px] overflow-y-auto rounded-t-2xl bg-white p-4 pb-6 shadow-2xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {editingTransaction ? '編輯紀錄' : '記一筆'}
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
            <label htmlFor="tx-amount" className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              金額（NT$）
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={amountInputRef}
                id="tx-amount"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="0"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value.replace(/[^\d]/g, ''))}
                style={
                  kind === 'expense'
                    ? { color: amountColors.expense }
                    : kind === 'income'
                      ? { color: amountColors.income }
                      : undefined
                }
                className={`w-full flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-2xl font-bold tabular-nums outline-none placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:placeholder:text-slate-500 dark:focus:border-emerald-400 dark:focus:bg-slate-800 ${
                  kind === 'transfer' ? 'text-slate-900 dark:text-slate-100' : ''
                }`}
              />
              {kind === 'expense' && (
                <button
                  type="button"
                  onClick={() => setScannerOpen(true)}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  aria-label="掃描發票"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    className="h-4 w-4"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3.75 7.5A2.25 2.25 0 0 1 6 5.25h2.25l1.5-1.5h4.5l1.5 1.5H18a2.25 2.25 0 0 1 2.25 2.25v9A2.25 2.25 0 0 1 18 18.75H6a2.25 2.25 0 0 1-2.25-2.25v-9Z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                    />
                  </svg>
                  <span>掃描發票</span>
                </button>
              )}
            </div>
            {kind === 'expense' && invoiceNo && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                <span>發票 {invoiceNo}</span>
                <button
                  type="button"
                  onClick={() => {
                    setInvoiceNo(null);
                    setDuplicateMessage(null);
                  }}
                  aria-label="移除發票號碼"
                  className="rounded-full px-1 text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-900"
                >
                  ×
                </button>
              </div>
            )}
          </div>

          {/* 分類選擇（僅支出與收入顯示） */}
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
                      <span className="truncate max-w-full">
                        {cat.name}
                        {children.length > 0 ? (isExpanded ? ' ▾' : ' ▸') : ''}
                      </span>
                    </button>
                  );
                })}
              </div>

              {expandedChildren.length > 0 && (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/60">
                  <div className="mb-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">子分類</div>
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

          {/* 帳戶與日期 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="tx-account" className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                {kind === 'transfer' ? '轉出帳戶' : '帳戶'}
              </label>
              <select
                id="tx-account"
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

            {kind === 'transfer' ? (
              <div>
                <label
                  htmlFor="tx-to-account"
                  className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
                >
                  轉入帳戶
                </label>
                <select
                  id="tx-to-account"
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
            ) : (
              <div>
                <label htmlFor="tx-date" className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                  日期
                </label>
                <input
                  id="tx-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
            )}
          </div>

          {kind === 'transfer' && (
            <div>
              <label htmlFor="tx-transfer-date" className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                日期
              </label>
              <input
                id="tx-transfer-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
          )}

          {/* 備註與常用備註快選 */}
          <div>
            <label htmlFor="tx-note" className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              備註（選填）
            </label>
            <input
              id="tx-note"
              type="text"
              placeholder="輸入備註..."
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setPresetMessage(null);
              }}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />

            <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="常用備註快選">
              {quickPresets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    if (longPressTriggeredRef.current) {
                      longPressTriggeredRef.current = false;
                      return;
                    }
                    setNote(preset.text);
                    setDeletingPreset(null);
                    setPresetMessage(null);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setDeletingPreset(preset);
                  }}
                  onTouchStart={() => {
                    longPressTriggeredRef.current = false;
                    clearLongPressTimer();
                    longPressTimerRef.current = window.setTimeout(() => {
                      longPressTriggeredRef.current = true;
                      setDeletingPreset(preset);
                    }, 500);
                  }}
                  onTouchEnd={clearLongPressTimer}
                  onTouchMove={clearLongPressTimer}
                  onTouchCancel={clearLongPressTimer}
                  title="點擊填入，長按或右鍵可刪除"
                  className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 transition-colors hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-emerald-500 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-300"
                >
                  {preset.text}
                </button>
              ))}
              <button
                type="button"
                disabled={!note.trim()}
                onClick={() => void handleAddQuickPreset()}
                aria-label="將目前備註加入常用備註"
                title="將目前備註存為常用備註"
                className="rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-emerald-500 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:text-slate-300 dark:hover:border-emerald-400 dark:hover:text-emerald-300"
              >
                ＋
              </button>
            </div>

            {presetMessage && (
              <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                {presetMessage}
              </div>
            )}

            {deletingPreset && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
                <span>刪除這個常用備註「{deletingPreset.text}」？</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleConfirmDeletePreset()}
                    className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
                  >
                    刪除
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeletingPreset(null)}
                    className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-red-800 dark:bg-slate-900 dark:text-slate-200"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 重複發票提示（僅提供取消，不允許重複儲存） */}
          {duplicateMessage && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
              <span>{duplicateMessage}</span>
              <button
                type="button"
                onClick={() => setDuplicateMessage(null)}
                className="shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-100"
              >
                取消
              </button>
            </div>
          )}

          {/* 驗證錯誤提示 */}
          {errors.length > 0 && (
            <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/50 dark:text-red-300">
              {errors.map((err) => (
                <div key={err}>• {err}</div>
              ))}
            </div>
          )}

          {/* 操作按鈕 */}
          <div className="flex items-center gap-2 pt-1">
            {editingTransaction && !confirmingDelete && (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                刪除
              </button>
            )}

            {editingTransaction && confirmingDelete && (
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
              儲存
            </button>
          </div>
        </form>
      </div>

      <InvoiceScannerModal
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleInvoiceDetected}
      />
    </div>
  );
}
