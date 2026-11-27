import { useMoney, usePrivacy } from '../contexts/PrivacyContext';
import type { AmountColors } from '../db/repository';
import type { Account, Category, Place, Transaction } from '../db/types';
import { formatMoney as formatForeignMoney, getHiddenAmountText } from '../domain';

interface TransactionRowProps {
  transaction: Transaction;
  categoryMap: ReadonlyMap<string, Category>;
  accountMap: ReadonlyMap<string, Account>;
  placeMap?: ReadonlyMap<string, Place>;
  amountColors: AmountColors;
  onSelect: (tx: Transaction) => void;
  showDate?: boolean;
}

export function TransactionRow({
  transaction,
  categoryMap,
  accountMap,
  placeMap,
  amountColors,
  onSelect,
  showDate = false,
}: TransactionRowProps) {
  const formatMoney = useMoney();
  const { hideAmounts } = usePrivacy();
  const category = transaction.categoryId ? categoryMap.get(transaction.categoryId) : undefined;
  const parentCategory = category?.parentId ? categoryMap.get(category.parentId) : undefined;
  const account = accountMap.get(transaction.accountId);
  const toAccount = transaction.toAccountId ? accountMap.get(transaction.toAccountId) : undefined;
  const place = transaction.placeId ? placeMap?.get(transaction.placeId) : undefined;

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
  if (transaction.time) {
    subtitleParts.push(transaction.time);
  }
  if (place) {
    subtitleParts.push(place.name);
  }
  if (transaction.kind !== 'transfer' && account) {
    subtitleParts.push(account.name);
  }
  if (transaction.note) {
    subtitleParts.push(transaction.note);
  }
  const tags = transaction.tags ?? [];

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
          <div className="flex items-center gap-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            <span className="truncate">{title}</span>
            {transaction.recurringId && (
              <span className="shrink-0 text-xs" title="週期性收支" aria-label="週期性收支">
                🔁
              </span>
            )}
          </div>
          {(subtitleParts.length > 0 || tags.length > 0) && (
            <div className="flex items-center gap-1.5 truncate text-xs text-slate-500 dark:text-slate-400">
              {subtitleParts.length > 0 && (
                <span className="truncate">{subtitleParts.join(' · ')}</span>
              )}
              {tags.length > 0 && (
                <span className="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400">
                  {tags.map((t) => `#${t}`).join(' ')}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div
          className={`text-sm font-semibold tabular-nums ${
            transaction.kind === 'transfer' ? 'text-slate-500 dark:text-slate-400' : ''
          }`}
          style={
            transaction.kind === 'expense'
              ? { color: amountColors.expense }
              : transaction.kind === 'income'
                ? { color: amountColors.income }
                : undefined
          }
        >
          {formatMoney(transaction.amount)}
        </div>
        {transaction.currency && transaction.originalAmount != null && (
          <div className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
            {hideAmounts
              ? getHiddenAmountText(transaction.currency)
              : formatForeignMoney(transaction.originalAmount, transaction.currency)}
          </div>
        )}
      </div>
    </button>
  );
}
