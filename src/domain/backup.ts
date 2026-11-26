import type {
  Account,
  BaseRecord,
  Category,
  Place,
  Transaction,
  TransactionKind,
} from '../db/types';
import { compareTransactionsByDateTimeDesc } from './places';

const KIND_LABELS: Record<TransactionKind, string> = {
  expense: '支出',
  income: '收入',
  transfer: '轉帳',
};

const CSV_HEADER = [
  '日期',
  '時間',
  '類型',
  '金額',
  '分類',
  '子分類',
  '帳戶',
  '轉入帳戶',
  '地點',
  '備註',
  '標籤',
  '發票號碼',
];

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * 將未刪除的交易紀錄轉換為含 UTF-8 BOM 的 CSV 字串，依日期與時間由新到舊排序。
 */
export function toCsv(
  transactions: readonly Transaction[],
  categories: readonly Category[],
  accounts: readonly Account[],
  places: readonly Place[] = [],
): string {
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const placeMap = new Map(places.map((p) => [p.id, p]));

  const sorted = transactions
    .filter((tx) => !tx.deleted)
    .sort(compareTransactionsByDateTimeDesc);

  const lines: string[] = [CSV_HEADER.map(escapeCsvCell).join(',')];

  for (const tx of sorted) {
    const category = tx.categoryId ? categoryMap.get(tx.categoryId) : undefined;
    const parentCategory = category?.parentId ? categoryMap.get(category.parentId) : undefined;

    const categoryName =
      tx.kind === 'transfer' ? '' : (parentCategory ? parentCategory.name : (category?.name ?? ''));
    const subCategoryName =
      tx.kind === 'transfer' ? '' : (parentCategory ? (category?.name ?? '') : '');

    const accountName = accountMap.get(tx.accountId)?.name ?? '';
    const toAccountName =
      tx.kind === 'transfer' && tx.toAccountId ? (accountMap.get(tx.toAccountId)?.name ?? '') : '';
    const placeName = tx.placeId ? (placeMap.get(tx.placeId)?.name ?? '') : '';

    const row = [
      tx.date,
      tx.time ?? '',
      KIND_LABELS[tx.kind],
      String(tx.amount),
      categoryName,
      subCategoryName,
      accountName,
      toAccountName,
      placeName,
      tx.note ?? '',
      (tx.tags ?? []).join('、'),
      tx.invoiceNo ?? '',
    ];

    lines.push(row.map(escapeCsvCell).join(','));
  }

  return `\uFEFF${lines.join('\n')}`;
}

/**
 * 依 id 合併現有與匯入紀錄，同 id 取 updatedAt 較新者，並保留雙方獨有紀錄。
 */
export function mergeBackup<T extends BaseRecord>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const merged = new Map<string, T>();

  for (const item of existing) {
    const prev = merged.get(item.id);
    if (!prev || item.updatedAt > prev.updatedAt) {
      merged.set(item.id, item);
    }
  }

  for (const item of incoming) {
    const prev = merged.get(item.id);
    if (!prev || item.updatedAt > prev.updatedAt) {
      merged.set(item.id, item);
    }
  }

  return Array.from(merged.values());
}
