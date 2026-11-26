import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { planCsvImport } from '../domain/csvImport';
import { ExpenseDatabase, META_KEYS, ensureSeeded } from './database';
import {
  DEFAULT_AMOUNT_COLORS,
  DuplicateInvoiceError,
  DuplicateNotePresetError,
  exportBackupData,
  getAmountColors,
  getAutoAddNotePresets,
  importCsvPlan,
  resetAmountColors,
  restoreBackupData,
  saveAmountColors,
  saveNotePreset,
  saveTransaction,
  setAutoAddNotePresets,
  softDeleteNotePreset,
  softDeleteTransaction,
  swapNotePresetSortOrder,
} from './repository';

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
        invoiceNo: 'AB12345678',
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
    expect(backup.schemaVersion).toBe(5);
    expect(backup.transactions).toHaveLength(2);
    expect(backup.transactions.some((t) => t.id === 'tx-deleted' && t.deleted)).toBe(true);
    expect(backup.transactions.find((t) => t.id === 'tx-active')?.invoiceNo).toBe('AB12345678');

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
    expect(restoredTxs.find((t) => t.id === 'tx-active')?.invoiceNo).toBe('AB12345678');
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

describe('發票號碼重複檢查與 v4 升級', () => {
  it('相同 invoiceNo 不可重複儲存，已軟刪除的同號發票可再儲存', async () => {
    const testDb = new ExpenseDatabase(`test-invoice-dup-${Date.now()}`);
    await ensureSeeded(testDb);

    const first = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 150,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        note: '便當',
        invoiceNo: 'AB12345678',
      },
      testDb,
    );

    await expect(
      saveTransaction(
        {
          kind: 'expense',
          date: '2026-11-26',
          amount: 200,
          accountId: 'seed-acc-cash',
          toAccountId: null,
          categoryId: 'seed-cat-food-lunch',
          note: '重複發票',
          invoiceNo: 'ab12345678',
        },
        testDb,
      ),
    ).rejects.toThrow(DuplicateInvoiceError);

    await expect(
      saveTransaction(
        {
          kind: 'expense',
          date: '2026-11-26',
          amount: 200,
          accountId: 'seed-acc-cash',
          toAccountId: null,
          categoryId: 'seed-cat-food-lunch',
          note: '重複發票',
          invoiceNo: 'AB12345678',
        },
        testDb,
      ),
    ).rejects.toThrow('這張發票已經記過了（2026-11-26 150）');

    // 編輯同一筆交易本身應允許儲存
    const updatedSame = await saveTransaction(
      {
        id: first.id,
        kind: 'expense',
        date: '2026-11-26',
        amount: 160,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        note: '更新金額',
        invoiceNo: 'AB12345678',
      },
      testDb,
    );
    expect(updatedSame.amount).toBe(160);

    // 軟刪除後可再以相同發票號碼儲存新交易
    await softDeleteTransaction(first.id, testDb);
    const recreated = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 180,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        note: '重記發票',
        invoiceNo: 'AB12345678',
      },
      testDb,
    );
    expect(recreated.invoiceNo).toBe('AB12345678');

    await testDb.delete();
  });

  it('舊資料庫（v3）升級至 v4 後既有交易不受影響且可使用發票索引', async () => {
    const dbName = `test-migrate-v3-to-v4-${Date.now()}`;
    const v3Db = new Dexie(dbName);
    v3Db.version(3).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions: 'id, kind, date, accountId, toAccountId, categoryId, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });

    await v3Db.table('transactions').add({
      id: 'tx-v3-keep',
      kind: 'expense',
      date: '2026-11-15',
      amount: 320,
      accountId: 'seed-acc-cash',
      toAccountId: null,
      categoryId: 'seed-cat-food',
      note: '升級前既有交易',
      updatedAt: 1500,
      deviceId: 'dev-v3',
      deleted: false,
    });
    v3Db.close();

    const v4Db = new ExpenseDatabase(dbName);
    await ensureSeeded(v4Db);

    const existing = await v4Db.transactions.get('tx-v3-keep');
    expect(existing).toBeDefined();
    expect(existing?.amount).toBe(320);
    expect(existing?.note).toBe('升級前既有交易');
    expect(existing?.invoiceNo).toBeUndefined();

    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 95,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '升級後發票',
        invoiceNo: 'CD87654321',
      },
      v4Db,
    );

    const byInvoice = await v4Db.transactions.where('invoiceNo').equals('CD87654321').first();
    expect(byInvoice?.amount).toBe(95);

    await v4Db.delete();
  });
});

