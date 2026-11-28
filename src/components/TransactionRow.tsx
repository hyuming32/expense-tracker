import { useMoney, usePrivacy } from '../contexts/PrivacyContext';
import type { AmountColors } from '../db/repository';
import type { Account, Category, Member, Place, Transaction } from '../db/types';
import { formatMoney as formatForeignMoney, getHiddenAmountText } from '../domain';

interface TransactionRowProps {
  transaction: Transaction;
  categoryMap: ReadonlyMap<string, Category>;
  accountMap: ReadonlyMap<string, Account>;
  placeMap?: ReadonlyMap<string, Place>;
  memberMap?: ReadonlyMap<string, Member>;
  isFamilyMode?: boolean;
  amountColors: AmountColors;
  onSelect: (tx: Transaction) => void;
  showDate?: boolean;
}

export function TransactionRow({
  transaction,
  categoryMap,
  accountMap,
  placeMap,
  memberMap,
  isFamilyMode = false,
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
  const isInstallment = Boolean(
    transaction.installmentId && transaction.installmentIndex && transaction.installmentCount,
  );
  const member =
    isFamilyMode && transaction.memberId ? memberMap?.get(transaction.memberId) : undefined;
  const memberShortName = member
    ? Array.from(member.name.trim()).slice(0, 2).join('')
    : isFamilyMode && transaction.memberId
      ? '家人'
      : null;

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
          {(subtitleParts.length > 0 || tags.length > 0 || isInstallment) && (
            <div className="flex items-center gap-1.5 truncate text-xs text-slate-500 dark:text-slate-400">
              {subtitleParts.length > 0 && (
                <span className="truncate">{subtitleParts.join(' · ')}</span>
              )}
              {isInstallment && (
                <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                  分期 {transaction.installmentIndex}/{transaction.installmentCount}
                </span>
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
        {memberShortName && (
          <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-slate-500 dark:text-slate-400">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: member?.color ?? '#94a3b8' }}
              aria-hidden="true"
            />
            <span>{memberShortName}</span>
          </div>
        )}
      </div>
    </button>
  );
}
