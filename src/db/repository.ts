import { mergeBackup } from '../domain/backup';
import { db, type ExpenseDatabase, META_KEYS } from './database';
import { getDeviceId } from './deviceId';
import type {
  Account,
  AccountType,
  Category,
  CategoryKind,
  MetaEntry,
  OutboxEntry,
  SyncTableName,
  Transaction,
  TransactionKind,
} from './types';
import { uuidv7 } from './uuid';

type LocalMutationListener = () => void;
const localMutationListeners = new Set<LocalMutationListener>();

/**
 * 訂閱本機資料寫入事件（供同步排程觸發防抖上傳）。
 */
export function subscribeLocalMutation(listener: LocalMutationListener): () => void {
  localMutationListeners.add(listener);
  return () => {
    localMutationListeners.delete(listener);
  };
}

function notifyLocalMutation(database: ExpenseDatabase): void {
  if (database !== db) {
    return;
  }
  for (const listener of localMutationListeners) {
    listener();
  }
}

function createOutboxEntry(
  table: SyncTableName,
  recordId: string,
  updatedAt: number,
): OutboxEntry {
  return {
    key: `${table}:${recordId}`,
    table,
    recordId,
    updatedAt,
  };
}

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

export interface SaveCategoryInput {
  id?: string;
  name: string;
  icon: string;
  kind: CategoryKind;
  parentId: string | null;
  sortOrder?: number;
  archived?: boolean;
}

export interface SaveAccountInput {
  id?: string;
  name: string;
  type: AccountType;
  initialBalance: number;
  sortOrder?: number;
  archived?: boolean;
}

export interface BackupPayload {
  schemaVersion: number;
  exportedAt: number;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  meta?: MetaEntry[];
}

export interface RestoreSummary {
  accounts: number;
  categories: number;
  transactions: number;
}

/**
 * 儲存或更新一筆交易紀錄，並同步更新最後使用的帳戶與分類設定。
 */
export async function saveTransaction(
  input: SaveTransactionInput,
  database: ExpenseDatabase = db,
): Promise<Transaction> {
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

  await database.transaction('rw', database.transactions, database.meta, database.outbox, async () => {
    await database.transactions.put(record);
    await database.outbox.put(createOutboxEntry('transactions', record.id, now));
    await database.meta.put({ key: META_KEYS.LAST_ACCOUNT_ID, value: record.accountId });
    if (record.kind === 'expense' && record.categoryId) {
      await database.meta.put({ key: META_KEYS.LAST_EXPENSE_CATEGORY_ID, value: record.categoryId });
    } else if (record.kind === 'income' && record.categoryId) {
      await database.meta.put({ key: META_KEYS.LAST_INCOME_CATEGORY_ID, value: record.categoryId });
    }
  });

  notifyLocalMutation(database);
  return record;
}

/**
 * 軟刪除交易紀錄（設定 deleted = true）。
 */
