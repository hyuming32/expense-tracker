import { useEffect, useMemo, useRef, useState } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { type RecurringRuleDraft, RecurringRuleSheet } from './components/RecurringRuleSheet';
import { type ShortcutDraft, ShortcutSheet } from './components/ShortcutSheet';
import { type TransactionDraft, TransactionSheet } from './components/TransactionSheet';
import { ensureSeeded } from './db/database';
import {
  processRecurringRules,
  recordShortcutTransaction,
  softDeleteTransaction,
} from './db/repository';
import type { RecurringRule, Shortcut, Transaction } from './db/types';
import { formatCurrency, getTodayDateString } from './domain';
import {
  useActiveAccounts,
  useAllAccounts,
  useAllCategories,
  useAmountColors,
  useAutoAddNotePresets,
  useAutoSelectLastPlace,
  useLastUsedMeta,
  useLotteryDraws,
  useNotePresets,
  usePendingRecurringOccurrences,
  usePlaces,
  useRecurringRules,
  useShortcuts,
  useTransactions,
} from './hooks/useExpenseData';
import { AccountsPage } from './pages/AccountsPage';
import { HomePage } from './pages/HomePage';
import { LotteryPage } from './pages/LotteryPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { startSyncManager, useSyncState } from './sync/syncManager';

