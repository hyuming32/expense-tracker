import { mergeBackup } from '../domain/backup';
import type { CsvImportPlan } from '../domain/csvImport';
import {
  DEFAULT_HOME_SECTION_KEYS,
  type HomeLayoutItem,
  type HomeSectionKey,
  parseHomeLayoutJson,
  resolveHomeLayout,
} from '../domain/homeLayout';
import { buildRecurringTransactionId, dueOccurrences } from '../domain/recurring';
import { getTodayDateString } from '../domain/format';
import { isValidSellerId, normalizePlaceName } from '../domain/places';
import { normalizeTags } from '../domain/tags';
import type { QuickTextResult } from '../domain/quickText';
import type { PeriodKind } from '../domain/reports';
import {
  CARRIER_CARD_ID,
  CARRIER_CARD_NAME,
  isValidCarrier,
  MEMBER_CARD_NAME_MAX_LENGTH,
  normalizeCarrier,
  pickCardColor,
} from '../domain/carrier';
import {
  CURRENCY_NAME_MAX_LENGTH,
  getDefaultCurrencyDecimals,
  getDefaultCurrencyName,
  getMainCurrency,
  hasAtMostDecimals,
  isValidCurrencyCode,
  isValidRate,
  planMainCurrencySwitch,
  roundToDecimals,
} from '../domain/currency';
import { type BarcodeFormat, guessFormat } from '../lib/barcode';
import { parsePinRecordJson, type PinRecord } from '../lib/pinLock';
import { db, type ExpenseDatabase, META_KEYS } from './database';
import { getDeviceId } from './deviceId';
import type {
  Account,
  AccountType,
  Budget,
  Category,
  CategoryKind,
  CurrencyRate,
  LotteryDraw,
  MetaEntry,
  NoSpendDay,
  NotePreset,
  OutboxEntry,
  Place,
  RecurringFrequency,
  RecurringRule,
  Shortcut,
  SyncTableName,
  Transaction,
  TransactionKind,
  WalletCard,
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
  time?: string | null;
  amount: number;
  currency?: string | null;
  originalAmount?: number | null;
  rate?: number | null;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  placeId?: string | null;
  note: string | null;
  tags?: string[];
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
  recurringRules?: RecurringRule[];
  shortcuts?: Shortcut[];
  places?: Place[];
  lotteryDraws?: LotteryDraw[];
  budgets?: Budget[];
  noSpendDays?: NoSpendDay[];
  cards?: WalletCard[];
  currencies?: CurrencyRate[];
  meta?: MetaEntry[];
}

export interface RestoreSummary {
  accounts: number;
  categories: number;
  transactions: number;
  notePresets: number;
  recurringRules: number;
  shortcuts: number;
  places: number;
  lotteryDraws: number;
  budgets: number;
  noSpendDays: number;
  cards: number;
  currencies: number;
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
 * 儲存或更新一筆交易紀錄，並同步更新最後使用的帳戶、分類、地點與使用統計。
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
  const normalizedTime = input.time?.trim() ? input.time.trim() : null;
  const normalizedPlaceId = input.placeId?.trim() ? input.placeId.trim() : null;
  const normalizedTags = input.tags ? normalizeTags(input.tags) : [];
  const normalizedCurrency = input.currency?.trim() ? input.currency.trim().toUpperCase() : null;

  const record: Transaction = {
    id: input.id ?? uuidv7(),
    kind: input.kind,
    date: input.date,
    time: normalizedTime,
    amount: input.amount,
    accountId: input.accountId,
    toAccountId: input.kind === 'transfer' ? input.toAccountId : null,
    categoryId: input.kind === 'transfer' ? null : input.categoryId,
    placeId: normalizedPlaceId,
    note: input.note?.trim() ? input.note.trim() : null,
    ...(normalizedTags.length > 0 ? { tags: normalizedTags } : {}),
    ...(normalizedInvoiceNo ? { invoiceNo: normalizedInvoiceNo } : {}),
    ...(normalizedCurrency
      ? {
          currency: normalizedCurrency,
          originalAmount: input.originalAmount ?? null,
          rate: input.rate ?? null,
        }
      : input.currency === null
        ? {
            currency: null,
            originalAmount: null,
            rate: null,
          }
        : {}),
    updatedAt: now,
    deviceId,
    deleted: false,
  };

