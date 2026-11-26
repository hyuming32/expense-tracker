import { db, META_KEYS } from './database';
import { getDeviceId } from './deviceId';
import type { Transaction, TransactionKind } from './types';
import { uuidv7 } from './uuid';

export interface SaveTransactionInput {
  id?: string;
  kind: TransactionKind;
  date: string;
  amount: number;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  note: string | null;
}

/**
 * 儲存或更新一筆交易紀錄，並同步更新最後使用的帳戶與分類設定。
 */
export async function saveTransaction(input: SaveTransactionInput): Promise<Transaction> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const record: Transaction = {
    id: input.id ?? uuidv7(),
    kind: input.kind,
    date: input.date,
    amount: input.amount,
    accountId: input.accountId,
    toAccountId: input.kind === 'transfer' ? input.toAccountId : null,
    categoryId: input.kind === 'transfer' ? null : input.categoryId,
    note: input.note?.trim() ? input.note.trim() : null,
    updatedAt: now,
    deviceId,
    deleted: false,
  };

  await db.transaction('rw', db.transactions, db.meta, async () => {
    await db.transactions.put(record);
    await db.meta.put({ key: META_KEYS.LAST_ACCOUNT_ID, value: record.accountId });
    if (record.kind === 'expense' && record.categoryId) {
      await db.meta.put({ key: META_KEYS.LAST_EXPENSE_CATEGORY_ID, value: record.categoryId });
    } else if (record.kind === 'income' && record.categoryId) {
      await db.meta.put({ key: META_KEYS.LAST_INCOME_CATEGORY_ID, value: record.categoryId });
    }
  });

  return record;
}

/**
 * 軟刪除交易紀錄（設定 deleted = true）。
 */
export async function softDeleteTransaction(id: string): Promise<void> {
  const existing = await db.transactions.get(id);
  if (!existing) {
    return;
  }
  await db.transactions.put({
    ...existing,
    deleted: true,
    updatedAt: Date.now(),
    deviceId: getDeviceId(),
  });
}
