import { mergeBackup } from '../domain/backup';
import type { CsvImportPlan } from '../domain/csvImport';
import type { PeriodKind } from '../domain/reports';
import { db, type ExpenseDatabase, META_KEYS } from './database';
import { getDeviceId } from './deviceId';
import type {
  Account,
  AccountType,
  Category,
  CategoryKind,
  MetaEntry,
  NotePreset,
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
  invoiceNo?: string | null;
}

export class DuplicateInvoiceError extends Error {
  readonly existingTransaction: Transaction;

  constructor(existingTransaction: Transaction) {
    super(`這張發票已經記過了（${existingTransaction.date} ${existingTransaction.amount}）`);
    this.name = 'DuplicateInvoiceError';
    this.existingTransaction = existingTransaction;
  }
}

/**
 * 查詢是否已有未刪除的交易使用相同發票號碼（可排除指定交易 id）。
 */
export async function findActiveTransactionByInvoiceNo(
  invoiceNo: string,
  excludeId?: string,
  database: ExpenseDatabase = db,
): Promise<Transaction | undefined> {
  const normalized = invoiceNo.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  return database.transactions
    .where('invoiceNo')
    .equals(normalized)
    .filter((tx) => !tx.deleted && tx.id !== excludeId)
    .first();
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
  notePresets?: NotePreset[];
  meta?: MetaEntry[];
}

export interface RestoreSummary {
  accounts: number;
  categories: number;
  transactions: number;
  notePresets: number;
}

export interface AmountColors {
  expense: string;
  income: string;
}

export const DEFAULT_AMOUNT_COLORS: AmountColors = {
  expense: '#2563EB',
  income: '#8B5E3C',
};

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/**
 * 驗證色碼是否為合法的 #RRGGBB 格式。
 */
export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value);
}

/**
 * 讀取本機金額顯示顏色設定，無值或格式不正確時回傳預設值。
 */
export async function getAmountColors(database: ExpenseDatabase = db): Promise<AmountColors> {
  const [expenseEntry, incomeEntry] = await Promise.all([
    database.meta.get(META_KEYS.COLOR_EXPENSE),
    database.meta.get(META_KEYS.COLOR_INCOME),
  ]);

  return {
    expense:
      expenseEntry && isValidHexColor(expenseEntry.value)
        ? expenseEntry.value
        : DEFAULT_AMOUNT_COLORS.expense,
    income:
      incomeEntry && isValidHexColor(incomeEntry.value)
        ? incomeEntry.value
        : DEFAULT_AMOUNT_COLORS.income,
  };
}

/**
 * 儲存本機金額顯示顏色設定（只寫入 meta，不寫入 outbox）。
 */
export async function saveAmountColors(
  colors: Partial<AmountColors>,
  database: ExpenseDatabase = db,
): Promise<AmountColors> {
  if (colors.expense !== undefined && !isValidHexColor(colors.expense)) {
    throw new Error('支出色碼格式不正確，請使用 #RRGGBB 格式');
  }
  if (colors.income !== undefined && !isValidHexColor(colors.income)) {
    throw new Error('收入色碼格式不正確，請使用 #RRGGBB 格式');
  }

  const entries: MetaEntry[] = [];
  if (colors.expense !== undefined) {
    entries.push({ key: META_KEYS.COLOR_EXPENSE, value: colors.expense });
  }
  if (colors.income !== undefined) {
    entries.push({ key: META_KEYS.COLOR_INCOME, value: colors.income });
  }

  if (entries.length > 0) {
    await database.meta.bulkPut(entries);
  }

  return getAmountColors(database);
}

/**
 * 將金額顯示顏色恢復為預設值（清除本機自訂色碼，不寫入 outbox）。
 */
export async function resetAmountColors(database: ExpenseDatabase = db): Promise<AmountColors> {
  await database.meta.bulkDelete([META_KEYS.COLOR_EXPENSE, META_KEYS.COLOR_INCOME]);
  return { ...DEFAULT_AMOUNT_COLORS };
}

/**
 * 讀取報表頁上次選擇的期間模式（月／季／年），無值時預設為月。
 */
export async function getReportPeriodKind(database: ExpenseDatabase = db): Promise<PeriodKind> {
  const entry = await database.meta.get(META_KEYS.REPORT_PERIOD_KIND);
  if (entry?.value === 'month' || entry?.value === 'quarter' || entry?.value === 'year') {
    return entry.value;
  }
  return 'month';
}