  await database.transaction(
    'rw',
    [
      database.transactions,
      database.notePresets,
      database.places,
      database.currencies,
      database.meta,
      database.outbox,
    ],
    async () => {
      const existingTx = input.id ? await database.transactions.get(input.id) : undefined;
      const isNewTx = !existingTx;

      if (!normalizedCurrency && existingTx?.currency) {
        record.currency = null;
        record.originalAmount = null;
        record.rate = null;
      }

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

      if (isNewTx && normalizedCurrency && typeof input.rate === 'number' && isValidRate(input.rate)) {
        const allCurrencies = await database.currencies.toArray();
        const mainCurrency = getMainCurrency(allCurrencies);
        if (normalizedCurrency !== mainCurrency.code) {
          const existingCur = allCurrencies.find(
            (c) => c.id === normalizedCurrency || c.code === normalizedCurrency,
          );
          if (existingCur && !existingCur.deleted && !existingCur.isMain) {
            if (existingCur.rate !== input.rate) {
              await database.currencies.put({
                ...existingCur,
                rate: input.rate,
                updatedAt: now,
                deviceId,
              });
              await database.outbox.put(createOutboxEntry('currencies', existingCur.id, now));
            }
          } else if (!existingCur || existingCur.deleted) {
            const maxSort = allCurrencies.reduce((max, item) => Math.max(max, item.sortOrder), 0);
            const newCur: CurrencyRate = {
              id: normalizedCurrency,
              code: normalizedCurrency,
              name: existingCur?.name || getDefaultCurrencyName(normalizedCurrency),
              rate: input.rate,
              decimals: existingCur?.decimals ?? getDefaultCurrencyDecimals(normalizedCurrency),
              isMain: false,
              sortOrder: existingCur?.sortOrder ?? maxSort + 1,
              archived: false,
              updatedAt: now,
              deviceId,
              deleted: false,
            };
            await database.currencies.put(newCur);
            await database.outbox.put(createOutboxEntry('currencies', newCur.id, now));
          }
        }
      }
      await database.meta.put({ key: META_KEYS.LAST_ACCOUNT_ID, value: record.accountId });
      if (record.kind === 'expense' && record.categoryId) {
        await database.meta.put({ key: META_KEYS.LAST_EXPENSE_CATEGORY_ID, value: record.categoryId });
      } else if (record.kind === 'income' && record.categoryId) {
        await database.meta.put({ key: META_KEYS.LAST_INCOME_CATEGORY_ID, value: record.categoryId });
      }

      if (normalizedPlaceId) {
        const place = await database.places.get(normalizedPlaceId);
        if (place && !place.deleted) {
          await database.places.put({
            ...place,
            useCount: place.useCount + 1,
            lastUsedAt: now,
            updatedAt: now,
            deviceId,
          });
          await database.outbox.put(createOutboxEntry('places', place.id, now));
          await database.meta.put({ key: META_KEYS.LAST_PLACE_ID, value: place.id });
        }
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
  const [existing, allCurrencies] = await Promise.all([
    input.id ? database.accounts.get(input.id) : Promise.resolve(undefined),
    database.currencies.toArray(),
  ]);
  const mainDecimals = getMainCurrency(allCurrencies).decimals;

  let sortOrder = input.sortOrder ?? existing?.sortOrder;
  if (sortOrder === undefined) {
    const allAccounts = await database.accounts.filter((a) => !a.deleted).toArray();
    sortOrder = allAccounts.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;
  }

  const record: Account = {
    id: input.id ?? uuidv7(),
    name: input.name.trim(),
    type: input.type,
    initialBalance: roundToDecimals(input.initialBalance, mainDecimals),
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
  const [
    accounts,
    categories,
    transactions,
    notePresets,
    recurringRules,
    shortcuts,
    places,
    lotteryDraws,
    budgets,
    noSpendDays,
    cards,
    currencies,
    meta,
  ] = await Promise.all([
    database.accounts.toArray(),
    database.categories.toArray(),
    database.transactions.toArray(),
    database.notePresets.toArray(),
    database.recurringRules.toArray(),
    database.shortcuts.toArray(),
    database.places.toArray(),
    database.lotteryDraws.toArray(),
    database.budgets.toArray(),
    database.noSpendDays.toArray(),
    database.cards.toArray(),
    database.currencies.toArray(),
    database.meta.toArray(),
  ]);

  // 過濾掉僅限本機使用的 ui.* 設定（如首頁排版、密碼鎖、隱藏金額等），避免隨 JSON 備份外流
  const exportableMeta = meta.filter((entry) => !entry.key.startsWith('ui.'));

  return {
    schemaVersion: database.verno,
    exportedAt: Date.now(),
    accounts,
    categories,
    transactions,
    notePresets,
    recurringRules,
    shortcuts,
    places,
    lotteryDraws,
    budgets,
    noSpendDays,
    cards,
    currencies,
    meta: exportableMeta,
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
    recurringRules: Array.isArray(obj.recurringRules)
      ? (obj.recurringRules as RecurringRule[])
      : [],
    shortcuts: Array.isArray(obj.shortcuts) ? (obj.shortcuts as Shortcut[]) : [],
    places: Array.isArray(obj.places) ? (obj.places as Place[]) : [],
    lotteryDraws: Array.isArray(obj.lotteryDraws) ? (obj.lotteryDraws as LotteryDraw[]) : [],
    budgets: Array.isArray(obj.budgets) ? (obj.budgets as Budget[]) : [],
    noSpendDays: Array.isArray(obj.noSpendDays) ? (obj.noSpendDays as NoSpendDay[]) : [],
    cards: Array.isArray(obj.cards) ? (obj.cards as WalletCard[]) : [],
    currencies: Array.isArray(obj.currencies) ? (obj.currencies as CurrencyRate[]) : [],
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
  const incomingRecurringRules = payload.recurringRules ?? [];
  const incomingShortcuts = payload.shortcuts ?? [];
  const incomingPlaces = payload.places ?? [];
  const incomingLotteryDraws = payload.lotteryDraws ?? [];
  const incomingBudgets = payload.budgets ?? [];
  const incomingNoSpendDays = payload.noSpendDays ?? [];
  const incomingCards = payload.cards ?? [];
  const incomingCurrencies = payload.currencies ?? [];

  await database.transaction(
    'rw',
    [
      database.accounts,
      database.categories,
      database.transactions,
      database.notePresets,
      database.recurringRules,
      database.shortcuts,
      database.places,
      database.lotteryDraws,
      database.budgets,
      database.noSpendDays,
      database.cards,
      database.currencies,
      database.outbox,
    ],
    async () => {
      const [
        existingAccounts,
        existingCategories,
        existingTransactions,
        existingPresets,
        existingRecurringRules,
        existingShortcuts,
        existingPlaces,
        existingLotteryDraws,
        existingBudgets,
        existingNoSpendDays,
        existingCards,
        existingCurrencies,
      ] = await Promise.all([
        database.accounts.toArray(),
        database.categories.toArray(),
        database.transactions.toArray(),
        database.notePresets.toArray(),
        database.recurringRules.toArray(),
        database.shortcuts.toArray(),
        database.places.toArray(),
        database.lotteryDraws.toArray(),
        database.budgets.toArray(),
        database.noSpendDays.toArray(),
        database.cards.toArray(),
        database.currencies.toArray(),
      ]);

      const mergedAccounts = mergeBackup(existingAccounts, payload.accounts);
      const mergedCategories = mergeBackup(existingCategories, payload.categories);
      const mergedTransactions = mergeBackup(existingTransactions, payload.transactions);
      const mergedPresets = mergeBackup(existingPresets, incomingPresets);
      const mergedRecurringRules = mergeBackup(existingRecurringRules, incomingRecurringRules);
      const mergedShortcuts = mergeBackup(existingShortcuts, incomingShortcuts);
      const mergedPlaces = mergeBackup(existingPlaces, incomingPlaces);
      const mergedLotteryDraws = mergeBackup(existingLotteryDraws, incomingLotteryDraws);
      const mergedBudgets = mergeBackup(existingBudgets, incomingBudgets);
      const mergedNoSpendDays = mergeBackup(existingNoSpendDays, incomingNoSpendDays);
      const mergedCards = mergeBackup(existingCards, incomingCards);
      const mergedCurrencies = mergeBackup(existingCurrencies, incomingCurrencies);

      const outboxEntries: OutboxEntry[] = [
        ...payload.accounts.map((item) => createOutboxEntry('accounts', item.id, now)),
        ...payload.categories.map((item) => createOutboxEntry('categories', item.id, now)),
        ...payload.transactions.map((item) => createOutboxEntry('transactions', item.id, now)),
        ...incomingPresets.map((item) => createOutboxEntry('notePresets', item.id, now)),
        ...incomingRecurringRules.map((item) => createOutboxEntry('recurringRules', item.id, now)),
        ...incomingShortcuts.map((item) => createOutboxEntry('shortcuts', item.id, now)),
        ...incomingPlaces.map((item) => createOutboxEntry('places', item.id, now)),
        ...incomingLotteryDraws.map((item) => createOutboxEntry('lotteryDraws', item.id, now)),
        ...incomingBudgets.map((item) => createOutboxEntry('budgets', item.id, now)),
        ...incomingNoSpendDays.map((item) => createOutboxEntry('noSpendDays', item.id, now)),
        ...incomingCards.map((item) => createOutboxEntry('cards', item.id, now)),
        ...incomingCurrencies.map((item) => createOutboxEntry('currencies', item.id, now)),
      ];

      await Promise.all([
        database.accounts.bulkPut(mergedAccounts),
        database.categories.bulkPut(mergedCategories),
        database.transactions.bulkPut(mergedTransactions),
        database.notePresets.bulkPut(mergedPresets),
        database.recurringRules.bulkPut(mergedRecurringRules),
        database.shortcuts.bulkPut(mergedShortcuts),
        database.places.bulkPut(mergedPlaces),
        database.lotteryDraws.bulkPut(mergedLotteryDraws),
        database.budgets.bulkPut(mergedBudgets),
        database.noSpendDays.bulkPut(mergedNoSpendDays),
        database.cards.bulkPut(mergedCards),
        database.currencies.bulkPut(mergedCurrencies),
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
    recurringRules: incomingRecurringRules.length,
    shortcuts: incomingShortcuts.length,
    places: incomingPlaces.length,
    lotteryDraws: incomingLotteryDraws.length,
    budgets: incomingBudgets.length,
    noSpendDays: incomingNoSpendDays.length,
    cards: incomingCards.length,
    currencies: incomingCurrencies.length,
  };
}

export interface CsvImportResult {
  importedCount: number;
  createdAccountsCount: number;
  createdCategoriesCount: number;
  createdPlacesCount: number;
  createdCurrenciesCount?: number;
}

/**
 * 執行 CSV 匯入計畫：建立缺少的帳戶、分類與地點，並寫入交易紀錄與 outbox 以便同步。
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
      createdPlacesCount: 0,
    };
  }

  const now = Date.now();
  const deviceId = getDeviceId();
  let createdAccountsCount = 0;
  let createdCategoriesCount = 0;
  let createdPlacesCount = 0;
  let createdCurrenciesCount = 0;

  await database.transaction(
    'rw',
    [
      database.accounts,
      database.categories,
      database.places,
      database.currencies,
      database.transactions,
      database.outbox,
    ],
    async () => {
      const [existingAccounts, existingCategories, existingPlaces, existingCurrencies] =
        await Promise.all([
          database.accounts.filter((a) => !a.deleted).toArray(),
          database.categories.filter((c) => !c.deleted).toArray(),
          database.places.filter((p) => !p.deleted).toArray(),
          database.currencies.toArray(),
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

      const placeByName = new Map(existingPlaces.map((p) => [p.name.trim(), p]));
      let nextPlaceSortOrder =
        existingPlaces.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;
      const placesToPut: Place[] = [];

      for (const rawName of plan.newPlaces ?? []) {
        const name = normalizePlaceName(rawName);
        if (!name || placeByName.has(name)) {
          continue;
        }
        const record: Place = {
          id: uuidv7(),
          name,
          icon: '📍',
          useCount: 0,
          lastUsedAt: 0,
          sortOrder: nextPlaceSortOrder,
          archived: false,
          updatedAt: now,
          deviceId,
          deleted: false,
        };
        nextPlaceSortOrder += 1;
        placeByName.set(name, record);
        placesToPut.push(record);
        outboxEntries.push(createOutboxEntry('places', record.id, now));
        createdPlacesCount += 1;
      }

      const currenciesToPut: CurrencyRate[] = [];
      const activeCurrencyCodes = new Set(
        existingCurrencies.filter((c) => !c.deleted).map((c) => c.code.toUpperCase()),
      );
      const mainCurrencyCode = getMainCurrency(existingCurrencies).code;
      let nextCurrencySortOrder =
        existingCurrencies.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;

      for (const spec of plan.newCurrencies ?? []) {
        const code = spec.code.trim().toUpperCase();
        if (code === mainCurrencyCode || activeCurrencyCodes.has(code)) {
          continue;
        }
        const record: CurrencyRate = {
          id: code,
          code,
          name: spec.name.slice(0, CURRENCY_NAME_MAX_LENGTH),
          rate: spec.rate,
          decimals: spec.decimals,
          isMain: false,
          sortOrder: nextCurrencySortOrder,
          archived: false,
          updatedAt: now,
          deviceId,
          deleted: false,
        };
        nextCurrencySortOrder += 1;
        activeCurrencyCodes.add(code);
        currenciesToPut.push(record);
        outboxEntries.push(createOutboxEntry('currencies', record.id, now));
        createdCurrenciesCount += 1;
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

        const place = item.placeName ? placeByName.get(item.placeName) : undefined;

        const txRecord: Transaction = {
          id: uuidv7(),
          kind: item.kind,
          date: item.date,
          time: item.time ?? null,
          amount: item.amount,
          accountId: account.id,
          toAccountId,
          categoryId,
          placeId: place?.id ?? null,
          note: item.note,
          ...(item.tags.length > 0 ? { tags: item.tags } : {}),
          ...(item.invoiceNo ? { invoiceNo: item.invoiceNo } : {}),
          ...(item.currency
            ? {
                currency: item.currency,
                originalAmount: item.originalAmount ?? null,
                rate: item.rate ?? null,
              }
            : {}),
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
        placesToPut.length > 0 ? database.places.bulkPut(placesToPut) : Promise.resolve(),
        currenciesToPut.length > 0 ? database.currencies.bulkPut(currenciesToPut) : Promise.resolve(),
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
    createdPlacesCount,
    ...(createdCurrenciesCount > 0 ? { createdCurrenciesCount } : {}),
  };
}

export interface SaveRecurringRuleInput {
  id?: string;
  kind: TransactionKind;
  amount: number;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  note: string | null;
  frequency: RecurringFrequency;
  dayOfMonth: number;
  weekday: number;
  monthOfYear: number;
  startDate: string;
  endDate: string | null;
  paused?: boolean;
  autoPost: boolean;
}

export interface PendingRecurringOccurrence {
  rule: RecurringRule;
  occurrenceDate: string;
  transactionId: string;
}

/**
 * 新增或更新週期性收支規則（修改規則不影響已產生的歷史交易）。
 */
export async function saveRecurringRule(
  input: SaveRecurringRuleInput,
  database: ExpenseDatabase = db,
): Promise<RecurringRule> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const [existing, allCurrencies] = await Promise.all([
    input.id ? database.recurringRules.get(input.id) : Promise.resolve(undefined),
    database.currencies.toArray(),
  ]);
  const mainDecimals = getMainCurrency(allCurrencies).decimals;

  const record: RecurringRule = {
    id: input.id ?? uuidv7(),
    kind: input.kind,
    amount: roundToDecimals(input.amount, mainDecimals),
    accountId: input.accountId,
    toAccountId: input.kind === 'transfer' ? input.toAccountId : null,
    categoryId: input.kind === 'transfer' ? null : input.categoryId,
    note: input.note?.trim() ? input.note.trim() : null,
    frequency: input.frequency,
    dayOfMonth: Math.max(1, Math.min(31, Math.trunc(input.dayOfMonth))),
    weekday: ((Math.trunc(input.weekday) % 7) + 7) % 7,
    monthOfYear: Math.max(1, Math.min(12, Math.trunc(input.monthOfYear))),
    startDate: input.startDate,
    endDate: input.endDate?.trim() ? input.endDate.trim() : null,
    paused: input.paused ?? existing?.paused ?? false,
    autoPost: input.autoPost,
    updatedAt: now,
    deviceId,
    deleted: false,
  };

  await database.transaction('rw', database.recurringRules, database.outbox, async () => {
    await database.recurringRules.put(record);
    await database.outbox.put(createOutboxEntry('recurringRules', record.id, now));
  });

  notifyLocalMutation(database);
  return record;
}

/**
 * 暫停或恢復週期性收支規則。
 */
export async function pauseRecurringRule(
  id: string,
  paused: boolean,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.recurringRules, database.outbox, async () => {
    const existing = await database.recurringRules.get(id);
    if (!existing || existing.deleted) {
      return;
    }
    await database.recurringRules.put({
      ...existing,
      paused,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('recurringRules', id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 結束週期性收支規則（設定 endDate，之後不再產生新期數）。
 */
export async function endRecurringRule(
  id: string,
  endDate: string = getTodayDateString(),
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.recurringRules, database.outbox, async () => {
    const existing = await database.recurringRules.get(id);
    if (!existing || existing.deleted) {
      return;
    }
    await database.recurringRules.put({
      ...existing,
      endDate,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('recurringRules', id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 軟刪除週期性收支規則（設定 deleted = true）。
 */
export async function softDeleteRecurringRule(
  id: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.recurringRules, database.outbox, async () => {
    const existing = await database.recurringRules.get(id);
    if (!existing) {
      return;
    }
    await database.recurringRules.put({
      ...existing,
      deleted: true,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('recurringRules', id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

function buildTransactionFromRule(
  rule: RecurringRule,
  occurrenceDate: string,
  deleted: boolean,
  now: number,
  deviceId: string,
): Transaction {
  return {
    id: buildRecurringTransactionId(rule.id, occurrenceDate),
    kind: rule.kind,
    date: occurrenceDate,
    amount: rule.amount,
    accountId: rule.accountId,
    toAccountId: rule.kind === 'transfer' ? rule.toAccountId : null,
    categoryId: rule.kind === 'transfer' ? null : rule.categoryId,
    note: rule.note,
    recurringId: rule.id,
    occurrenceDate,
    updatedAt: now,
    deviceId,
    deleted,
  };
}

/**
 * 執行所有自動入帳週期規則的到期產生與補產生（使用決定性 id 避免多裝置重複或重建已刪除項目）。
 */
export async function processRecurringRules(
  today: string = getTodayDateString(),
  database: ExpenseDatabase = db,
): Promise<Transaction[]> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const createdTransactions: Transaction[] = [];

  await database.transaction(
    'rw',
    database.recurringRules,
    database.transactions,
    database.outbox,
    database.meta,
    async () => {
      const [allRules, lastCheckedMeta] = await Promise.all([
        database.recurringRules.toArray(),
        database.meta.get(META_KEYS.RECURRING_LAST_CHECKED_DATE),
      ]);

      const lastCheckedDate = lastCheckedMeta?.value ?? null;
      const activeAutoRules = allRules.filter(
        (rule) => !rule.deleted && !rule.paused && rule.autoPost,
      );

      const candidates: Array<{ rule: RecurringRule; occurrenceDate: string; txId: string }> = [];

      for (const rule of activeAutoRules) {
        const existingRuleTxCount = await database.transactions
          .where('recurringId')
          .equals(rule.id)
          .count();
        const effectiveLastChecked = existingRuleTxCount > 0 ? lastCheckedDate : null;
        const dates = dueOccurrences(rule, effectiveLastChecked, today);
        for (const occurrenceDate of dates) {
          candidates.push({
            rule,
            occurrenceDate,
            txId: buildRecurringTransactionId(rule.id, occurrenceDate),
          });
        }
      }

      if (candidates.length > 0) {
        const candidateIds = candidates.map((c) => c.txId);
        const existingRows = await database.transactions.bulkGet(candidateIds);
        const existingIdSet = new Set<string>();
        for (const row of existingRows) {
          if (row) {
            existingIdSet.add(row.id);
          }
        }

        const outboxEntries: OutboxEntry[] = [];
        const seenCandidateIds = new Set<string>();

        for (const item of candidates) {
          if (existingIdSet.has(item.txId) || seenCandidateIds.has(item.txId)) {
            continue;
          }
          seenCandidateIds.add(item.txId);
          const tx = buildTransactionFromRule(item.rule, item.occurrenceDate, false, now, deviceId);
          createdTransactions.push(tx);
          outboxEntries.push(createOutboxEntry('transactions', tx.id, now));
        }

        if (createdTransactions.length > 0) {
          await database.transactions.bulkPut(createdTransactions);
          await database.outbox.bulkPut(outboxEntries);
        }
      }

      if (!lastCheckedDate || lastCheckedDate < today) {
        await database.meta.put({
          key: META_KEYS.RECURRING_LAST_CHECKED_DATE,
          value: today,
        });
      }
    },
  );

  if (createdTransactions.length > 0) {
    notifyLocalMutation(database);
  }

  return createdTransactions;
}

/**
 * 查詢所有 autoPost=false 且尚未入帳或略過的到期項目，供首頁顯示「待確認」卡片。
 */
export async function getPendingRecurringOccurrences(
  today: string = getTodayDateString(),
  database: ExpenseDatabase = db,
): Promise<PendingRecurringOccurrence[]> {
  const allRules = await database.recurringRules.toArray();
  const manualRules = allRules.filter((rule) => !rule.deleted && !rule.paused && !rule.autoPost);
  if (manualRules.length === 0) {
    return [];
  }

  const candidates: PendingRecurringOccurrence[] = [];
  for (const rule of manualRules) {
    const dates = dueOccurrences(rule, null, today);
    for (const occurrenceDate of dates) {
      candidates.push({
        rule,
        occurrenceDate,
        transactionId: buildRecurringTransactionId(rule.id, occurrenceDate),
      });
    }
  }

  if (candidates.length === 0) {
    return [];
  }

  const existingRows = await database.transactions.bulkGet(
    candidates.map((item) => item.transactionId),
  );
  const existingIdSet = new Set<string>();
  for (const row of existingRows) {
    if (row) {
      existingIdSet.add(row.id);
    }
  }

  return candidates
    .filter((item) => !existingIdSet.has(item.transactionId))
    .sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
}

/**
 * 將待確認週期項目正式入帳（以決定性 id 寫入交易）。
 */
export async function confirmRecurringOccurrence(
  rule: RecurringRule,
  occurrenceDate: string,
  database: ExpenseDatabase = db,
): Promise<Transaction> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const tx = buildTransactionFromRule(rule, occurrenceDate, false, now, deviceId);

  await database.transaction('rw', database.transactions, database.outbox, async () => {
    const existing = await database.transactions.get(tx.id);
    if (existing) {
      return;
    }
    await database.transactions.put(tx);
    await database.outbox.put(createOutboxEntry('transactions', tx.id, now));
  });

  notifyLocalMutation(database);
  return tx;
}

/**
 * 略過該期待確認週期項目（寫入 deleted=true 的佔位交易，避免重複提示並可同步）。
 */
export async function skipRecurringOccurrence(
  rule: RecurringRule,
  occurrenceDate: string,
  database: ExpenseDatabase = db,
): Promise<Transaction> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const placeholder = buildTransactionFromRule(rule, occurrenceDate, true, now, deviceId);

  await database.transaction('rw', database.transactions, database.outbox, async () => {
    const existing = await database.transactions.get(placeholder.id);
    if (existing) {
      return;
    }
    await database.transactions.put(placeholder);
    await database.outbox.put(createOutboxEntry('transactions', placeholder.id, now));
  });

  notifyLocalMutation(database);
  return placeholder;
}

export interface SaveShortcutInput {
  id?: string;
  label: string;
  icon: string;
  kind: TransactionKind;
  amount: number | null;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  note: string | null;
  sortOrder?: number;
}

/**
 * 新增或更新首頁捷徑（並寫入 outbox 以供同步）。
 */
export async function saveShortcut(
  input: SaveShortcutInput,
  database: ExpenseDatabase = db,
): Promise<Shortcut> {
  const label = input.label.trim();
  if (!label) {
    throw new Error('請輸入捷徑名稱');
  }
  if (!input.accountId) {
    throw new Error('請選擇帳戶');
  }
  if (input.kind === 'transfer') {
    if (!input.toAccountId || input.toAccountId === input.accountId) {
      throw new Error('請選擇不同的轉入帳戶');
    }
  } else if (!input.categoryId) {
    throw new Error('請選擇分類');
  }

  const allCurrencies = await database.currencies.toArray();
  const mainDecimals = getMainCurrency(allCurrencies).decimals;

  let normalizedAmount: number | null = null;
  if (input.amount !== null) {
    const rounded = roundToDecimals(input.amount, mainDecimals);
    if (
      !Number.isFinite(input.amount) ||
      rounded <= 0 ||
      !hasAtMostDecimals(input.amount, mainDecimals)
    ) {
      throw new Error(mainDecimals <= 0 ? '金額需為正整數' : `金額需為正數（最多 ${mainDecimals} 位小數）`);
    }
    normalizedAmount = rounded;
  }

  const now = Date.now();
  const deviceId = getDeviceId();
  let record!: Shortcut;

  await database.transaction('rw', database.shortcuts, database.outbox, async () => {
    const existing = input.id ? await database.shortcuts.get(input.id) : undefined;
    let sortOrder = input.sortOrder ?? existing?.sortOrder;
    if (sortOrder === undefined) {
      const allActive = await database.shortcuts.filter((s) => !s.deleted).toArray();
      sortOrder = allActive.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;
    }

    record = {
      id: input.id ?? uuidv7(),
      label,
      icon: input.icon.trim() || '⚡',
      kind: input.kind,
      amount: normalizedAmount,
      accountId: input.accountId,
      toAccountId: input.kind === 'transfer' ? input.toAccountId : null,
      categoryId: input.kind === 'transfer' ? null : input.categoryId,
      note: input.note?.trim() ? input.note.trim() : null,
      sortOrder,
      updatedAt: now,
      deviceId,
      deleted: false,
    };

    await database.shortcuts.put(record);
    await database.outbox.put(createOutboxEntry('shortcuts', record.id, now));
  });

  notifyLocalMutation(database);
  return record;
}

/**
 * 軟刪除首頁捷徑（設定 deleted = true）。
 */
export async function softDeleteShortcut(
  id: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.shortcuts, database.outbox, async () => {
    const existing = await database.shortcuts.get(id);
    if (!existing) {
      return;
    }
    await database.shortcuts.put({
      ...existing,
      deleted: true,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('shortcuts', id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 交換兩個首頁捷徑的排序順序。
 */
export async function swapShortcutSortOrder(
  idA: string,
  idB: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.shortcuts, database.outbox, async () => {
    const [a, b] = await Promise.all([database.shortcuts.get(idA), database.shortcuts.get(idB)]);
    if (!a || !b) {
      return;
    }
    const orderA = a.sortOrder === b.sortOrder ? a.sortOrder : b.sortOrder;
    const orderB = a.sortOrder === b.sortOrder ? b.sortOrder + 1 : a.sortOrder;

    await database.shortcuts.bulkPut([
      { ...a, sortOrder: orderA, updatedAt: now, deviceId },
      { ...b, sortOrder: orderB, updatedAt: now, deviceId },
    ]);
    await database.outbox.bulkPut([
      createOutboxEntry('shortcuts', a.id, now),
      createOutboxEntry('shortcuts', b.id, now),
    ]);
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 依捷徑一鍵寫入今日交易紀錄（僅限已設定固定金額的捷徑）。
 */
export async function recordShortcutTransaction(
  shortcut: Shortcut,
  date: string = getTodayDateString(),
  database: ExpenseDatabase = db,
): Promise<Transaction> {
  if (shortcut.amount === null || shortcut.amount <= 0) {
    throw new Error('此捷徑未設定固定金額，請先輸入金額');
  }

  return saveTransaction(
    {
      kind: shortcut.kind,
      date,
      amount: shortcut.amount,
      accountId: shortcut.accountId,
      toAccountId: shortcut.kind === 'transfer' ? shortcut.toAccountId : null,
      categoryId: shortcut.kind === 'transfer' ? null : shortcut.categoryId,
      note: shortcut.note,
    },
    database,
  );
}

/**
 * 依一句話快速記帳解析結果直接寫入交易紀錄（含 outbox 與地點使用統計）。
 */
export async function recordQuickTextTransaction(
  parsed: QuickTextResult,
  database: ExpenseDatabase = db,
): Promise<Transaction> {
  if (parsed.amount === null || parsed.amount <= 0) {
    throw new Error('快速記帳缺少有效金額，請先輸入金額');
  }

  return saveTransaction(
    {
      kind: parsed.kind,
      date: parsed.date,
      amount: parsed.amount,
      accountId: parsed.accountId,
      toAccountId: parsed.kind === 'transfer' ? parsed.toAccountId : null,
      categoryId: parsed.kind === 'transfer' ? null : parsed.categoryId,
      placeId: parsed.placeId,
      note: parsed.note,
      tags: parsed.tags,
    },
    database,
  );
}

export class DuplicatePlaceNameError extends Error {
  constructor() {
    super('已存在相同名稱的地點');
    this.name = 'DuplicatePlaceNameError';
  }
}

export class DuplicateSellerIdError extends Error {
  readonly existingPlace: Place;

  constructor(sellerId: string, existingPlace: Place) {
    super(`統一編號 ${sellerId} 已綁定至「${existingPlace.name}」`);
    this.name = 'DuplicateSellerIdError';
    this.existingPlace = existingPlace;
  }
}

export interface SavePlaceInput {
  id?: string;
  name: string;
  icon?: string;
  sortOrder?: number;
  archived?: boolean;
  useCount?: number;
  lastUsedAt?: number;
  sellerIds?: string[];
}

export type SyncSchedule = 'daily' | 'weekly' | 'none';

/**
 * 讀取本機定時同步頻率設定（預設 daily）。
 */
export async function getSyncSchedule(database: ExpenseDatabase = db): Promise<SyncSchedule> {
  const entry = await database.meta.get(META_KEYS.SYNC_SCHEDULE);
  if (entry?.value === 'weekly' || entry?.value === 'none' || entry?.value === 'daily') {
    return entry.value;
  }
  return 'daily';
}

/**
 * 儲存本機定時同步頻率設定至 meta（不寫入 outbox）。
 */
export async function setSyncSchedule(
  schedule: SyncSchedule,
  database: ExpenseDatabase = db,
): Promise<void> {
  await database.meta.put({
    key: META_KEYS.SYNC_SCHEDULE,
    value: schedule,
  });
}

/**
 * 讀取是否啟用「新增記帳時自動帶入上次的地點」本機設定（預設關閉）。
 */
export async function getAutoSelectLastPlace(database: ExpenseDatabase = db): Promise<boolean> {
  const entry = await database.meta.get(META_KEYS.AUTO_SELECT_LAST_PLACE);
  return entry?.value === 'true';
}

/**
 * 儲存「新增記帳時自動帶入上次的地點」設定至本機 meta（不寫入 outbox）。
 */
export async function setAutoSelectLastPlace(
  enabled: boolean,
  database: ExpenseDatabase = db,
): Promise<void> {
  await database.meta.put({
    key: META_KEYS.AUTO_SELECT_LAST_PLACE,
    value: enabled ? 'true' : 'false',
  });
}

function normalizeSellerIds(sellerIds: readonly string[] | undefined): string[] | undefined {
  if (sellerIds === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of sellerIds) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (!isValidSellerId(trimmed)) {
      throw new Error(`統一編號「${trimmed}」格式不正確，需為 8 位數字`);
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * 新增或更新地點（名稱不可重複、最長 30 字，統編不可與其他地點重複）。
 */
export async function savePlace(
  input: SavePlaceInput,
  database: ExpenseDatabase = db,
): Promise<Place> {
  const normalizedName = normalizePlaceName(input.name);
  if (!normalizedName) {
    throw new Error('請輸入地點名稱');
  }
  const normalizedSellers = normalizeSellerIds(input.sellerIds);
  const now = Date.now();
  const deviceId = getDeviceId();

  let record!: Place;

  await database.transaction('rw', database.places, database.outbox, async () => {
    const allActive = await database.places.filter((p) => !p.deleted).toArray();

    const duplicateName = allActive.find(
      (p) => p.id !== input.id && p.name.trim() === normalizedName,
    );
    if (duplicateName) {
      throw new DuplicatePlaceNameError();
    }

    const existing = input.id ? await database.places.get(input.id) : undefined;
    const effectiveSellerIds = normalizedSellers ?? existing?.sellerIds;

    if (effectiveSellerIds && effectiveSellerIds.length > 0) {
      for (const sid of effectiveSellerIds) {
        const conflict = allActive.find(
          (p) => p.id !== (input.id ?? existing?.id) && (p.sellerIds ?? []).includes(sid),
        );
        if (conflict) {
          throw new DuplicateSellerIdError(sid, conflict);
        }
      }
    }

    let sortOrder = input.sortOrder ?? existing?.sortOrder;
    if (sortOrder === undefined) {
      sortOrder = allActive.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;
    }

    record = {
      id: input.id ?? uuidv7(),
      name: normalizedName,
      icon: input.icon?.trim() || existing?.icon || '📍',
      useCount: input.useCount ?? existing?.useCount ?? 0,
      lastUsedAt: input.lastUsedAt ?? existing?.lastUsedAt ?? 0,
      sortOrder,
      archived: input.archived ?? existing?.archived ?? false,
      ...(effectiveSellerIds && effectiveSellerIds.length > 0
        ? { sellerIds: effectiveSellerIds }
        : {}),
      updatedAt: now,
      deviceId,
      deleted: false,
    };

    await database.places.put(record);
    await database.outbox.put(createOutboxEntry('places', record.id, now));
  });

  notifyLocalMutation(database);
  return record;
}

/**
 * 停用或啟用地點。
 */
export async function archivePlace(
  id: string,
  archived: boolean,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.places, database.outbox, async () => {
    const existing = await database.places.get(id);
    if (!existing) {
      return;
    }
    await database.places.put({
      ...existing,
      archived,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('places', id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 軟刪除地點（若已有未刪除交易使用則拒絕刪除，僅可停用）。
 */
export async function softDeletePlace(
  id: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction(
    'rw',
    database.places,
    database.transactions,
    database.outbox,
    async () => {
      const existing = await database.places.get(id);
      if (!existing) {
        return;
      }

      const usedTxCount = await database.transactions
        .filter((tx) => !tx.deleted && tx.placeId === id)
        .count();
      if (usedTxCount > 0) {
        throw new Error('此地點已有交易紀錄使用，僅可停用');
      }

      await database.places.put({
        ...existing,
        deleted: true,
        updatedAt: now,
        deviceId,
      });
      await database.outbox.put(createOutboxEntry('places', id, now));
      updated = true;
    },
  );

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 交換兩個地點的排序順序。
 */
export async function swapPlaceSortOrder(
  idA: string,
  idB: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.places, database.outbox, async () => {
    const [a, b] = await Promise.all([database.places.get(idA), database.places.get(idB)]);
    if (!a || !b) {
      return;
    }
    const orderA = a.sortOrder === b.sortOrder ? a.sortOrder : b.sortOrder;
    const orderB = a.sortOrder === b.sortOrder ? b.sortOrder + 1 : a.sortOrder;

    await database.places.bulkPut([
      { ...a, sortOrder: orderA, updatedAt: now, deviceId },
      { ...b, sortOrder: orderB, updatedAt: now, deviceId },
    ]);
    await database.outbox.bulkPut([
      createOutboxEntry('places', a.id, now),
      createOutboxEntry('places', b.id, now),
    ]);
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 將賣方統一編號綁定（或移轉綁定）至指定地點；一個統編同時只會屬於一個地點。
 */
export async function bindSellerIdToPlace(
  placeId: string,
  sellerId: string,
  database: ExpenseDatabase = db,
): Promise<Place> {
  const normalizedSellerId = sellerId.trim();
  if (!isValidSellerId(normalizedSellerId)) {
    throw new Error('統一編號格式不正確，需為 8 位數字');
  }

  const now = Date.now();
  const deviceId = getDeviceId();
  let updatedTarget!: Place;

  await database.transaction('rw', database.places, database.outbox, async () => {
    const target = await database.places.get(placeId);
    if (!target || target.deleted) {
      throw new Error('找不到指定的地點');
    }

    const allActive = await database.places.filter((p) => !p.deleted).toArray();
    const placesToPut: Place[] = [];
    const outboxEntries: OutboxEntry[] = [];

    for (const place of allActive) {
      if (place.id === placeId) {
        continue;
      }
      const sellers = place.sellerIds ?? [];
      if (sellers.includes(normalizedSellerId)) {
        const nextSellers = sellers.filter((s) => s !== normalizedSellerId);
        const updatedOther: Place = {
          ...place,
          updatedAt: now,
          deviceId,
        };
        if (nextSellers.length > 0) {
          updatedOther.sellerIds = nextSellers;
        } else {
          delete updatedOther.sellerIds;
        }
        placesToPut.push(updatedOther);
        outboxEntries.push(createOutboxEntry('places', place.id, now));
      }
    }

    const targetSellers = target.sellerIds ?? [];
    if (!targetSellers.includes(normalizedSellerId)) {
      updatedTarget = {
        ...target,
        sellerIds: [...targetSellers, normalizedSellerId],
        updatedAt: now,
        deviceId,
      };
      placesToPut.push(updatedTarget);
      outboxEntries.push(createOutboxEntry('places', target.id, now));
    } else {
      updatedTarget = target;
    }

    if (placesToPut.length > 0) {
      await database.places.bulkPut(placesToPut);
      await database.outbox.bulkPut(outboxEntries);
    }
  });

  notifyLocalMutation(database);
  return updatedTarget;
}

export interface SaveLotteryDrawInput {
  period: string;
  special: string;
  grand: string;
  first: readonly string[];
  extraSixth: readonly string[];
}

const LOTTERY_PERIOD_PATTERN = /^\d{4}-(01|03|05|07|09|11)$/;

/**
 * 產生決定性的發票開獎期別識別碼（draw-YYYY-MM），避免雙裝置重複建立。
 */
export function buildLotteryDrawId(period: string): string {
  return `draw-${period}`;
}

/**
 * 儲存或更新指定期別的統一發票開獎號碼，並排入 outbox 同步。
 */
export async function saveLotteryDraw(
  input: SaveLotteryDrawInput,
  database: ExpenseDatabase = db,
): Promise<LotteryDraw> {
  const period = input.period.trim();
  if (!LOTTERY_PERIOD_PATTERN.test(period)) {
    throw new Error('期別格式不正確，需為單數月起始 YYYY-MM（例如 2026-09）');
  }

  const special = input.special.trim();
  const grand = input.grand.trim();
  const first = input.first.map((n) => n.trim()).filter((n) => n.length > 0);
  const extraSixth = input.extraSixth.map((n) => n.trim()).filter((n) => n.length > 0);

  if (!/^\d{8}$/.test(special)) {
    throw new Error('特別獎需為 8 碼數字');
  }
  if (!/^\d{8}$/.test(grand)) {
    throw new Error('特獎需為 8 碼數字');
  }
  if (first.length === 0 || first.some((n) => !/^\d{8}$/.test(n))) {
    throw new Error('頭獎至少需 1 組，且每組需為 8 碼數字');
  }
  if (extraSixth.some((n) => !/^\d{3}$/.test(n))) {
    throw new Error('增開六獎每組需為 3 碼數字');
  }

  const now = Date.now();
  const deviceId = getDeviceId();
  const id = buildLotteryDrawId(period);

  const record: LotteryDraw = {
    id,
    period,
    special,
    grand,
    first,
    extraSixth,
    updatedAt: now,
    deviceId,
    deleted: false,
  };

  await database.transaction('rw', database.lotteryDraws, database.outbox, async () => {
    await database.lotteryDraws.put(record);
    await database.outbox.put(createOutboxEntry('lotteryDraws', id, now));
  });

  notifyLocalMutation(database);
  return record;
}

/**
 * 軟刪除指定期別的統一發票開獎號碼，並排入 outbox 同步。
 */
export async function softDeleteLotteryDraw(
  periodOrId: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const id = periodOrId.startsWith('draw-') ? periodOrId : buildLotteryDrawId(periodOrId);
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.lotteryDraws, database.outbox, async () => {
    const existing = await database.lotteryDraws.get(id);
    if (!existing || existing.deleted) {
      return;
    }
    await database.lotteryDraws.put({
      ...existing,
      updatedAt: now,
      deviceId,
      deleted: true,
    });
    await database.outbox.put(createOutboxEntry('lotteryDraws', id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

export interface SaveBudgetInput {
  categoryId: string | null;
  amount: number | null;
}

/**
 * 產生每月預算的固定主鍵：總預算為 budget-total，分類預算為 budget-<categoryId>。
 */
export function buildBudgetId(categoryId: string | null): string {
  return categoryId === null ? 'budget-total' : `budget-${categoryId}`;
}

/**
 * 讀取所有未刪除的每月預算設定。
 */
export async function getBudgets(database: ExpenseDatabase = db): Promise<Budget[]> {
  const rows = await database.budgets.toArray();
  return rows.filter((b) => !b.deleted);
}

/**
 * 批次設定或清除每月預算（金額為 0 或 null 時軟刪除），並排入 outbox 同步。
 */
export async function saveBudgets(
  inputs: readonly SaveBudgetInput[],
  database: ExpenseDatabase = db,
): Promise<Budget[]> {
  if (inputs.length === 0) {
    return [];
  }

  const now = Date.now();
  const deviceId = getDeviceId();
  const savedRecords: Budget[] = [];
  let changed = false;

  await database.transaction('rw', database.budgets, database.currencies, database.outbox, async () => {
    const mainDecimals = getMainCurrency(await database.currencies.toArray()).decimals;
    for (const input of inputs) {
      const id = buildBudgetId(input.categoryId);
      const rawAmount = input.amount;

      if (rawAmount === null || rawAmount === 0) {
        const existing = await database.budgets.get(id);
        if (existing && !existing.deleted) {
          await database.budgets.put({
            ...existing,
            deleted: true,
            updatedAt: now,
            deviceId,
          });
          await database.outbox.put(createOutboxEntry('budgets', id, now));
          changed = true;
        }
        continue;
      }

      if (
        !Number.isFinite(rawAmount) ||
        rawAmount < 0 ||
        !hasAtMostDecimals(rawAmount, mainDecimals)
      ) {
        throw new Error(
          mainDecimals <= 0
            ? '預算金額須為正整數'
            : `預算金額須為正數（最多 ${mainDecimals} 位小數）`,
        );
      }

      const record: Budget = {
        id,
        categoryId: input.categoryId,
        amount: roundToDecimals(rawAmount, mainDecimals),
        updatedAt: now,
        deviceId,
        deleted: false,
      };
      await database.budgets.put(record);
      await database.outbox.put(createOutboxEntry('budgets', id, now));
      savedRecords.push(record);
      changed = true;
    }
  });

  if (changed) {
    notifyLocalMutation(database);
  }

  return savedRecords;
}

/**
 * 設定或清除單筆每月預算（金額為 0 或 null 時軟刪除該筆），並排入 outbox 同步。
 */
export async function saveBudget(
  input: SaveBudgetInput,
  database: ExpenseDatabase = db,
): Promise<Budget | null> {
  const saved = await saveBudgets([input], database);
  return saved[0] ?? null;
}

export interface OnboardingMetaState {
  onboardingCompleted: boolean;
  lastJsonBackupAt: number | null;
  dataProtectionDismissedAt: number | null;
  installPromptDismissedAt: number | null;
}

function parseOptionalTimestamp(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * 讀取本機儲存的新手導覽與首頁提醒卡狀態（不同步至雲端）。
 */
export async function getOnboardingMetaState(
  database: ExpenseDatabase = db,
): Promise<OnboardingMetaState> {
  const [completed, lastBackup, dataDismissed, installDismissed] = await Promise.all([
    database.meta.get(META_KEYS.UI_ONBOARDING_COMPLETED),
    database.meta.get(META_KEYS.UI_LAST_JSON_BACKUP_AT),
    database.meta.get(META_KEYS.UI_DATA_PROTECTION_DISMISSED_AT),
    database.meta.get(META_KEYS.UI_INSTALL_PROMPT_DISMISSED_AT),
  ]);
  return {
    onboardingCompleted: completed?.value === 'true',
    lastJsonBackupAt: parseOptionalTimestamp(lastBackup?.value),
    dataProtectionDismissedAt: parseOptionalTimestamp(dataDismissed?.value),
    installPromptDismissedAt: parseOptionalTimestamp(installDismissed?.value),
  };
}

/**
 * 記錄使用者已完成或略過新手導覽。
 */
export async function markOnboardingCompleted(database: ExpenseDatabase = db): Promise<void> {
  await database.meta.put({ key: META_KEYS.UI_ONBOARDING_COMPLETED, value: 'true' });
}

/**
 * 記錄最近一次成功匯出 JSON 備份的時間戳記。
 */
export async function recordJsonBackupTimestamp(
  timestamp: number = Date.now(),
  database: ExpenseDatabase = db,
): Promise<void> {
  await database.meta.put({ key: META_KEYS.UI_LAST_JSON_BACKUP_AT, value: String(timestamp) });
}

/**
 * 記錄使用者暫時關閉資料保護提醒卡的時間戳記。
 */
export async function dismissDataProtectionCard(
  timestamp: number = Date.now(),
  database: ExpenseDatabase = db,
): Promise<void> {
  await database.meta.put({
    key: META_KEYS.UI_DATA_PROTECTION_DISMISSED_AT,
    value: String(timestamp),
  });
}

/**
 * 記錄使用者暫時關閉「加到主畫面」提醒卡的時間戳記。
 */
export async function dismissInstallPromptCard(
  timestamp: number = Date.now(),
  database: ExpenseDatabase = db,
): Promise<void> {
  await database.meta.put({
    key: META_KEYS.UI_INSTALL_PROMPT_DISMISSED_AT,
    value: String(timestamp),
  });
}

/**
 * 產生「這天沒花錢」標記的固定主鍵 nospend-YYYY-MM-DD。
 */
export function buildNoSpendDayId(date: string): string {
  return `nospend-${date}`;
}

/**
 * 讀取所有未刪除的「這天沒花錢」標記。
 */
export async function getNoSpendDays(database: ExpenseDatabase = db): Promise<NoSpendDay[]> {
  const rows = await database.noSpendDays.toArray();
  return rows.filter((d) => !d.deleted);
}

/**
 * 設定或取消某天的「這天沒花錢」標記（取消時軟刪除），並排入 outbox 同步。
 */
export async function setNoSpendDay(
  date: string,
  enabled: boolean,
  database: ExpenseDatabase = db,
): Promise<NoSpendDay | null> {
  const id = buildNoSpendDayId(date);
  const now = Date.now();
  const deviceId = getDeviceId();
  let saved: NoSpendDay | null = null;
  let changed = false;

  await database.transaction('rw', database.noSpendDays, database.outbox, async () => {
    if (enabled) {
      const record: NoSpendDay = {
        id,
        date,
        updatedAt: now,
        deviceId,
        deleted: false,
      };
      await database.noSpendDays.put(record);
      await database.outbox.put(createOutboxEntry('noSpendDays', id, now));
      saved = record;
      changed = true;
    } else {
      const existing = await database.noSpendDays.get(id);
      if (existing && !existing.deleted) {
        await database.noSpendDays.put({
          ...existing,
          deleted: true,
          updatedAt: now,
          deviceId,
        });
        await database.outbox.put(createOutboxEntry('noSpendDays', id, now));
        changed = true;
      }
    }
  });

  if (changed) {
    notifyLocalMutation(database);
  }

  return saved;
}

/**
 * 讀取首頁是否顯示「連續記帳與漏記提醒」卡片（預設開啟）。
 */
export async function getShowHabitCard(database: ExpenseDatabase = db): Promise<boolean> {
  const entry = await database.meta.get(META_KEYS.UI_SHOW_HABIT_CARD);
  return entry?.value !== 'false';
}

/**
 * 設定首頁是否顯示「連續記帳與漏記提醒」卡片（存本機 meta，不同步）。
 */
export async function setShowHabitCard(
  enabled: boolean,
  database: ExpenseDatabase = db,
): Promise<void> {
  await database.meta.put({
    key: META_KEYS.UI_SHOW_HABIT_CARD,
    value: enabled ? 'true' : 'false',
  });
}

/**
 * 讀取首頁區塊顯示與順序設定（存本機 meta，不同步、不進 JSON 備份）。
 */
export async function getHomeLayout(
  database: ExpenseDatabase = db,
): Promise<HomeLayoutItem<HomeSectionKey>[]> {
  const [layoutEntry, habitEntry] = await Promise.all([
    database.meta.get(META_KEYS.UI_HOME_LAYOUT),
    database.meta.get(META_KEYS.UI_SHOW_HABIT_CARD),
  ]);
  const saved = parseHomeLayoutJson(layoutEntry?.value);
  const resolved = resolveHomeLayout(saved, DEFAULT_HOME_SECTION_KEYS);
  // 若尚未自訂過首頁排版，沿用舊版「顯示連續記帳卡片」設定
  if (!saved && habitEntry?.value === 'false') {
    return resolved.map((item) =>
      item.key === 'habit' ? { ...item, visible: false } : item,
    );
  }
  return resolved;
}

/**
 * 儲存首頁區塊顯示與順序設定至本機 meta（不同步、不進 JSON 備份）。
 */
export async function saveHomeLayout(
  layout: readonly HomeLayoutItem<HomeSectionKey>[],
  database: ExpenseDatabase = db,
): Promise<void> {
  const habitItem = layout.find((item) => item.key === 'habit');
  await database.meta.put({
    key: META_KEYS.UI_HOME_LAYOUT,
    value: JSON.stringify(layout),
  });
  if (habitItem) {
    await database.meta.put({
      key: META_KEYS.UI_SHOW_HABIT_CARD,
      value: habitItem.visible ? 'true' : 'false',
    });
  }
}

/**
 * 將首頁區塊顯示與順序恢復為預設值。
 */
export async function resetHomeLayout(database: ExpenseDatabase = db): Promise<void> {
  await database.meta.bulkDelete([META_KEYS.UI_HOME_LAYOUT]);
  await database.meta.put({ key: META_KEYS.UI_SHOW_HABIT_CARD, value: 'true' });
}

/**
 * 讀取本機密碼鎖的 salt 與雜湊紀錄（未設定時回傳 null）。
 */
export async function getPinRecord(database: ExpenseDatabase = db): Promise<PinRecord | null> {
  const entry = await database.meta.get(META_KEYS.UI_PIN_HASH);
  return parsePinRecordJson(entry?.value);
}

/**
 * 儲存本機密碼鎖的 salt 與雜湊（只存雜湊，不存明碼、不同步）。
 */
export async function savePinRecord(
  record: PinRecord,
  database: ExpenseDatabase = db,
): Promise<void> {
  await database.meta.put({
    key: META_KEYS.UI_PIN_HASH,
    value: JSON.stringify(record),
  });
}

/**
 * 清除本機密碼鎖設定。
 */
export async function clearPinRecord(database: ExpenseDatabase = db): Promise<void> {
  await database.meta.delete(META_KEYS.UI_PIN_HASH);
}

/**
 * 讀取「預設隱藏金額」設定（預設為 false）。
 */
export async function getHideAmountsDefault(database: ExpenseDatabase = db): Promise<boolean> {
  const entry = await database.meta.get(META_KEYS.UI_HIDE_AMOUNTS_DEFAULT);
  return entry?.value === 'true';
}

/**
 * 儲存「預設隱藏金額」設定至本機 meta（不同步、不進 JSON 備份）。
 */
export async function setHideAmountsDefault(
  enabled: boolean,
  database: ExpenseDatabase = db,
): Promise<void> {
  await database.meta.put({
    key: META_KEYS.UI_HIDE_AMOUNTS_DEFAULT,
    value: enabled ? 'true' : 'false',
  });
}

export interface SaveMemberCardInput {
  id?: string;
  name: string;
  code: string;
  format?: BarcodeFormat | 'auto';
  color?: string;
  sortOrder?: number;
}

/**
 * 排序卡片清單：載具優先，其餘依 sortOrder 升冪、updatedAt 降冪。
 */
export function sortWalletCards(cards: readonly WalletCard[]): WalletCard[] {
  return [...cards]
    .filter((c) => !c.deleted)
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'carrier' ? -1 : 1;
      }
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      return b.updatedAt - a.updatedAt;
    });
}

/**
 * 讀取所有未刪除的載具與會員卡。
 */
export async function getCards(database: ExpenseDatabase = db): Promise<WalletCard[]> {
  const rows = await database.cards.toArray();
  return sortWalletCards(rows);
}

/**
 * 儲存或更新電子發票手機條碼載具（固定 id `card-carrier`，同步不重複）。
 */
export async function saveCarrierCard(
  rawCode: string,
  database: ExpenseDatabase = db,
): Promise<WalletCard> {
  const normalized = normalizeCarrier(rawCode);
  if (!isValidCarrier(normalized)) {
    throw new Error('手機條碼是 / 加 7 個英數字，例如 /ABC1234');
  }

  const now = Date.now();
  const deviceId = getDeviceId();
  let saved!: WalletCard;

  await database.transaction('rw', database.cards, database.outbox, async () => {
    const existing = await database.cards.get(CARRIER_CARD_ID);
    saved = {
      id: CARRIER_CARD_ID,
      type: 'carrier',
      name: CARRIER_CARD_NAME,
      code: normalized,
      format: 'code39',
      color: existing?.color ?? '#0f766e',
      sortOrder: 0,
      lastUsedAt: existing?.lastUsedAt ?? 0,
      updatedAt: now,
      deviceId,
      deleted: false,
    };
    await database.cards.put(saved);
    await database.outbox.put(createOutboxEntry('cards', saved.id, now));
  });

  notifyLocalMutation(database);
  return saved;
}

/**
 * 新增或更新會員卡。
 */
export async function saveMemberCard(
  input: SaveMemberCardInput,
  database: ExpenseDatabase = db,
): Promise<WalletCard> {
  const name = input.name.trim();
  if (!name) {
    throw new Error('請輸入會員卡名稱');
  }
  if (name.length > MEMBER_CARD_NAME_MAX_LENGTH) {
    throw new Error(`會員卡名稱最多 ${MEMBER_CARD_NAME_MAX_LENGTH} 字`);
  }

  const code = input.code.trim();
  if (!code) {
    throw new Error('請輸入條碼內容');
  }

  const format: BarcodeFormat =
    !input.format || input.format === 'auto' ? guessFormat(code) : input.format;

  const now = Date.now();
  const deviceId = getDeviceId();
  let saved!: WalletCard;

  await database.transaction('rw', database.cards, database.outbox, async () => {
    const existing = input.id ? await database.cards.get(input.id) : undefined;
    let sortOrder = input.sortOrder ?? existing?.sortOrder;
    if (sortOrder === undefined) {
      const all = await database.cards.toArray();
      const maxOrder = all
        .filter((c) => !c.deleted && c.type === 'member')
        .reduce((max, c) => Math.max(max, c.sortOrder), 0);
      sortOrder = maxOrder + 1;
    }

    saved = {
      id: existing?.id ?? input.id ?? uuidv7(),
      type: 'member',
      name,
      code,
      format,
      color: input.color?.trim() || existing?.color || pickCardColor(name),
      sortOrder,
      lastUsedAt: existing?.lastUsedAt ?? 0,
      updatedAt: now,
      deviceId,
      deleted: false,
    };
    await database.cards.put(saved);
    await database.outbox.put(createOutboxEntry('cards', saved.id, now));
  });

  notifyLocalMutation(database);
  return saved;
}

/**
 * 軟刪除載具或會員卡並排入 outbox 同步。
 */
export async function deleteCard(
  id: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let changed = false;

  await database.transaction('rw', database.cards, database.outbox, async () => {
    const existing = await database.cards.get(id);
    if (!existing || existing.deleted) {
      return;
    }
    await database.cards.put({
      ...existing,
      deleted: true,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('cards', id, now));
    changed = true;
  });

  if (changed) {
    notifyLocalMutation(database);
  }
}

/**
 * 更新卡片最後出示時間（lastUsedAt）。
 */
export async function touchCardUsed(
  id: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let changed = false;

  await database.transaction('rw', database.cards, database.outbox, async () => {
    const existing = await database.cards.get(id);
    if (!existing || existing.deleted) {
      return;
    }
    await database.cards.put({
      ...existing,
      lastUsedAt: now,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('cards', id, now));
    changed = true;
  });

  if (changed) {
    notifyLocalMutation(database);
  }
}

/**
 * 重新排序會員卡並排入 outbox 同步。
 */
export async function reorderCards(
  orderedIds: readonly string[],
  database: ExpenseDatabase = db,
): Promise<void> {
  if (orderedIds.length === 0) return;
  const now = Date.now();
  const deviceId = getDeviceId();
  let changed = false;

  await database.transaction('rw', database.cards, database.outbox, async () => {
    const rows = await database.cards.bulkGet([...orderedIds]);
    const updates: WalletCard[] = [];
    const outboxUpdates: OutboxEntry[] = [];

    for (let i = 0; i < orderedIds.length; i += 1) {
      const card = rows[i];
      if (!card || card.deleted || card.type === 'carrier') continue;
      const nextOrder = i + 1;
      if (card.sortOrder !== nextOrder) {
        updates.push({
          ...card,
          sortOrder: nextOrder,
          updatedAt: now,
          deviceId,
        });
        outboxUpdates.push(createOutboxEntry('cards', card.id, now));
      }
    }

    if (updates.length > 0) {
      await database.cards.bulkPut(updates);
      await database.outbox.bulkPut(outboxUpdates);
      changed = true;
    }
  });

  if (changed) {
    notifyLocalMutation(database);
  }
}

export interface SaveCurrencyInput {
  code: string;
  name?: string;
  rate: number;
  decimals?: number;
  archived?: boolean;
  sortOrder?: number;
}

/**
 * 讀取所有未刪除的幣別設定（依 sortOrder 排序）。
 */
export async function getCurrencies(database: ExpenseDatabase = db): Promise<CurrencyRate[]> {
  const rows = await database.currencies.orderBy('sortOrder').toArray();
  return rows.filter((c) => !c.deleted);
}

/**
 * 新增或更新幣別（固定 id = 大寫 3 碼代碼，寫入 outbox；主幣別匯率固定為 1）。
 * 注意：修改最新匯率不會重算任何既有交易。
 */
export async function saveCurrency(
  input: SaveCurrencyInput,
  database: ExpenseDatabase = db,
): Promise<CurrencyRate> {
  const code = input.code.trim().toUpperCase();
  if (!isValidCurrencyCode(code)) {
    throw new Error('幣別代碼需為 3 個大寫英文字母（例如 JPY）');
  }

  const rawName = (input.name ?? getDefaultCurrencyName(code)).trim();
  if (!rawName) {
    throw new Error('請輸入幣別名稱');
  }
  const name = rawName.slice(0, CURRENCY_NAME_MAX_LENGTH);

  const decimals =
    input.decimals === 0 || input.decimals === 2
      ? input.decimals
      : getDefaultCurrencyDecimals(code);

  const now = Date.now();
  const deviceId = getDeviceId();
  let saved!: CurrencyRate;

  await database.transaction('rw', database.currencies, database.outbox, async () => {
    const allRows = await database.currencies.toArray();
    const existing = allRows.find((c) => c.id === code || c.code === code);
    const currentMain = getMainCurrency(allRows);
    const isMain = existing?.isMain ?? (allRows.some((c) => !c.deleted && c.isMain) ? false : code === currentMain.code && false);

    const effectiveRate = isMain ? 1 : input.rate;
    if (!isMain && !isValidRate(effectiveRate)) {
      throw new Error('匯率需為大於 0 的數字');
    }

    let sortOrder = input.sortOrder ?? existing?.sortOrder;
    if (sortOrder === undefined) {
      const maxOrder = allRows
        .filter((c) => !c.deleted)
        .reduce((max, item) => Math.max(max, item.sortOrder), 0);
      sortOrder = maxOrder + 1;
    }

    saved = {
      id: code,
      code,
      name,
      rate: effectiveRate,
      decimals,
      isMain,
      sortOrder,
      archived: isMain ? false : (input.archived ?? (existing?.deleted ? false : existing?.archived) ?? false),
      updatedAt: now,
      deviceId,
      deleted: false,
    };

    await database.currencies.put(saved);
    await database.outbox.put(createOutboxEntry('currencies', saved.id, now));
  });

  notifyLocalMutation(database);
  return saved;
}

/**
 * 封存或啟用外幣（主幣別不可封存）。
 */
export async function archiveCurrency(
  code: string,
  archived: boolean,
  database: ExpenseDatabase = db,
): Promise<void> {
  const normalizedCode = code.trim().toUpperCase();
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.currencies, database.outbox, async () => {
    const existing = await database.currencies.get(normalizedCode);
    if (!existing || existing.deleted) {
      return;
    }
    if (existing.isMain && archived) {
      throw new Error('無法封存目前主幣別');
    }
    await database.currencies.put({
      ...existing,
      archived,
      updatedAt: now,
      deviceId,
    });
    await database.outbox.put(createOutboxEntry('currencies', existing.id, now));
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 軟刪除幣別（主幣別或已有交易紀錄使用者不可刪除）。
 */
export async function softDeleteCurrency(
  code: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const normalizedCode = code.trim().toUpperCase();
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction(
    'rw',
    database.currencies,
    database.transactions,
    database.outbox,
    async () => {
      const existing = await database.currencies.get(normalizedCode);
      if (!existing || existing.deleted) {
        return;
      }
      if (existing.isMain) {
        throw new Error('無法刪除目前主幣別');
      }
      const usedTxCount = await database.transactions
        .filter((tx) => !tx.deleted && tx.currency === normalizedCode)
        .count();
      if (usedTxCount > 0) {
        throw new Error('此幣別已有交易紀錄使用，僅可封存');
      }
      await database.currencies.put({
        ...existing,
        deleted: true,
        updatedAt: now,
        deviceId,
      });
      await database.outbox.put(createOutboxEntry('currencies', existing.id, now));
      updated = true;
    },
  );

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 交換兩個幣別的排序順序。
 */
export async function swapCurrencySortOrder(
  idA: string,
  idB: string,
  database: ExpenseDatabase = db,
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let updated = false;

  await database.transaction('rw', database.currencies, database.outbox, async () => {
    const [a, b] = await Promise.all([database.currencies.get(idA), database.currencies.get(idB)]);
    if (!a || !b) {
      return;
    }
    const orderA = a.sortOrder === b.sortOrder ? a.sortOrder : b.sortOrder;
    const orderB = a.sortOrder === b.sortOrder ? b.sortOrder + 1 : a.sortOrder;

    await database.currencies.bulkPut([
      { ...a, sortOrder: orderA, updatedAt: now, deviceId },
      { ...b, sortOrder: orderB, updatedAt: now, deviceId },
    ]);
    await database.outbox.bulkPut([
      createOutboxEntry('currencies', a.id, now),
      createOutboxEntry('currencies', b.id, now),
    ]);
    updated = true;
  });

  if (updated) {
    notifyLocalMutation(database);
  }
}

/**
 * 在單一資料庫交易中切換主幣別，換算所有交易、帳戶初始餘額、預算、週期規則、捷徑與幣別匯率並全部排入 outbox。
 */
export async function switchMainCurrency(
  input: {
    newCode: string;
    newName?: string;
    newDecimals?: number;
    rate: number;
  },
  database: ExpenseDatabase = db,
): Promise<{ convertedTransactions: number }> {
  const now = Date.now();
  const deviceId = getDeviceId();
  let convertedTransactions = 0;

  await database.transaction(
    'rw',
    [
      database.transactions,
      database.accounts,
      database.budgets,
      database.recurringRules,
      database.shortcuts,
      database.currencies,
      database.outbox,
    ],
    async () => {
      const [transactions, accounts, budgets, recurringRules, shortcuts, currencies] =
        await Promise.all([
          database.transactions.toArray(),
          database.accounts.toArray(),
          database.budgets.toArray(),
          database.recurringRules.toArray(),
          database.shortcuts.toArray(),
          database.currencies.toArray(),
        ]);

      const plan = planMainCurrencySwitch({
        newCode: input.newCode,
        newName: input.newName,
        newDecimals: input.newDecimals,
        rate: input.rate,
        transactions,
        accounts,
        budgets,
        recurringRules,
        shortcuts,
        currencies,
        now,
        deviceId,
      });

      convertedTransactions = plan.convertedActiveTransactionCount;

      const outboxEntries: OutboxEntry[] = [
        ...plan.transactions.map((item) => createOutboxEntry('transactions', item.id, now)),
        ...plan.accounts.map((item) => createOutboxEntry('accounts', item.id, now)),
        ...plan.budgets.map((item) => createOutboxEntry('budgets', item.id, now)),
        ...plan.recurringRules.map((item) => createOutboxEntry('recurringRules', item.id, now)),
        ...plan.shortcuts.map((item) => createOutboxEntry('shortcuts', item.id, now)),
        ...plan.currencies.map((item) => createOutboxEntry('currencies', item.id, now)),
      ];

      await Promise.all([
        plan.transactions.length > 0
          ? database.transactions.bulkPut(plan.transactions)
          : Promise.resolve(),
        plan.accounts.length > 0 ? database.accounts.bulkPut(plan.accounts) : Promise.resolve(),
        plan.budgets.length > 0 ? database.budgets.bulkPut(plan.budgets) : Promise.resolve(),
        plan.recurringRules.length > 0
          ? database.recurringRules.bulkPut(plan.recurringRules)
          : Promise.resolve(),
        plan.shortcuts.length > 0 ? database.shortcuts.bulkPut(plan.shortcuts) : Promise.resolve(),
        plan.currencies.length > 0
          ? database.currencies.bulkPut(plan.currencies)
          : Promise.resolve(),
        outboxEntries.length > 0 ? database.outbox.bulkPut(outboxEntries) : Promise.resolve(),
      ]);
    },
  );

  notifyLocalMutation(database);
  return { convertedTransactions };
}
