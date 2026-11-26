import type { Account, Category, Transaction } from '../db/types';
import { formatCurrency } from '../domain';

interface TransactionRowProps {
  transaction: Transaction;
  categoryMap: ReadonlyMap<string, Category>;
  accountMap: ReadonlyMap<string, Account>;
  onSelect: (tx: Transaction) => void;
  showDate?: boolean;
}

const AMOUNT_COLOR_CLASS: Record<Transaction['kind'], string> = {
  expense: 'text-red-600 dark:text-red-400',
  income: 'text-emerald-600 dark:text-emerald-400',
  transfer: 'text-slate-500 dark:text-slate-400',
};

export function TransactionRow({
  transaction,
  categoryMap,
  accountMap,
  onSelect,
  showDate = false,
}: TransactionRowProps) {
  const category = transaction.categoryId ? categoryMap.get(transaction.categoryId) : undefined;
  const parentCategory = category?.parentId ? categoryMap.get(category.parentId) : undefined;
  const account = accountMap.get(transaction.accountId);
  const toAccount = transaction.toAccountId ? accountMap.get(transaction.toAccountId) : undefined;

  const icon = transaction.kind === 'transfer' ? '🔄' : (category?.icon ?? '📝');
  const title =
    transaction.kind === 'transfer'
      ? `${account?.name ?? '未知帳戶'} → ${toAccount?.name ?? '未知帳戶'}`
      : parentCategory
        ? `${parentCategory.name} · ${category?.name ?? ''}`
        : (category?.name ?? '未分類');

  const subtitleParts: string[] = [];
  if (showDate) {
    subtitleParts.push(transaction.date);
  }
  if (transaction.kind !== 'transfer' && account) {
    subtitleParts.push(account.name);
  }
  if (transaction.note) {
    subtitleParts.push(transaction.note);
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(transaction)}
      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-100/80 active:bg-slate-100 dark:hover:bg-slate-800/60 dark:active:bg-slate-800"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xl dark:bg-slate-800"
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{title}</div>
          {subtitleParts.length > 0 && (
            <div className="truncate text-xs text-slate-500 dark:text-slate-400">
              {subtitleParts.join(' · ')}
            </div>
          )}
        </div>
      </div>

      <span className={`shrink-0 text-sm font-semibold tabular-nums ${AMOUNT_COLOR_CLASS[transaction.kind]}`}>
        {formatCurrency(transaction.amount)}
      </span>
    </button>
  );
}