/**
 * 儲存報表頁選擇的期間模式至本機 meta（不寫入 outbox）。
 */
export async function saveReportPeriodKind(
  kind: PeriodKind,
  database: ExpenseDatabase = db,
): Promise<void> {
  await database.meta.put({ key: META_KEYS.REPORT_PERIOD_KIND, value: kind });
}

export const NOTE_PRESET_MAX_LENGTH = 40;

/**
 * 去除前後空白並限制常用備註長度上限為 40 字。
 */
export function normalizeNotePresetText(text: string): string {
  return text.trim().slice(0, NOTE_PRESET_MAX_LENGTH);
}

export interface SaveNotePresetInput {
  id?: string;
  text: string;
  categoryId: string | null;
  sortOrder?: number;
  useCount?: number;
  lastUsedAt?: number;
}

export class DuplicateNotePresetError extends Error {
  constructor() {
    super('相同分類下已存在此常用備註');
    this.name = 'DuplicateNotePresetError';
  }
}

/**
 * 讀取是否啟用「自動加入常用備註」（預設開啟）。
 */
export async function getAutoAddNotePresets(database: ExpenseDatabase = db): Promise<boolean> {
  const entry = await database.meta.get(META_KEYS.AUTO_ADD_NOTE_PRESETS);
  return entry?.value !== 'false';
}

/**
 * 儲存「自動加入常用備註」設定至本機 meta（不寫入 outbox）。
 */
export async function setAutoAddNotePresets(
  enabled: boolean,
  database: ExpenseDatabase = db,
): Promise<void> {
  await database.meta.put({
    key: META_KEYS.AUTO_ADD_NOTE_PRESETS,
    value: enabled ? 'true' : 'false',
  });
}

/**
 * 新增或更新常用備註（同一分類或全部分類下不可有重複文字）。
 */
export async function saveNotePreset(
  input: SaveNotePresetInput,
  database: ExpenseDatabase = db,
): Promise<NotePreset> {
  const normalizedText = normalizeNotePresetText(input.text);
  if (!normalizedText) {
    throw new Error('請輸入常用備註內容');
  }
  const normalizedCategoryId = input.categoryId || null;
  const now = Date.now();
  const deviceId = getDeviceId();

  let record!: NotePreset;

  await database.transaction('rw', database.notePresets, database.outbox, async () => {
    const duplicate = await database.notePresets
      .filter(
        (p) =>
          !p.deleted &&
          p.id !== input.id &&
          (p.categoryId ?? null) === normalizedCategoryId &&
          p.text === normalizedText,
      )
      .first();
    if (duplicate) {
      throw new DuplicateNotePresetError();
    }

    const existing = input.id ? await database.notePresets.get(input.id) : undefined;
    let sortOrder = input.sortOrder ?? existing?.sortOrder;
    if (sortOrder === undefined) {
      const allActive = await database.notePresets.filter((p) => !p.deleted).toArray();
      sortOrder = allActive.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;
    }

    record = {
      id: input.id ?? uuidv7(),
      text: normalizedText,
      categoryId: normalizedCategoryId,
      useCount: input.useCount ?? existing?.useCount ?? 1,
      lastUsedAt: input.lastUsedAt ?? existing?.lastUsedAt ?? now,
      sortOrder,
      updatedAt: now,
      deviceId,
      deleted: false,
    };

    await database.notePresets.put(record);
    await database.outbox.put(createOutboxEntry('notePresets', record.id, now));
  });

  notifyLocalMutation(database);
  return record;
}

/**
 * 軟刪除常用備註（設定 deleted = true）。
 */
