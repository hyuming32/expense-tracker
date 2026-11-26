import { useEffect, useMemo, useState } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { TransactionSheet } from './components/TransactionSheet';
import { ensureSeeded } from './db/database';
import type { Transaction } from './db/types';
import {
  useActiveAccounts,
  useAllCategories,
  useLastUsedMeta,
  useTransactions,
} from './hooks/useExpenseData';
import { ComingSoonPage } from './pages/ComingSoonPage';
import { HomePage } from './pages/HomePage';
import { TransactionsPage } from './pages/TransactionsPage';

export function App() {
  const [ready, setReady] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  const accounts = useActiveAccounts();
  const categories = useAllCategories();
  const transactions = useTransactions();
  const lastUsed = useLastUsedMeta();

  useEffect(() => {
    void ensureSeeded().then(() => setReady(true));
  }, []);

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  function handleOpenCreate() {
    setEditingTx(null);
    setSheetOpen(true);
  }

  function handleEditTransaction(tx: Transaction) {
    setEditingTx(tx);
    setSheetOpen(true);
  }

  function handleCloseSheet() {
    setSheetOpen(false);
    setEditingTx(null);
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
                  accountMap={accountMap}
                  categoryMap={categoryMap}
                  onOpenCreate={handleOpenCreate}
                  onEditTransaction={handleEditTransaction}
                />
              }
            />
            <Route
              path="/transactions"
              element={
                <TransactionsPage
                  transactions={transactions}
                  accounts={accounts}
                  categories={categories}
                  accountMap={accountMap}
                  categoryMap={categoryMap}
                  onEditTransaction={handleEditTransaction}
                />
              }
            />
            <Route path="/reports" element={<ComingSoonPage title="報表" />} />
            <Route path="/accounts" element={<ComingSoonPage title="帳戶" />} />
            <Route path="/settings" element={<ComingSoonPage title="設定" />} />
          </Routes>
        </main>

        <BottomNav />

        <TransactionSheet
          open={sheetOpen}
          editingTransaction={editingTx}
          accounts={accounts}
          categories={categories}
          lastUsed={lastUsed}
          onClose={handleCloseSheet}
        />
      </div>
    </HashRouter>
  );
}

export default App;
