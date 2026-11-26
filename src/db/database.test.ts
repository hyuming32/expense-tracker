import 'fake-indexeddb/auto';
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
    expect(backup.schemaVersion).toBe(1);
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