describe('本機金額顏色設定', () => {
  it('無值時回傳預設值，儲存後讀回正確且不寫入 outbox，恢復預設後回到預設值', async () => {
    const testDb = new ExpenseDatabase(`test-colors-${Date.now()}`);
    await ensureSeeded(testDb);

    // 1. 無值時回傳預設值
    const initial = await getAmountColors(testDb);
    expect(initial).toEqual(DEFAULT_AMOUNT_COLORS);
    expect(initial).toEqual({ expense: '#2563EB', income: '#8B5E3C' });

    // 2. 儲存後讀回正確，且不寫入 outbox
    const saved = await saveAmountColors({ expense: '#112233', income: '#aabbcc' }, testDb);
    expect(saved).toEqual({ expense: '#112233', income: '#aabbcc' });
    expect(await getAmountColors(testDb)).toEqual({ expense: '#112233', income: '#aabbcc' });
    expect((await testDb.meta.get(META_KEYS.COLOR_EXPENSE))?.value).toBe('#112233');
    expect((await testDb.meta.get(META_KEYS.COLOR_INCOME))?.value).toBe('#aabbcc');
    expect(await testDb.outbox.count()).toBe(0);

    // 3. 恢復預設後回到預設值，且不寫入 outbox
    const reset = await resetAmountColors(testDb);
    expect(reset).toEqual(DEFAULT_AMOUNT_COLORS);
    expect(await getAmountColors(testDb)).toEqual(DEFAULT_AMOUNT_COLORS);
    expect(await testDb.outbox.count()).toBe(0);

    await testDb.delete();
  });

  it('非法色碼會被拒絕，且不會覆寫原本設定', async () => {
    const testDb = new ExpenseDatabase(`test-colors-invalid-${Date.now()}`);
    await ensureSeeded(testDb);

    await saveAmountColors({ expense: '#334455', income: '#667788' }, testDb);

    const invalidInputs = ['', 'red', '#123', '123456', '#GGGGGG', '#1234567'];
    for (const bad of invalidInputs) {
      await expect(saveAmountColors({ expense: bad }, testDb)).rejects.toThrow();
      await expect(saveAmountColors({ income: bad }, testDb)).rejects.toThrow();
    }

    expect(await getAmountColors(testDb)).toEqual({ expense: '#334455', income: '#667788' });

    await testDb.delete();
  });
});