export async function softDeleteTransaction(
  id: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.transactions, database.outbox, async () => {
    const existing = await database.transactions.get(id);
    if (!existing) {
      return;
    }
    await database.transactions.put({
      ...existing,
      deleted: true,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('transactions', id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 新增或更新分類。
 */
export async function saveCategory(
  input: SaveCategoryInput,
  database: ExpenseDatabase = db,
): Promise<Category> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const existing = input.id ? await database.categories.get(input.id) : undefined;

  let sortOrder = input.sortOrder ?? existing?.sortOrder;
  if (sortOrder === undefined) {
    const siblings = await database.categories
      .filter((c) => !c.deleted && c.kind === input.kind && c.parentId === input.parentId)
      .toArray();
    sortOrder = siblings.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;
  }

  const record: Category = {
    id: input.id ?? uuidv7(),
    name: input.name.trim(),
    icon: input.icon.trim() || '📦',
    kind: input.kind,
    parentId: input.parentId,
    sortOrder,
    archived: input.archived ?? existing?.archived ?? false,
    updatedAt: now,
    deviceId,
    deleted: false,
  };

  await database.transaction('rw', database.categories, database.outbox, async () => {
    await database.categories.put(record);
    await database.outbox.put(createOutboxEntry('categories', record.id, now));
  });
  notifyLocalMutation(database);
  return record;
}

/**
 * 停用或啟用分類。
 */
export async function archiveCategory(
  id: string,
  archived: boolean,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.categories, database.outbox, async () => {
    const existing = await database.categories.get(id);
    if (!existing) {
      return;
    }
    await database.categories.put({
      ...existing,
      archived,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('categories', id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 軟刪除分類（若已有交易使用或仍有子分類則拒絕刪除）。
 */
export async function softDeleteCategory(
  id: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction(
    'rw',
    database.categories,
    database.transactions,
    database.outbox,
    async () => {
      const existing = await database.categories.get(id);
      if (!existing) {
        return;
      }

      const usedTxCount = await database.transactions
        .filter((tx) => !tx.deleted && tx.categoryId === id)
        .count();
      if (usedTxCount > 0) {
        throw new Error('此分類已有交易紀錄使用，僅可停用');
      }

      const childCount = await database.categories
        .filter((c) => !c.deleted && c.parentId === id)
        .count();
      if (childCount > 0) {
        throw new Error('此分類仍有子分類，請先處理子分類');
      }

      await database.categories.put({
        ...existing,
        deleted: true,
        updatedAt: now,
        deviceId,
      });
      await database.outbox.put(createOutboxEntry('categories', id, now));
      updated = true;
    },
  );

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 交換兩個分類的排序順序。
 */
export async function swapCategorySortOrder(
  idA: string,
  idB: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.categories, database.outbox, async () => {
    const [a, b] = await Promise.all([database.categories.get(idA), database.categories.get(idB)]);
    if (!a || !b) {
      return;
    }
    const orderA = a.sortOrder === b.sortOrder ? a.sortOrder : b.sortOrder;
    const orderB = a.sortOrder === b.sortOrder ? b.sortOrder + 1 : a.sortOrder;

    await database.categories.bulkPut([
      { ...a, sortOrder: orderA, updatedAt: now, deviceId },
      { ...b, sortOrder: orderB, updatedAt: now, deviceId },
    ]);
    await database.outbox.bulkPut([
      createOutboxEntry('categories', a.id, now),
      createOutboxEntry('categories', b.id, now),
    ]);
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 新增或更新帳戶。
 */
export async function saveAccount(
  input: SaveAccountInput,
  database: ExpenseDatabase = db,
): Promise<Account> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const existing = input.id ? await database.accounts.get(input.id) : undefined;

  let sortOrder = input.sortOrder ?? existing?.sortOrder;
  if (sortOrder === undefined) {
    const allAccounts = await database.accounts.filter((a) => !a.deleted).toArray();
    sortOrder = allAccounts.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;
  }

  const record: Account = {
    id: input.id ?? uuidv7(),
    name: input.name.trim(),
    type: input.type,
    initialBalance: Math.trunc(input.initialBalance),
    sortOrder,
    archived: input.archived ?? existing?.archived ?? false,
    updatedAt: now,
    deviceId,
    deleted: false,
  };

  await database.transaction('rw', database.accounts, database.outbox, async () => {
    await database.accounts.put(record);
    await database.outbox.put(createOutboxEntry('accounts', record.id, now));
  });
  notifyLocalMutation(database);
  return record;
}

/**
 * 停用或啟用帳戶。
 */
export async function archiveAccount(
  id: string,
  archived: boolean,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.accounts, database.outbox, async () => {
    const existing = await database.accounts.get(id);
    if (!existing) {
      return;
    }
    await database.accounts.put({
      ...existing,
      archived,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('accounts', id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 交換兩個帳戶的排序順序。
 */
export async function swapAccountSortOrder(
  idA: string,
  idB: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.accounts, database.outbox, async () => {
    const [a, b] = await Promise.all([database.accounts.get(idA), database.accounts.get(idB)]);
    if (!a || !b) {
      return;
    }
    const orderA = a.sortOrder === b.sortOrder ? a.sortOrder : b.sortOrder;
    const orderB = a.sortOrder === b.sortOrder ? b.sortOrder + 1 : a.sortOrder;

    await database.accounts.bulkPut([
      { ...a, sortOrder: orderA, updatedAt: now, deviceId },
      { ...b, sortOrder: orderB, updatedAt: now, deviceId },
    ]);
    await database.outbox.bulkPut([
      createOutboxEntry('accounts', a.id, now),
      createOutboxEntry('accounts', b.id, now),
    ]);
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 匯出所有資料表紀錄（包含已軟刪除紀錄）與資料庫版本號。
 */
export async function exportBackupData(database: ExpenseDatabase = db): Promise<BackupPayload> {
  const [accounts, categories, transactions, meta] = await Promise.all([
    database.accounts.toArray(),
    database.categories.toArray(),
    database.transactions.toArray(),
    database.meta.toArray(),
  ]);

  return {
    schemaVersion: database.verno,
    exportedAt: Date.now(),
    accounts,
    categories,
    transactions,
    meta,
  };
}

/**
 * 驗證並解析匯入的 JSON 備份內容。
 */
export function parseBackupPayload(raw: unknown): BackupPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('備份檔案格式不正確');
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.schemaVersion !== 'number' ||
    !Array.isArray(obj.accounts) ||
    !Array.isArray(obj.categories) ||
    !Array.isArray(obj.transactions)
  ) {
    throw new Error('備份檔案缺少必要欄位');
  }

  return {
    schemaVersion: obj.schemaVersion,
    exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : Date.now(),
    accounts: obj.accounts as Account[],
    categories: obj.categories as Category[],
    transactions: obj.transactions as Transaction[],
    meta: Array.isArray(obj.meta) ? (obj.meta as MetaEntry[]) : undefined,
  };
}

/**
 * 以 id 合併備份資料至現有資料庫（同 id 取 updatedAt 較新者，不清空現有資料）。
 */
export async function restoreBackupData(
  payload: BackupPayload,
  database: ExpenseDatabase = db,
): Promise<RestoreSummary> {
  const now = Date.now();

  await database.transaction(
    'rw',
    database.accounts,
    database.categories,
    database.transactions,
    database.outbox,
    async () => {
      const [existingAccounts, existingCategories, existingTransactions] = await Promise.all([
        database.accounts.toArray(),
        database.categories.toArray(),
        database.transactions.toArray(),
      ]);

      const mergedAccounts = mergeBackup(existingAccounts, payload.accounts);
      const mergedCategories = mergeBackup(existingCategories, payload.categories);
      const mergedTransactions = mergeBackup(existingTransactions, payload.transactions);

      const outboxEntries: OutboxEntry[] = [
        ...payload.accounts.map((item) => createOutboxEntry('accounts', item.id, now)),
        ...payload.categories.map((item) => createOutboxEntry('categories', item.id, now)),
        ...payload.transactions.map((item) => createOutboxEntry('transactions', item.id, now)),
      ];

      await Promise.all([
        database.accounts.bulkPut(mergedAccounts),
        database.categories.bulkPut(mergedCategories),
        database.transactions.bulkPut(mergedTransactions),
        outboxEntries.length > 0 ? database.outbox.bulkPut(outboxEntries) : Promise.resolve(),
      ]);
    },
  );

  notifyLocalMutation(database);

  return {
    accounts: payload.accounts.length,
    categories: payload.categories.length,
    transactions: payload.transactions.length,
  };
}