export function App() {
  const [ready, setReady] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [txDraft, setTxDraft] = useState<TransactionDraft | null>(null);
  const [recurringSheetOpen, setRecurringSheetOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<RecurringRule | null>(null);
  const [recurringDraft, setRecurringDraft] = useState<RecurringRuleDraft | null>(null);
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);
  const [editingShortcut, setEditingShortcut] = useState<Shortcut | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutDraft | null>(null);
  const [lastSavedTx, setLastSavedTx] = useState<Transaction | null>(null);
  const [quickToast, setQuickToast] = useState<{ tx: Transaction; label: string } | null>(null);
  const lastActiveDateRef = useRef<string>(getTodayDateString());

  const activeAccounts = useActiveAccounts();
  const allAccounts = useAllAccounts();
  const categories = useAllCategories();
  const transactions = useTransactions();
  const lastUsed = useLastUsedMeta();
  const amountColors = useAmountColors();
  const notePresets = useNotePresets();
  const autoAddNotePresets = useAutoAddNotePresets();
  const recurringRules = useRecurringRules();
  const pendingRecurring = usePendingRecurringOccurrences();
  const shortcuts = useShortcuts();
  const places = usePlaces();
  const lotteryDraws = useLotteryDraws();
  const autoSelectLastPlace = useAutoSelectLastPlace();
  const syncState = useSyncState();

  useEffect(() => {
    void ensureSeeded().then(async () => {
      await processRecurringRules();
      lastActiveDateRef.current = getTodayDateString();
      setReady(true);
      startSyncManager();
    });
  }, []);

  useEffect(() => {
    function handleResume() {
      if (document.visibilityState && document.visibilityState !== 'visible') {
        return;
      }
      const today = getTodayDateString();
      if (today !== lastActiveDateRef.current) {
        lastActiveDateRef.current = today;
        void processRecurringRules(today);
      }
    }

    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('focus', handleResume);
    return () => {
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('focus', handleResume);
    };
  }, []);

  useEffect(() => {
    if (!lastSavedTx) {
      return;
    }
    const timer = window.setTimeout(() => {
      setLastSavedTx(null);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [lastSavedTx]);

  useEffect(() => {
    if (!quickToast) {
      return;
    }
    const timer = window.setTimeout(() => {
      setQuickToast(null);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [quickToast]);

  const accountMap = useMemo(() => new Map(allAccounts.map((a) => [a.id, a])), [allAccounts]);
  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const placeMap = useMemo(() => new Map(places.map((p) => [p.id, p])), [places]);

  function handleOpenCreate(draft?: TransactionDraft) {
    setEditingTx(null);
    setTxDraft(draft ?? null);
    setSheetOpen(true);
  }

  function handleEditTransaction(tx: Transaction) {
    setEditingTx(tx);
    setTxDraft(null);
    setSheetOpen(true);
  }

  function handleCloseSheet() {
    setSheetOpen(false);
    setEditingTx(null);
    setTxDraft(null);
  }

  function handleTransactionSaved(saved: Transaction) {
    if (!editingTx) {
      setLastSavedTx(saved);
      setQuickToast(null);
    }
  }

  async function handleQuickRecordShortcut(shortcut: Shortcut) {
    const saved = await recordShortcutTransaction(shortcut);
    setLastSavedTx(null);
    setQuickToast({ tx: saved, label: shortcut.label });
  }

  async function handleUndoQuickRecord(tx: Transaction) {
    await softDeleteTransaction(tx.id);
    setQuickToast(null);
  }

  function handleOpenCreateShortcut() {
    setEditingShortcut(null);
    setShortcutDraft(null);
    setShortcutSheetOpen(true);
  }

  function handleEditShortcut(shortcut: Shortcut) {
    setEditingShortcut(shortcut);
    setShortcutDraft(null);
    setShortcutSheetOpen(true);
  }

  function handleSaveAsShortcutFromTx(tx: Transaction) {
    const category = tx.categoryId ? categoryMap.get(tx.categoryId) : undefined;
    const defaultLabel =
      tx.note?.trim() ||
      category?.name ||
      (tx.kind === 'transfer' ? '轉帳' : '捷徑');

    setEditingShortcut(null);
    setShortcutDraft({
      label: defaultLabel.slice(0, 20),
      icon: category?.icon ?? (tx.kind === 'transfer' ? '🔄' : '⚡'),
      kind: tx.kind,
      amount: tx.amount,
      accountId: tx.accountId,
      toAccountId: tx.toAccountId,
      categoryId: tx.categoryId,
      note: tx.note,
    });
    setLastSavedTx(null);
    setShortcutSheetOpen(true);
  }

  function handleCloseShortcutSheet() {
    setShortcutSheetOpen(false);
    setEditingShortcut(null);
    setShortcutDraft(null);
  }

  function handleOpenCreateRecurring() {
    setEditingRule(null);
    setRecurringDraft(null);
    setRecurringSheetOpen(true);
  }

  function handleEditRecurring(rule: RecurringRule) {
    setEditingRule(rule);
    setRecurringDraft(null);
    setRecurringSheetOpen(true);
  }

  function handleMakeMonthlyFromTx(tx: Transaction) {
    const [, monthStr, dayStr] = tx.date.split('-');
    const parsedDate = new Date(
      Number(tx.date.slice(0, 4)),
      Number(monthStr) - 1,
      Number(dayStr),
    );
    setEditingRule(null);
    setRecurringDraft({
      kind: tx.kind,
      amount: tx.amount,
      accountId: tx.accountId,
      toAccountId: tx.toAccountId,
      categoryId: tx.categoryId,
      note: tx.note,
      frequency: 'monthly',
      dayOfMonth: Number(dayStr) || 1,
      weekday: Number.isNaN(parsedDate.getTime()) ? 1 : parsedDate.getDay(),
      monthOfYear: Number(monthStr) || 1,
      startDate: tx.date,
      endDate: null,
      autoPost: true,
    });
    setLastSavedTx(null);
    setRecurringSheetOpen(true);
  }

  function handleCloseRecurringSheet() {
    setRecurringSheetOpen(false);
    setEditingRule(null);
    setRecurringDraft(null);
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        載入中...
      </div>
    );
  }

  return (
    <HashRouter>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
        <main className="mx-auto max-w-[720px] px-4 pt-4">
          <Routes>
            <Route
              path="/"
              element={
                <HomePage
                  transactions={transactions}
                  shortcuts={shortcuts}
                  lotteryDraws={lotteryDraws}
                  accountMap={accountMap}
                  categoryMap={categoryMap}
                  placeMap={placeMap}
                  amountColors={amountColors}
                  syncState={syncState}
                  pendingRecurring={pendingRecurring}
                  onOpenCreate={handleOpenCreate}
                  onEditTransaction={handleEditTransaction}
                  onQuickRecordShortcut={(s) => void handleQuickRecordShortcut(s)}
                  onEditShortcut={handleEditShortcut}
                />
              }
            />
            <Route
              path="/transactions"
              element={
                <TransactionsPage
                  transactions={transactions}
                  accounts={allAccounts}
                  categories={categories}
                  places={places}
                  accountMap={accountMap}
                  categoryMap={categoryMap}
                  placeMap={placeMap}
                  amountColors={amountColors}
                  onEditTransaction={handleEditTransaction}
                />
              }
            />
            <Route
              path="/reports"
              element={
                <ReportsPage
                  transactions={transactions}
                  categories={categories}
                  places={places}
                  amountColors={amountColors}
                />
              }
            />
            <Route
              path="/accounts"
              element={
                <AccountsPage
                  accounts={activeAccounts}
                  allAccounts={allAccounts}
                  categories={categories}
                  places={places}
                  transactions={transactions}
                  accountMap={accountMap}
                  categoryMap={categoryMap}
                  placeMap={placeMap}
                  amountColors={amountColors}
                  onEditTransaction={handleEditTransaction}
                />
              }
            />
            <Route
              path="/lottery"
              element={
                <LotteryPage
                  transactions={transactions}
                  places={places}
                  lotteryDraws={lotteryDraws}
                />
              }
            />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  accounts={allAccounts}
                  categories={categories}
                  places={places}
                  autoSelectLastPlace={autoSelectLastPlace}
                  transactions={transactions}
                  amountColors={amountColors}
                  notePresets={notePresets}
                  autoAddNotePresets={autoAddNotePresets}
                  recurringRules={recurringRules}
                  shortcuts={shortcuts}
                  onOpenCreateRecurring={handleOpenCreateRecurring}
                  onEditRecurring={handleEditRecurring}
                  onOpenCreateShortcut={handleOpenCreateShortcut}
                  onEditShortcut={handleEditShortcut}
                />
              }
            />
          </Routes>
        </main>

        {quickToast && (
          <div className="fixed bottom-20 left-1/2 z-30 flex w-[calc(100%-2rem)] max-w-[688px] -translate-x-1/2 items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-900 px-3.5 py-2.5 text-xs text-white shadow-lg dark:border-slate-700 dark:bg-slate-800">
            <span>
              已記一筆：{quickToast.label} {formatCurrency(quickToast.tx.amount)}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleUndoQuickRecord(quickToast.tx)}
                className="rounded-lg bg-amber-500 px-2.5 py-1 font-medium text-slate-950 hover:bg-amber-400"
              >
                復原
              </button>
              <button
                type="button"
                onClick={() => setQuickToast(null)}
                aria-label="關閉提示"
                className="rounded px-1.5 py-1 text-slate-300 hover:bg-slate-700"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {lastSavedTx && (
          <div className="fixed bottom-20 left-1/2 z-30 flex w-[calc(100%-2rem)] max-w-[688px] -translate-x-1/2 items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-900 px-3.5 py-2.5 text-xs text-white shadow-lg dark:border-slate-700 dark:bg-slate-800">
            <span>已儲存紀錄</span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleSaveAsShortcutFromTx(lastSavedTx)}
                className="rounded-lg bg-amber-500 px-2.5 py-1 font-medium text-slate-950 hover:bg-amber-400"
              >
                ⭐ 存成捷徑
              </button>
              <button
                type="button"
                onClick={() => handleMakeMonthlyFromTx(lastSavedTx)}
                className="rounded-lg bg-emerald-600 px-2.5 py-1 font-medium text-white hover:bg-emerald-500"
              >
                🔁 設為每月重複
              </button>
              <button
                type="button"
                onClick={() => setLastSavedTx(null)}
                aria-label="關閉提示"
                className="rounded px-1.5 py-1 text-slate-300 hover:bg-slate-700"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        <BottomNav />

        <TransactionSheet
          open={sheetOpen}
          editingTransaction={editingTx}
          initialDraft={txDraft}
          accounts={activeAccounts}
          categories={categories}
          places={places}
          autoSelectLastPlace={autoSelectLastPlace}
          lastUsed={lastUsed}
          amountColors={amountColors}
          notePresets={notePresets}
          onClose={handleCloseSheet}
          onSaved={handleTransactionSaved}
        />

        <ShortcutSheet
          open={shortcutSheetOpen}
          editingShortcut={editingShortcut}
          initialDraft={shortcutDraft}
          accounts={activeAccounts}
          categories={categories}
          lastUsed={lastUsed}
          amountColors={amountColors}
          onClose={handleCloseShortcutSheet}
        />

        <RecurringRuleSheet
          open={recurringSheetOpen}
          editingRule={editingRule}
          initialDraft={recurringDraft}
          accounts={activeAccounts}
          categories={categories}
          lastUsed={lastUsed}
          amountColors={amountColors}
          onClose={handleCloseRecurringSheet}
        />
      </div>
    </HashRouter>
  );
}

export default App;
