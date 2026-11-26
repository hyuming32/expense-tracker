import { useMemo, useState } from 'react';
import type { AmountColors } from '../db/repository';
import type { Account, AccountType, Category, Transaction } from '../db/types';
import { accountBalance, formatCurrency } from '../domain';
import { TransactionsPage } from './TransactionsPage';

interface AccountsPageProps {
  accounts: readonly Account[];
  allAccounts: readonly Account[];
  categories: readonly Category[];
  transactions: readonly Transaction[];
  accountMap: ReadonlyMap<string, Account>;
  categoryMap: ReadonlyMap<string, Category>;
  amountColors: AmountColors;
  onEditTransaction: (tx: Transaction) => void;
}

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: '現金',
  bank: '銀行帳戶',
  credit: '信用卡',
};

export function AccountsPage({
  accounts,
  allAccounts,
  categories,
  transactions,
  accountMap,
  categoryMap,
  amountColors,
  onEditTransaction,
}: AccountsPageProps) {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  const accountBalances = useMemo(
    () =>
      accounts.map((acc) => ({
        account: acc,
        balance: accountBalance(acc, transactions),
      })),
    [accounts, transactions],
  );

  const totalAssets = useMemo(
    () => accountBalances.reduce((sum, item) => sum + item.balance, 0),
    [accountBalances],
  );

  if (selectedAccountId) {
    return (
      <TransactionsPage
        transactions={transactions}
        accounts={allAccounts}
        categories={categories}
        accountMap={accountMap}
        categoryMap={categoryMap}
        amountColors={amountColors}
        onEditTransaction={onEditTransaction}
        initialAccountId={selectedAccountId}
        onBack={() => setSelectedAccountId(null)}
      />
    );
  }

  return (
    <div className="space-y-4 pb-24">
      {/* 總資產卡片 */}
      <section className="rounded-2xl bg-slate-900 p-5 text-white shadow-sm dark:bg-slate-800">
        <div className="text-xs text-slate-300">總資產</div>
        <div className="mt-1 text-2xl font-bold tabular-nums">{formatCurrency(totalAssets)}</div>
      </section>

      {/* 帳戶列表 */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h1 className="text-sm font-semibold text-slate-900 dark:text-slate-100">帳戶餘額</h1>
        </div>

        {accountBalances.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            目前沒有啟用中的帳戶，請至設定新增或啟用帳戶
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {accountBalances.map(({ account, balance }) => {
              const isCreditDue = account.type === 'credit' && balance < 0;
              return (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => setSelectedAccountId(account.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 active:bg-slate-100 dark:hover:bg-slate-800/60"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {account.name}
                      </span>
                      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {ACCOUNT_TYPE_LABELS[account.type]}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {isCreditDue && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                        待繳
                      </span>
                    )}
                    <span
                      className={`text-sm font-semibold tabular-nums ${
                        balance < 0 ? '' : 'text-slate-900 dark:text-slate-100'
                      }`}
                      style={balance < 0 ? { color: amountColors.expense } : undefined}
                    >
                      {formatCurrency(balance)}
                    </span>
                    <span className="text-xs text-slate-400" aria-hidden="true">
                      ›
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
