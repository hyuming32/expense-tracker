import Dexie, { type EntityTable, type Table } from 'dexie';
import { getDeviceId } from './deviceId';
import type {
  Account,
  Category,
  LotteryDraw,
  MetaEntry,
  NotePreset,
  OutboxEntry,
  Place,
  RecurringRule,
  Shortcut,
  Transaction,
} from './types';

export const META_KEYS = {
  DEVICE_ID: 'deviceId',
  LAST_ACCOUNT_ID: 'lastAccountId',
  LAST_EXPENSE_CATEGORY_ID: 'lastExpenseCategoryId',
  LAST_INCOME_CATEGORY_ID: 'lastIncomeCategoryId',
  LAST_PLACE_ID: 'lastPlaceId',
  AUTO_SELECT_LAST_PLACE: 'autoSelectLastPlace',
  COLOR_EXPENSE: 'color.expense',
  COLOR_INCOME: 'color.income',
  REPORT_PERIOD_KIND: 'reportPeriodKind',
  AUTO_ADD_NOTE_PRESETS: 'autoAddNotePresets',
  RECURRING_LAST_CHECKED_DATE: 'recurringLastCheckedDate',
  SYNC_LOCAL_SEQ: 'localSeq',
  SYNC_LAST_SYNC_AT: 'lastSyncAt',
  SYNC_SEEN_PREFIX: 'seen.',
  SYNC_SCHEDULE: 'sync.schedule',
  DRIVE_BACKUP_FOLDER_ID: 'driveBackup.folderId',
  DRIVE_BACKUP_LAST_AT: 'driveBackup.lastAt',
} as const;

export const SEED_DEVICE_ID = 'seed';

export const DEFAULT_SEED_ACCOUNTS: ReadonlyArray<{
  id: string;
  name: string;
  type: Account['type'];
  sortOrder: number;
}> = [
  { id: 'seed-acc-cash', name: '現金', type: 'cash', sortOrder: 1 },
  { id: 'seed-acc-bank', name: '銀行帳戶', type: 'bank', sortOrder: 2 },
  { id: 'seed-acc-credit', name: '信用卡', type: 'credit', sortOrder: 3 },
];

export const DEFAULT_SEED_CATEGORIES: ReadonlyArray<{
  id: string;
  name: string;
  icon: string;
  kind: Category['kind'];
  parentId: string | null;
  sortOrder: number;
}> = [
  { id: 'seed-cat-food', name: '飲食', icon: '🍽️', kind: 'expense', parentId: null, sortOrder: 1 },
  { id: 'seed-cat-transport', name: '交通', icon: '🚇', kind: 'expense', parentId: null, sortOrder: 2 },
  { id: 'seed-cat-daily', name: '日用品', icon: '🧻', kind: 'expense', parentId: null, sortOrder: 3 },
  { id: 'seed-cat-housing', name: '居住', icon: '🏠', kind: 'expense', parentId: null, sortOrder: 4 },
  { id: 'seed-cat-entertainment', name: '娛樂', icon: '🎮', kind: 'expense', parentId: null, sortOrder: 5 },
  { id: 'seed-cat-medical', name: '醫療', icon: '🏥', kind: 'expense', parentId: null, sortOrder: 6 },
  { id: 'seed-cat-clothing', name: '服飾', icon: '👕', kind: 'expense', parentId: null, sortOrder: 7 },
  { id: 'seed-cat-education', name: '教育', icon: '📚', kind: 'expense', parentId: null, sortOrder: 8 },
  { id: 'seed-cat-expense-other', name: '其他', icon: '📦', kind: 'expense', parentId: null, sortOrder: 9 },
  { id: 'seed-cat-food-breakfast', name: '早餐', icon: '🥐', kind: 'expense', parentId: 'seed-cat-food', sortOrder: 1 },
  { id: 'seed-cat-food-lunch', name: '午餐', icon: '🍱', kind: 'expense', parentId: 'seed-cat-food', sortOrder: 2 },
  { id: 'seed-cat-food-dinner', name: '晚餐', icon: '🍜', kind: 'expense', parentId: 'seed-cat-food', sortOrder: 3 },
  { id: 'seed-cat-food-snack', name: '點心', icon: '🧁', kind: 'expense', parentId: 'seed-cat-food', sortOrder: 4 },
  { id: 'seed-cat-income-salary', name: '薪資', icon: '💰', kind: 'income', parentId: null, sortOrder: 1 },
  { id: 'seed-cat-income-bonus', name: '獎金', icon: '🧧', kind: 'income', parentId: null, sortOrder: 2 },
  { id: 'seed-cat-income-investment', name: '投資', icon: '📈', kind: 'income', parentId: null, sortOrder: 3 },
  { id: 'seed-cat-income-other', name: '其他', icon: '🪙', kind: 'income', parentId: null, sortOrder: 4 },
];