describe('常用備註與自動學習（v5）', () => {
  it('儲存支出或收入時自動新增常用備註並累加 useCount，關閉自動加入時不新增', async () => {
    const testDb = new ExpenseDatabase(`test-notepresets-auto-${Date.now()}`);
    await ensureSeeded(testDb);

    expect(await getAutoAddNotePresets(testDb)).toBe(true);

    // 1. 首次儲存支出交易，自動加入常用備註（useCount=1，去除空白且最長 40 字）
    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 100,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        note: '  巷口牛肉麵  ',
      },
      testDb,
    );

    let presets = await testDb.notePresets.toArray();
    expect(presets).toHaveLength(1);
    expect(presets[0]?.text).toBe('巷口牛肉麵');
    expect(presets[0]?.categoryId).toBe('seed-cat-food-lunch');
    expect(presets[0]?.useCount).toBe(1);
    const firstLastUsed = presets[0]!.lastUsedAt;

    // 2. 再次儲存相同分類與備註，useCount 累加且更新 lastUsedAt
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 110,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        note: '巷口牛肉麵',
      },
      testDb,
    );

    presets = await testDb.notePresets.toArray();
    expect(presets).toHaveLength(1);
    expect(presets[0]?.useCount).toBe(2);
    expect(presets[0]!.lastUsedAt).toBeGreaterThan(firstLastUsed);

    // 3. 轉帳與空白備註不會自動新增
    await saveTransaction(
      {
        kind: 'transfer',
        date: '2026-11-26',
        amount: 500,
        accountId: 'seed-acc-cash',
        toAccountId: 'seed-acc-bank',
        categoryId: null,
        note: '領錢',
      },
      testDb,
    );
    expect(await testDb.notePresets.count()).toBe(1);

    // 4. 關閉自動加入（只寫 meta，不寫 outbox）後，新備註不會自動加入
    const outboxBefore = await testDb.outbox.count();
    await setAutoAddNotePresets(false, testDb);
    expect(await getAutoAddNotePresets(testDb)).toBe(false);
    expect(await testDb.outbox.count()).toBe(outboxBefore);

    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 80,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        note: '不會自動加入的備註',
      },
      testDb,
    );

    expect(await testDb.notePresets.count()).toBe(1);

    await testDb.delete();
  });

  it('同一分類或全部分類下不可新增重複文字，軟刪除後可再新增且不再出現於有效清單', async () => {
    const testDb = new ExpenseDatabase(`test-notepresets-dup-${Date.now()}`);
    await ensureSeeded(testDb);

    const p1 = await saveNotePreset({ text: '  美式咖啡  ', categoryId: 'seed-cat-food' }, testDb);
    expect(p1.text).toBe('美式咖啡');

    // 同分類重複不可新增
    await expect(
      saveNotePreset({ text: '美式咖啡', categoryId: 'seed-cat-food' }, testDb),
    ).rejects.toThrow(DuplicateNotePresetError);

    // 全部分類下重複不可新增
    await saveNotePreset({ text: '公用備註', categoryId: null }, testDb);
    await expect(saveNotePreset({ text: '公用備註', categoryId: null }, testDb)).rejects.toThrow(
      DuplicateNotePresetError,
    );

    // 不同分類可同名
    const p2 = await saveNotePreset({ text: '美式咖啡', categoryId: 'seed-cat-food-snack' }, testDb);
    expect(p2.id).not.toBe(p1.id);

    // 軟刪除後不再出現於未刪除清單，且可再新增
    await softDeleteNotePreset(p1.id, testDb);
    const active = await testDb.notePresets.filter((p) => !p.deleted).toArray();
    expect(active.some((p) => p.id === p1.id)).toBe(false);

    const recreated = await saveNotePreset(
      { text: '美式咖啡', categoryId: 'seed-cat-food' },
      testDb,
    );
    expect(recreated.deleted).toBe(false);

    // 交換 sortOrder
    await swapNotePresetSortOrder(recreated.id, p2.id, testDb);
    const afterSwapA = await testDb.notePresets.get(recreated.id);
    const afterSwapB = await testDb.notePresets.get(p2.id);
    expect(afterSwapA!.sortOrder).toBeLessThan(afterSwapB!.sortOrder + 100);
    expect(afterSwapA!.sortOrder).not.toBe(afterSwapB!.sortOrder);

    await testDb.delete();
  });

  it('JSON 備份含 notePresets 且還原正確，舊資料庫（v4）升級至 v5 不影響既有資料', async () => {
    // 1. JSON 備份與還原
    const srcDb = new ExpenseDatabase(`test-notepreset-backup-src-${Date.now()}`);
    await ensureSeeded(srcDb);
    const savedPreset = await saveNotePreset(
      { text: '捷運通勤', categoryId: 'seed-cat-transport' },
      srcDb,
    );
    const deletedPreset = await saveNotePreset({ text: '已刪除備註', categoryId: null }, srcDb);
    await softDeleteNotePreset(deletedPreset.id, srcDb);

    const backup = await exportBackupData(srcDb);
    expect(backup.schemaVersion).toBe(5);
    expect(backup.notePresets).toHaveLength(2);

    const dstDb = new ExpenseDatabase(`test-notepreset-backup-dst-${Date.now()}`);
    await restoreBackupData(backup, dstDb);
    const restoredPresets = await dstDb.notePresets.toArray();
    expect(restoredPresets).toHaveLength(2);
    expect(restoredPresets.find((p) => p.id === savedPreset.id)?.text).toBe('捷運通勤');
    expect(restoredPresets.find((p) => p.id === deletedPreset.id)?.deleted).toBe(true);

    await srcDb.delete();
    await dstDb.delete();

    // 2. v4 -> v5 升級不影響既有資料
    const dbName = `test-migrate-v4-to-v5-${Date.now()}`;
    const v4Db = new Dexie(dbName);
    v4Db.version(4).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions: 'id, kind, date, accountId, toAccountId, categoryId, invoiceNo, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });
    await v4Db.table('transactions').add({
      id: 'tx-v4-keep',
      kind: 'expense',
      date: '2026-11-20',
      amount: 500,
      accountId: 'seed-acc-cash',
      toAccountId: null,
      categoryId: 'seed-cat-food',
      note: 'v4 交易',
      updatedAt: 2000,
      deviceId: 'dev-v4',
      deleted: false,
    });
    v4Db.close();

    const v5Db = new ExpenseDatabase(dbName);
    await ensureSeeded(v5Db);
    const existingTx = await v5Db.transactions.get('tx-v4-keep');
    expect(existingTx?.amount).toBe(500);
    expect(existingTx?.note).toBe('v4 交易');

    const newPreset = await saveNotePreset({ text: '升級後備註', categoryId: null }, v5Db);
    expect((await v5Db.notePresets.get(newPreset.id))?.text).toBe('升級後備註');

    await v5Db.delete();
  });
});