export async function softDeleteNotePreset(
  id: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.notePresets, database.outbox, async () => {
    const existing = await database.notePresets.get(id);
    if (!existing) {
      return;
    }
    await database.notePresets.put({
      ...existing,
      deleted: true,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('notePresets', id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 交換兩個常用備註的排序順序。
 */
export async function swapNotePresetSortOrder(
  idA: string,
  idB: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.notePresets, database.outbox, async () => {
    const [a, b] = await Promise.all([
      database.notePresets.get(idA),
      database.notePresets.get(idB),
    ]);
    if (!a || !b) {
      return;
    }
    const orderA = a.sortOrder === b.sortOrder ? a.sortOrder : b.sortOrder;
    const orderB = a.sortOrder === b.sortOrder ? b.sortOrder + 1 : a.sortOrder;

    await database.notePresets.bulkPut([
      { ...a, sortOrder: orderA, updatedAt: now, deviceId },
      { ...b, sortOrder: orderB, updatedAt: now, deviceId },
    ]);
    await database.outbox.bulkPut([
      createOutboxEntry('notePresets', a.id, now),
      createOutboxEntry('notePresets', b.id, now),
    ]);
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
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
  const normalizedInvoiceNo = input.invoiceNo?.trim()
    ? input.invoiceNo.trim().toUpperCase()
    : undefined;

  const record: Transaction = {
    id: input.id ?? uuidv7(),
    kind: input.kind,
    date: input.date,
    amount: input.amount,
    accountId: input.accountId,
    toAccountId: input.kind === 'transfer' ? input.toAccountId : null,
    categoryId: input.kind === 'transfer' ? null : input.categoryId,
    note: input.note?.trim() ? input.note.trim() : null,
    ...(normalizedInvoiceNo ? { invoiceNo: normalizedInvoiceNo } : {}),
    updatedAt: now,
    deviceId,
    deleted: false,
  };

  await database.transaction(
    'rw',
    database.transactions,
    database.notePresets,
    database.meta,
    database.outbox,
    async () => {
      if (normalizedInvoiceNo) {
        const duplicate = await database.transactions
          .where('invoiceNo')
          .equals(normalizedInvoiceNo)
          .filter((tx) => !tx.deleted && tx.id !== record.id)
          .first();
        if (duplicate) {
          throw new DuplicateInvoiceError(duplicate);
        }
      }

      await database.transactions.put(record);
      await database.outbox.put(createOutboxEntry('transactions', record.id, now));
      await database.meta.put({ key: META_KEYS.LAST_ACCOUNT_ID, value: record.accountId });
      if (record.kind === 'expense' && record.categoryId) {
        await database.meta.put({ key: META_KEYS.LAST_EXPENSE_CATEGORY_ID, value: record.categoryId });
      } else if (record.kind === 'income' && record.categoryId) {
        await database.meta.put({ key: META_KEYS.LAST_INCOME_CATEGORY_ID, value: record.categoryId });
      }

      if ((record.kind === 'expense' || record.kind === 'income') && record.note) {
        const presetText = normalizeNotePresetText(record.note);
        if (presetText) {
          const candidates = await database.notePresets
            .filter((p) => !p.deleted && p.text === presetText)
            .toArray();
          const targetCategoryId = record.categoryId ?? null;
          const exactMatch = candidates.find((p) => (p.categoryId ?? null) === targetCategoryId);
          const globalMatch = candidates.find((p) => p.categoryId === null);
          const matched = exactMatch ?? globalMatch;

          if (matched) {
            await database.notePresets.put({
              ...matched,
              useCount: matched.useCount + 1,
              lastUsedAt: now,
              updatedAt: now,
              deviceId,
            });
            await database.outbox.put(createOutboxEntry('notePresets', matched.id, now));
          } else {
            const autoAddEntry = await database.meta.get(META_KEYS.AUTO_ADD_NOTE_PRESETS);
            if (autoAddEntry?.value !== 'false') {
              const allActive = await database.notePresets.filter((p) => !p.deleted).toArray();
              const nextOrder = allActive.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;
              const newPreset: NotePreset = {
                id: uuidv7(),
                text: presetText,
                categoryId: targetCategoryId,
                useCount: 1,
                lastUsedAt: now,
                sortOrder: nextOrder,
                updatedAt: now,
                deviceId,
                deleted: false,
              };
              await database.notePresets.put(newPreset);
              await database.outbox.put(createOutboxEntry('notePresets', newPreset.id, now));
            }
          }
        }
      }
    },
  );

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
  const [accounts, categories, transactions, notePresets, meta] = await Promise.all([
    database.accounts.toArray(),
    database.categories.toArray(),
    database.transactions.toArray(),
    database.notePresets.toArray(),
    database.meta.toArray(),
  ]);

  return {
    schemaVersion: database.verno,
    exportedAt: Date.now(),
    accounts,
    categories,
    transactions,
    notePresets,
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
    notePresets: Array.isArray(obj.notePresets) ? (obj.notePresets as NotePreset[]) : [],
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
  const incomingPresets = payload.notePresets ?? [];

  await database.transaction(
    'rw',
    database.accounts,
    database.categories,
    database.transactions,
    database.notePresets,
    database.outbox,
    async () => {
      const [existingAccounts, existingCategories, existingTransactions, existingPresets] =
        await Promise.all([
          database.accounts.toArray(),
          database.categories.toArray(),
          database.transactions.toArray(),
          database.notePresets.toArray(),
        ]);

      const mergedAccounts = mergeBackup(existingAccounts, payload.accounts);
      const mergedCategories = mergeBackup(existingCategories, payload.categories);
      const mergedTransactions = mergeBackup(existingTransactions, payload.transactions);
      const mergedPresets = mergeBackup(existingPresets, incomingPresets);

      const outboxEntries: OutboxEntry[] = [
        ...payload.accounts.map((item) => createOutboxEntry('accounts', item.id, now)),
        ...payload.categories.map((item) => createOutboxEntry('categories', item.id, now)),
        ...payload.transactions.map((item) => createOutboxEntry('transactions', item.id, now)),
        ...incomingPresets.map((item) => createOutboxEntry('notePresets', item.id, now)),
      ];

      await Promise.all([
        database.accounts.bulkPut(mergedAccounts),
        database.categories.bulkPut(mergedCategories),
        database.transactions.bulkPut(mergedTransactions),
        database.notePresets.bulkPut(mergedPresets),
        outboxEntries.length > 0 ? database.outbox.bulkPut(outboxEntries) : Promise.resolve(),
      ]);
    },
  );

  notifyLocalMutation(database);

  return {
    accounts: payload.accounts.length,
    categories: payload.categories.length,
    transactions: payload.transactions.length,
    notePresets: incomingPresets.length,
  };
}

export interface CsvImportResult {
  importedCount: number;
  createdAccountsCount: number;
  createdCategoriesCount: number;
}

/**
 * 執行 CSV 匯入計畫：建立缺少的帳戶與分類，並寫入交易紀錄與 outbox 以便同步。
 */
export async function importCsvPlan(
  plan: CsvImportPlan,
  database: ExpenseDatabase = db,
): Promise<CsvImportResult> {
  if (plan.items.length === 0) {
    return {
      importedCount: 0,
      createdAccountsCount: 0,
      createdCategoriesCount: 0,
    };
  }

  const now = Date.now();
  const deviceId = getDeviceId();
  let createdAccountsCount = 0;
  let createdCategoriesCount = 0;

  await database.transaction(
    'rw',
    database.accounts,
    database.categories,
    database.transactions,
    database.outbox,
    async () => {
      const [existingAccounts, existingCategories] = await Promise.all([
        database.accounts.filter((a) => !a.deleted).toArray(),
        database.categories.filter((c) => !c.deleted).toArray(),
      ]);

      const accountByName = new Map(existingAccounts.map((a) => [a.name.trim(), a]));
      let nextAccountSortOrder =
        existingAccounts.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;

      const accountsToPut: Account[] = [];
      const outboxEntries: OutboxEntry[] = [];

      for (const spec of plan.newAccounts) {
        const name = spec.name.trim();
        if (accountByName.has(name)) {
          continue;
        }
        const record: Account = {
          id: uuidv7(),
          name,
          type: spec.type,
          initialBalance: 0,
          sortOrder: nextAccountSortOrder,
          archived: false,
          updatedAt: now,
          deviceId,
          deleted: false,
        };
        nextAccountSortOrder += 1;
        accountByName.set(name, record);
        accountsToPut.push(record);
        outboxEntries.push(createOutboxEntry('accounts', record.id, now));
        createdAccountsCount += 1;
      }

      const parentByKey = new Map<string, Category>();
      const childByKey = new Map<string, Category>();
      const categoryById = new Map(existingCategories.map((c) => [c.id, c]));

      for (const cat of existingCategories) {
        if (cat.parentId === null) {
          parentByKey.set(`${cat.kind}\0${cat.name.trim()}`, cat);
        }
      }
      for (const cat of existingCategories) {
        if (cat.parentId !== null) {
          const parent = categoryById.get(cat.parentId);
          if (parent) {
            childByKey.set(`${cat.kind}\0${parent.name.trim()}\0${cat.name.trim()}`, cat);
          }
        }
      }

      const categoriesToPut: Category[] = [];

      const getNextCategorySortOrder = (kind: CategoryKind, parentId: string | null): number => {
        const all = [...existingCategories, ...categoriesToPut];
        const maxOrder = all
          .filter((c) => c.kind === kind && c.parentId === parentId)
          .reduce((max, item) => Math.max(max, item.sortOrder), 0);
        return maxOrder + 1;
      };

      for (const spec of plan.newCategories) {
        if (spec.parentName !== null) {
          continue;
        }
        const key = `${spec.kind}\0${spec.name.trim()}`;
        if (parentByKey.has(key)) {
          continue;
        }
        const record: Category = {
          id: uuidv7(),
          name: spec.name.trim(),
          icon: '📦',
          kind: spec.kind,
          parentId: null,
          sortOrder: getNextCategorySortOrder(spec.kind, null),
          archived: false,
          updatedAt: now,
          deviceId,
          deleted: false,
        };
        parentByKey.set(key, record);
        categoriesToPut.push(record);
        outboxEntries.push(createOutboxEntry('categories', record.id, now));
        createdCategoriesCount += 1;
      }

      for (const spec of plan.newCategories) {
        if (spec.parentName === null) {
          continue;
        }
        const parent = parentByKey.get(`${spec.kind}\0${spec.parentName.trim()}`);
        if (!parent) {
          continue;
        }
        const key = `${spec.kind}\0${spec.parentName.trim()}\0${spec.name.trim()}`;
        if (childByKey.has(key)) {
          continue;
        }
        const record: Category = {
          id: uuidv7(),
          name: spec.name.trim(),
          icon: '📦',
          kind: spec.kind,
          parentId: parent.id,
          sortOrder: getNextCategorySortOrder(spec.kind, parent.id),
          archived: false,
          updatedAt: now,
          deviceId,
          deleted: false,
        };
        childByKey.set(key, record);
        categoriesToPut.push(record);
        outboxEntries.push(createOutboxEntry('categories', record.id, now));
        createdCategoriesCount += 1;
      }

      const transactionsToPut: Transaction[] = [];

      for (const item of plan.items) {
        const account = accountByName.get(item.accountName);
        if (!account) {
          throw new Error(`找不到帳戶：${item.accountName}`);
        }

        let toAccountId: string | null = null;
        if (item.kind === 'transfer') {
          const toAcc = item.toAccountName ? accountByName.get(item.toAccountName) : undefined;
          if (!toAcc) {
            throw new Error(`找不到轉入帳戶：${item.toAccountName ?? ''}`);
          }
          toAccountId = toAcc.id;
        }

        let categoryId: string | null = null;
        if (item.kind !== 'transfer') {
          if (item.subCategoryName) {
            const child = childByKey.get(
              `${item.kind}\0${item.categoryName}\0${item.subCategoryName}`,
            );
            categoryId = child?.id ?? null;
          } else {
            const parent = parentByKey.get(`${item.kind}\0${item.categoryName}`);
            categoryId = parent?.id ?? null;
          }
          if (!categoryId) {
            throw new Error(`找不到分類：${item.categoryName}`);
          }
        }

        const txRecord: Transaction = {
          id: uuidv7(),
          kind: item.kind,
          date: item.date,
          amount: item.amount,
          accountId: account.id,
          toAccountId,
          categoryId,
          note: item.note,
          ...(item.invoiceNo ? { invoiceNo: item.invoiceNo } : {}),
          updatedAt: now,
          deviceId,
          deleted: false,
        };

        transactionsToPut.push(txRecord);
        outboxEntries.push(createOutboxEntry('transactions', txRecord.id, now));
      }

      await Promise.all([
        accountsToPut.length > 0 ? database.accounts.bulkPut(accountsToPut) : Promise.resolve(),
        categoriesToPut.length > 0 ? database.categories.bulkPut(categoriesToPut) : Promise.resolve(),
        database.transactions.bulkPut(transactionsToPut),
        database.outbox.bulkPut(outboxEntries),
      ]);
    },
  );

  notifyLocalMutation(database);

  return {
    importedCount: plan.items.length,
    createdAccountsCount,
    createdCategoriesCount,
  };
}