export class ExpenseDatabase extends Dexie {
  accounts!: EntityTable<Account, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  transactions!: EntityTable<Transaction, 'id'>;
  notePresets!: EntityTable<NotePreset, 'id'>;
  recurringRules!: EntityTable<RecurringRule, 'id'>;
  shortcuts!: EntityTable<Shortcut, 'id'>;
  places!: EntityTable<Place, 'id'>;
  lotteryDraws!: EntityTable<LotteryDraw, 'id'>;
  meta!: Table<MetaEntry, string>;
  outbox!: Table<OutboxEntry, string>;

  constructor(name = 'expense-tracker-db') {
    super(name);
    this.version(1).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions: 'id, kind, date, accountId, toAccountId, categoryId, updatedAt, deleted',
      meta: 'key',
    });
    this.version(2).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions: 'id, kind, date, accountId, toAccountId, categoryId, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });
    this.version(3)
      .stores({
        accounts: 'id, updatedAt, deleted, sortOrder',
        categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
        transactions: 'id, kind, date, accountId, toAccountId, categoryId, updatedAt, deleted',
        meta: 'key',
        outbox: 'key, table, recordId, updatedAt',
      })
      .upgrade(async (tx) => {
        const accountsTable = tx.table<Account, string>('accounts');
        const categoriesTable = tx.table<Category, string>('categories');
        const transactionsTable = tx.table<Transaction, string>('transactions');
        const metaTable = tx.table<MetaEntry, string>('meta');

        const [accounts, categories, transactions] = await Promise.all([
          accountsTable.toArray(),
          categoriesTable.toArray(),
          transactionsTable.toArray(),
        ]);

        const idMap = new Map<string, string>();
        const existingAccountIds = new Set(accounts.map((a) => a.id));
        const existingCategoryIds = new Set(categories.map((c) => c.id));

        // 1. 比對並轉換舊的隨機 id 預設帳戶
        const accountsToDelete: string[] = [];
        const accountsToPut: Account[] = [];
        for (const seedAcc of DEFAULT_SEED_ACCOUNTS) {
          if (existingAccountIds.has(seedAcc.id)) {
            continue;
          }
          const match = accounts.find(
            (a) =>
              !a.deleted &&
              !idMap.has(a.id) &&
              a.name === seedAcc.name &&
              a.type === seedAcc.type,
          );
          if (match) {
            idMap.set(match.id, seedAcc.id);
            accountsToDelete.push(match.id);
            accountsToPut.push({
              ...match,
              id: seedAcc.id,
              updatedAt: 0,
              deviceId: SEED_DEVICE_ID,
            });
            existingAccountIds.add(seedAcc.id);
          }
        }

        // 2. 比對並轉換舊的隨機 id 預設分類（先第一層，再子分類）
        const categoriesToDelete: string[] = [];
        const categoriesToPut: Category[] = [];

        for (const seedCat of DEFAULT_SEED_CATEGORIES) {
          if (seedCat.parentId !== null || existingCategoryIds.has(seedCat.id)) {
            continue;
          }
          const match = categories.find(
            (c) =>
              !c.deleted &&
              !idMap.has(c.id) &&
              c.parentId === null &&
              c.name === seedCat.name &&
              c.kind === seedCat.kind,
          );
          if (match) {
            idMap.set(match.id, seedCat.id);
            categoriesToDelete.push(match.id);
            categoriesToPut.push({
              ...match,
              id: seedCat.id,
              updatedAt: 0,
              deviceId: SEED_DEVICE_ID,
            });
            existingCategoryIds.add(seedCat.id);
          }
        }

        for (const seedCat of DEFAULT_SEED_CATEGORIES) {
          if (seedCat.parentId === null || existingCategoryIds.has(seedCat.id)) {
            continue;
          }
          const match = categories.find((c) => {
            if (c.deleted || idMap.has(c.id) || c.parentId === null) {
              return false;
            }
            const resolvedParentId = idMap.get(c.parentId) ?? c.parentId;
            return (
              resolvedParentId === seedCat.parentId &&
              c.name === seedCat.name &&
              c.kind === seedCat.kind
            );
          });
          if (match) {
            idMap.set(match.id, seedCat.id);
            categoriesToDelete.push(match.id);
            categoriesToPut.push({
              ...match,
              id: seedCat.id,
              parentId: seedCat.parentId,
              updatedAt: 0,
              deviceId: SEED_DEVICE_ID,
            });
            existingCategoryIds.add(seedCat.id);
          }
        }

        if (idMap.size === 0) {
          return;
        }

        // 3. 更新自訂子分類中仍指向舊父分類 id 的 parentId
        const deletedCategorySet = new Set(categoriesToDelete);
        for (const cat of categories) {
          if (deletedCategorySet.has(cat.id) || !cat.parentId) {
            continue;
          }
          const newParentId = idMap.get(cat.parentId);
          if (newParentId) {
            categoriesToPut.push({ ...cat, parentId: newParentId });
          }
        }

        // 4. 更新交易紀錄中的 accountId、toAccountId、categoryId
        const transactionsToPut: Transaction[] = [];
        for (const item of transactions) {
          const nextAccountId = idMap.get(item.accountId) ?? item.accountId;
          const nextToAccountId = item.toAccountId
            ? (idMap.get(item.toAccountId) ?? item.toAccountId)
            : null;
          const nextCategoryId = item.categoryId
            ? (idMap.get(item.categoryId) ?? item.categoryId)
            : null;
          if (
            nextAccountId !== item.accountId ||
            nextToAccountId !== item.toAccountId ||
            nextCategoryId !== item.categoryId
          ) {
            transactionsToPut.push({
              ...item,
              accountId: nextAccountId,
              toAccountId: nextToAccountId,
              categoryId: nextCategoryId,
            });
          }
        }

        // 5. 更新 meta 內記住的最近使用帳戶／分類 id
        const metaKeysToCheck = [
          META_KEYS.LAST_ACCOUNT_ID,
          META_KEYS.LAST_EXPENSE_CATEGORY_ID,
          META_KEYS.LAST_INCOME_CATEGORY_ID,
        ];
        const metaToPut: MetaEntry[] = [];
        for (const key of metaKeysToCheck) {
          const entry = await metaTable.get(key);
          if (entry) {
            const mapped = idMap.get(entry.value);
            if (mapped) {
              metaToPut.push({ key, value: mapped });
            }
          }
        }

        await Promise.all([
          accountsToDelete.length > 0 ? accountsTable.bulkDelete(accountsToDelete) : Promise.resolve(),
          accountsToPut.length > 0 ? accountsTable.bulkPut(accountsToPut) : Promise.resolve(),
          categoriesToDelete.length > 0
            ? categoriesTable.bulkDelete(categoriesToDelete)
            : Promise.resolve(),
          categoriesToPut.length > 0 ? categoriesTable.bulkPut(categoriesToPut) : Promise.resolve(),
          transactionsToPut.length > 0
            ? transactionsTable.bulkPut(transactionsToPut)
            : Promise.resolve(),
          metaToPut.length > 0 ? metaTable.bulkPut(metaToPut) : Promise.resolve(),
        ]);
      });
    this.version(4).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions: 'id, kind, date, accountId, toAccountId, categoryId, invoiceNo, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });
    this.version(5).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions: 'id, kind, date, accountId, toAccountId, categoryId, invoiceNo, updatedAt, deleted',
      notePresets: 'id, categoryId, useCount, lastUsedAt, sortOrder, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });
    this.version(6).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions:
        'id, kind, date, accountId, toAccountId, categoryId, invoiceNo, recurringId, occurrenceDate, updatedAt, deleted',
      notePresets: 'id, categoryId, useCount, lastUsedAt, sortOrder, updatedAt, deleted',
      recurringRules: 'id, frequency, paused, startDate, endDate, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });
    this.version(7).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions:
        'id, kind, date, accountId, toAccountId, categoryId, invoiceNo, recurringId, occurrenceDate, updatedAt, deleted',
      notePresets: 'id, categoryId, useCount, lastUsedAt, sortOrder, updatedAt, deleted',
      recurringRules: 'id, frequency, paused, startDate, endDate, updatedAt, deleted',
      shortcuts: 'id, sortOrder, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });
    this.version(8).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions:
        'id, kind, date, accountId, toAccountId, categoryId, placeId, invoiceNo, recurringId, occurrenceDate, updatedAt, deleted',
      notePresets: 'id, categoryId, useCount, lastUsedAt, sortOrder, updatedAt, deleted',
      recurringRules: 'id, frequency, paused, startDate, endDate, updatedAt, deleted',
      shortcuts: 'id, sortOrder, updatedAt, deleted',
      places: 'id, useCount, lastUsedAt, sortOrder, archived, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });
    this.version(9).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions:
        'id, kind, date, accountId, toAccountId, categoryId, placeId, invoiceNo, recurringId, occurrenceDate, updatedAt, deleted',
      notePresets: 'id, categoryId, useCount, lastUsedAt, sortOrder, updatedAt, deleted',
      recurringRules: 'id, frequency, paused, startDate, endDate, updatedAt, deleted',
      shortcuts: 'id, sortOrder, updatedAt, deleted',
      places: 'id, useCount, lastUsedAt, sortOrder, archived, updatedAt, deleted',
      lotteryDraws: 'id, period, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });
  }
}

