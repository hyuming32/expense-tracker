import Dexie, { type EntityTable, type Table } from 'dexie';
import { getDeviceId } from './deviceId';
import type { Account, Category, MetaEntry, Transaction } from './types';
import { uuidv7 } from './uuid';

export const META_KEYS = {
  DEVICE_ID: 'deviceId',
  LAST_ACCOUNT_ID: 'lastAccountId',
  LAST_EXPENSE_CATEGORY_ID: 'lastExpenseCategoryId',
  LAST_INCOME_CATEGORY_ID: 'lastIncomeCategoryId',
} as const;

export class ExpenseDatabase extends Dexie {
  accounts!: EntityTable<Account, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  transactions!: EntityTable<Transaction, 'id'>;
  meta!: Table<MetaEntry, string>;

  constructor(name = 'expense-tracker-db') {
    super(name);
    this.version(1).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions: 'id, kind, date, accountId, toAccountId, categoryId, updatedAt, deleted',
      meta: 'key',
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

      const now = Date.now();
      const defaultAccounts: Account[] = [
        {
          id: uuidv7(),
          name: '現金',
          type: 'cash',
          initialBalance: 0,
          archived: false,
          sortOrder: 1,
          updatedAt: now,
          deviceId,
          deleted: false,
        },
        {
          id: uuidv7(),
          name: '銀行帳戶',
          type: 'bank',
          initialBalance: 0,
          archived: false,
          sortOrder: 2,
          updatedAt: now,
          deviceId,
          deleted: false,
        },
        {
          id: uuidv7(),
          name: '信用卡',
          type: 'credit',
          initialBalance: 0,
          archived: false,
          sortOrder: 3,
          updatedAt: now,
          deviceId,
          deleted: false,
        },
      ];

      await database.accounts.bulkAdd(defaultAccounts);

      const foodId = uuidv7();
      const expenseParents: Array<{ id?: string; name: string; icon: string }> = [
        { id: foodId, name: '飲食', icon: '🍽️' },
        { name: '交通', icon: '🚇' },
        { name: '日用品', icon: '🧻' },
        { name: '居住', icon: '🏠' },
        { name: '娛樂', icon: '🎮' },
        { name: '醫療', icon: '🏥' },
        { name: '服飾', icon: '👕' },
        { name: '教育', icon: '📚' },
        { name: '其他', icon: '📦' },
      ];

      const foodChildren: Array<{ name: string; icon: string }> = [
        { name: '早餐', icon: '🥐' },
        { name: '午餐', icon: '🍱' },
        { name: '晚餐', icon: '🍜' },
        { name: '點心', icon: '🧁' },
      ];

      const incomeCategories: Array<{ name: string; icon: string }> = [
        { name: '薪資', icon: '💰' },
        { name: '獎金', icon: '🧧' },
        { name: '投資', icon: '📈' },
        { name: '其他', icon: '🪙' },
      ];

      const categories: Category[] = [
        ...expenseParents.map((item, idx) => ({
          id: item.id ?? uuidv7(),
          name: item.name,
          icon: item.icon,
          kind: 'expense' as const,
          parentId: null,
          sortOrder: idx + 1,
          archived: false,
          updatedAt: now,
          deviceId,
          deleted: false,
        })),
        ...foodChildren.map((item, idx) => ({
          id: uuidv7(),
          name: item.name,
          icon: item.icon,
          kind: 'expense' as const,
          parentId: foodId,
          sortOrder: idx + 1,
          archived: false,
          updatedAt: now,
          deviceId,
          deleted: false,
        })),
        ...incomeCategories.map((item, idx) => ({
          id: uuidv7(),
          name: item.name,
          icon: item.icon,
          kind: 'income' as const,
          parentId: null,
          sortOrder: idx + 1,
          archived: false,
          updatedAt: now,
          deviceId,
          deleted: false,
        })),
      ];

      await database.categories.bulkAdd(categories);
    },
  );

  seedPromises.set(database, promise);
  return promise;
}
