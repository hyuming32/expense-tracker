import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { ExpenseDatabase, META_KEYS, ensureSeeded } from './database';
import { exportBackupData, restoreBackupData } from './repository';

describe('ensureSeeded', () => {
  it('首次啟動時建立預設帳戶、分類與裝置識別碼，且重複呼叫不會重複寫入', async () => {
    const testDb = new ExpenseDatabase(`test-db-${Date.now()}`);
    await ensureSeeded(testDb);
    await ensureSeeded(testDb);

    const accounts = await testDb.accounts.orderBy('sortOrder').toArray();
    expect(accounts.map((a) => ({ name: a.name, type: a.type, initialBalance: a.initialBalance }))).toEqual([
      { name: '現金', type: 'cash', initialBalance: 0 },
      { name: '銀行帳戶', type: 'bank', initialBalance: 0 },
      { name: '信用卡', type: 'credit', initialBalance: 0 },
    ]);

    const categories = await testDb.categories.orderBy('sortOrder').toArray();
    const expenseParents = categories.filter((c) => c.kind === 'expense' && c.parentId === null);
    expect(expenseParents.map((c) => c.name)).toEqual([
      '飲食',
      '交通',
      '日用品',
      '居住',
      '娛樂',
      '醫療',
      '服飾',
      '教育',
      '其他',
    ]);

    const food = expenseParents.find((c) => c.name === '飲食');
    expect(food).toBeDefined();
    const foodChildren = categories.filter((c) => c.parentId === food?.id);
    expect(foodChildren.map((c) => c.name)).toEqual(['早餐', '午餐', '晚餐', '點心']);

    const incomeCategories = categories.filter((c) => c.kind === 'income');
    expect(incomeCategories.map((c) => c.name)).toEqual(['薪資', '獎金', '投資', '其他']);

    const deviceMeta = await testDb.meta.get(META_KEYS.DEVICE_ID);
    expect(deviceMeta?.value).toMatch(/^[0-9a-f-]{36}$/);

    await testDb.delete();
  });
});

describe('JSON 備份匯出與還原', () => {
  it('匯出包含 deleted 紀錄，還原時以 id 合併並保留雙方資料', async () => {
    const sourceDb = new ExpenseDatabase(`test-backup-src-${Date.now()}`);
    await ensureSeeded(sourceDb);

    await sourceDb.transactions.bulkAdd([
      {
        id: 'tx-active',
        kind: 'expense',
        date: '2026-11-20',
        amount: 250,
        accountId: (await sourceDb.accounts.toArray())[0]!.id,
        toAccountId: null,
        categoryId: (await sourceDb.categories.toArray())[0]!.id,
        note: '午餐',
        updatedAt: 2000,
        deviceId: 'dev-src',
        deleted: false,
      },
      {
        id: 'tx-deleted',
        kind: 'income',
        date: '2026-11-21',
        amount: 1000,
        accountId: (await sourceDb.accounts.toArray())[0]!.id,
        toAccountId: null,
        categoryId: (await sourceDb.categories.toArray())[0]!.id,
        note: '已刪除紀錄',
        updatedAt: 3000,
        deviceId: 'dev-src',
        deleted: true,
      },
    ]);

    const backup = await exportBackupData(sourceDb);
    expect(backup.schemaVersion).toBe(3);
    expect(backup.transactions).toHaveLength(2);
    expect(backup.transactions.some((t) => t.id === 'tx-deleted' && t.deleted)).toBe(true);

    const targetDb = new ExpenseDatabase(`test-backup-dst-${Date.now()}`);
    await targetDb.transactions.add({
      id: 'tx-local-only',
      kind: 'expense',
      date: '2026-11-22',
      amount: 99,
      accountId: 'acc-local',
      toAccountId: null,
      categoryId: 'cat-local',
      note: '目標端獨有',
      updatedAt: 1000,
      deviceId: 'dev-dst',
      deleted: false,
    });

    await restoreBackupData(backup, targetDb);

    const restoredAccounts = await targetDb.accounts.toArray();
    const restoredCategories = await targetDb.categories.toArray();
    const restoredTxs = await targetDb.transactions.toArray();

    expect(restoredAccounts).toHaveLength(backup.accounts.length);
    expect(restoredCategories).toHaveLength(backup.categories.length);
    expect(restoredTxs).toHaveLength(3);
    expect(restoredTxs.find((t) => t.id === 'tx-active')?.amount).toBe(250);
    expect(restoredTxs.find((t) => t.id === 'tx-deleted')?.deleted).toBe(true);
    expect(restoredTxs.find((t) => t.id === 'tx-local-only')?.note).toBe('目標端獨有');

    await sourceDb.delete();
    await targetDb.delete();
  });
});