export const db = new ExpenseDatabase();

const seedPromises = new WeakMap<ExpenseDatabase, Promise<void>>();

/**
 * 首次啟動時建立預設帳戶、分類與裝置識別碼（防止重複初始化）。
 */
export function ensureSeeded(database: ExpenseDatabase = db): Promise<void> {
  const existing = seedPromises.get(database);
  if (existing) {
    return existing;
  }

  const promise = database.transaction(
    'rw',
    database.accounts,
    database.categories,
    database.meta,
    async () => {
      const deviceId = getDeviceId();
      const existingDeviceMeta = await database.meta.get(META_KEYS.DEVICE_ID);
      if (!existingDeviceMeta) {
        await database.meta.put({ key: META_KEYS.DEVICE_ID, value: deviceId });
      }

      const accountCount = await database.accounts.count();
      const categoryCount = await database.categories.count();
      if (accountCount > 0 || categoryCount > 0) {
        return;
      }

      const defaultAccounts: Account[] = DEFAULT_SEED_ACCOUNTS.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        initialBalance: 0,
        archived: false,
        sortOrder: item.sortOrder,
        updatedAt: 0,
        deviceId: SEED_DEVICE_ID,
        deleted: false,
      }));

      await database.accounts.bulkAdd(defaultAccounts);

      const categories: Category[] = DEFAULT_SEED_CATEGORIES.map((item) => ({
        id: item.id,
        name: item.name,
        icon: item.icon,
        kind: item.kind,
        parentId: item.parentId,
        sortOrder: item.sortOrder,
        archived: false,
        updatedAt: 0,
        deviceId: SEED_DEVICE_ID,
        deleted: false,
      }));

      await database.categories.bulkAdd(categories);
    },
  );

  seedPromises.set(database, promise);
  return promise;
}