describe('CSV 匯入寫入資料庫與 outbox', () => {
  it('匯入會建立缺少的帳戶與分類，寫入交易並將所有新增紀錄加入 outbox', async () => {
    const testDb = new ExpenseDatabase(`test-csv-import-${Date.now()}`);
    await ensureSeeded(testDb);
    await testDb.outbox.clear();

    const [accounts, categories, transactions] = await Promise.all([
      testDb.accounts.toArray(),
      testDb.categories.toArray(),
      testDb.transactions.toArray(),
    ]);

    const csv = [
      '日期,類型,金額,分類,子分類,帳戶,轉入帳戶,備註,發票號碼',
      '2026-11-22,支出,420,寵物,飼料,悠遊卡,,貓糧,XY12345678',
      '2026-11-23,支出,120,飲食,午餐,現金,,便當,',
    ].join('\n');

    const plan = planCsvImport(csv, { transactions, categories, accounts });
    expect(plan.errors).toEqual([]);
    expect(plan.items).toHaveLength(2);

    const result = await importCsvPlan(plan, testDb);
    expect(result).toEqual({
      importedCount: 2,
      createdAccountsCount: 1,
      createdCategoriesCount: 2,
    });

    const allAccounts = await testDb.accounts.toArray();
    const yoyoAccount = allAccounts.find((a) => a.name === '悠遊卡');
    expect(yoyoAccount).toBeDefined();
    expect(yoyoAccount?.deviceId).toBeTruthy();
    expect(yoyoAccount?.updatedAt).toBeGreaterThan(0);

    const allCategories = await testDb.categories.toArray();
    const petParent = allCategories.find((c) => c.name === '寵物' && c.parentId === null);
    const petChild = allCategories.find((c) => c.name === '飼料' && c.parentId === petParent?.id);
    expect(petParent).toBeDefined();
    expect(petChild).toBeDefined();

    const importedTxs = await testDb.transactions.toArray();
    expect(importedTxs).toHaveLength(2);
    const petTx = importedTxs.find((tx) => tx.note === '貓糧');
    expect(petTx).toMatchObject({
      kind: 'expense',
      date: '2026-11-22',
      amount: 420,
      accountId: yoyoAccount?.id,
      categoryId: petChild?.id,
      invoiceNo: 'XY12345678',
      deleted: false,
    });

    const outbox = await testDb.outbox.toArray();
    expect(outbox).toHaveLength(5);
    expect(outbox.filter((o) => o.table === 'accounts')).toHaveLength(1);
    expect(outbox.filter((o) => o.table === 'categories')).toHaveLength(2);
    expect(outbox.filter((o) => o.table === 'transactions')).toHaveLength(2);

    await testDb.delete();
  });
});