describe('預設資料固定識別碼與 v3 遷移', () => {
  it('兩台裝置 A、B 各自首次啟動後，預設帳戶與分類 id 完全相同，且不寫入 outbox', async () => {
    const dbA = new ExpenseDatabase(`test-seed-a-${Date.now()}`);
    const dbB = new ExpenseDatabase(`test-seed-b-${Date.now()}`);

    await ensureSeeded(dbA);
    await ensureSeeded(dbB);

    const [aAccounts, bAccounts, aCats, bCats] = await Promise.all([
      dbA.accounts.orderBy('sortOrder').toArray(),
      dbB.accounts.orderBy('sortOrder').toArray(),
      dbA.categories.orderBy('id').toArray(),
      dbB.categories.orderBy('id').toArray(),
    ]);

    expect(aAccounts.map((a) => a.id)).toEqual(bAccounts.map((b) => b.id));
    expect(aCats.map((c) => c.id)).toEqual(bCats.map((c) => c.id));
    expect(aAccounts.every((a) => a.updatedAt === 0 && a.deviceId === 'seed')).toBe(true);
    expect(aCats.every((c) => c.updatedAt === 0 && c.deviceId === 'seed')).toBe(true);
    expect(await dbA.outbox.count()).toBe(0);
    expect(await dbB.outbox.count()).toBe(0);

    await dbA.delete();
    await dbB.delete();
  });

  it('舊版隨機 id 資料庫升級後，交易與 meta 仍指向正確的分類與帳戶，且不留下重複的預設資料', async () => {
    const dbName = `test-migrate-v2-to-v3-${Date.now()}`;
    const legacyDb = new Dexie(dbName);
    legacyDb.version(1).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions: 'id, kind, date, accountId, toAccountId, categoryId, updatedAt, deleted',
      meta: 'key',
    });
    legacyDb.version(2).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions: 'id, kind, date, accountId, toAccountId, categoryId, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });

    await legacyDb.table('accounts').bulkAdd([
      {
        id: 'old-cash-id',
        name: '現金',
        type: 'cash',
        initialBalance: 500,
        archived: false,
        sortOrder: 1,
        updatedAt: 1000,
        deviceId: 'old-dev',
        deleted: false,
      },
      {
        id: 'old-bank-id',
        name: '銀行帳戶',
        type: 'bank',
        initialBalance: 0,
        archived: false,
        sortOrder: 2,
        updatedAt: 1000,
        deviceId: 'old-dev',
        deleted: false,
      },
    ]);

    await legacyDb.table('categories').bulkAdd([
      {
        id: 'old-food-id',
        name: '飲食',
        icon: '🍽️',
        kind: 'expense',
        parentId: null,
        sortOrder: 1,
        archived: false,
        updatedAt: 1000,
        deviceId: 'old-dev',
        deleted: false,
      },
      {
        id: 'old-lunch-id',
        name: '午餐',
        icon: '🍱',
        kind: 'expense',
        parentId: 'old-food-id',
        sortOrder: 2,
        archived: false,
        updatedAt: 1000,
        deviceId: 'old-dev',
        deleted: false,
      },
      {
        id: 'old-salary-id',
        name: '薪資',
        icon: '💰',
        kind: 'income',
        parentId: null,
        sortOrder: 1,
        archived: false,
        updatedAt: 1000,
        deviceId: 'old-dev',
        deleted: false,
      },
    ]);

    await legacyDb.table('transactions').add({
      id: 'tx-legacy-1',
      kind: 'expense',
      date: '2026-11-20',
      amount: 120,
      accountId: 'old-cash-id',
      toAccountId: null,
      categoryId: 'old-lunch-id',
      note: '舊版午餐',
      updatedAt: 2000,
      deviceId: 'old-dev',
      deleted: false,
    });

    await legacyDb.table('meta').bulkPut([
      { key: META_KEYS.LAST_ACCOUNT_ID, value: 'old-cash-id' },
      { key: META_KEYS.LAST_EXPENSE_CATEGORY_ID, value: 'old-lunch-id' },
      { key: META_KEYS.LAST_INCOME_CATEGORY_ID, value: 'old-salary-id' },
    ]);

    legacyDb.close();

    const upgradedDb = new ExpenseDatabase(dbName);
    await ensureSeeded(upgradedDb);

    const accounts = await upgradedDb.accounts.toArray();
    const categories = await upgradedDb.categories.toArray();
    const tx = await upgradedDb.transactions.get('tx-legacy-1');

    expect(accounts).toHaveLength(2);
    expect(accounts.find((a) => a.id === 'old-cash-id')).toBeUndefined();
    expect(accounts.find((a) => a.id === 'seed-acc-cash')?.initialBalance).toBe(500);

    expect(categories).toHaveLength(3);
    expect(categories.find((c) => c.id === 'old-lunch-id')).toBeUndefined();
    expect(categories.find((c) => c.id === 'seed-cat-food-lunch')?.parentId).toBe('seed-cat-food');

    expect(tx?.accountId).toBe('seed-acc-cash');
    expect(tx?.categoryId).toBe('seed-cat-food-lunch');

    expect((await upgradedDb.meta.get(META_KEYS.LAST_ACCOUNT_ID))?.value).toBe('seed-acc-cash');
    expect((await upgradedDb.meta.get(META_KEYS.LAST_EXPENSE_CATEGORY_ID))?.value).toBe(
      'seed-cat-food-lunch',
    );
    expect((await upgradedDb.meta.get(META_KEYS.LAST_INCOME_CATEGORY_ID))?.value).toBe(
      'seed-cat-income-salary',
    );
    expect(await upgradedDb.outbox.count()).toBe(0);

    await upgradedDb.delete();
  });
});
