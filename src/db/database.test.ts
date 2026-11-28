import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { planCsvImport } from '../domain/csvImport';
import { DEFAULT_HOME_SECTION_KEYS } from '../domain/homeLayout';
import { hashPin } from '../lib/pinLock';
import { ExpenseDatabase, META_KEYS, ensureSeeded } from './database';
import {
  archivePlace,
  bindSellerIdToPlace,
  confirmRecurringOccurrence,
  DEFAULT_AMOUNT_COLORS,
  DuplicateInvoiceError,
  DuplicateNotePresetError,
  DuplicatePlaceNameError,
  DuplicateSellerIdError,
  exportBackupData,
  deleteCard,
  getAmountColors,
  getAutoAddNotePresets,
  getAutoSelectLastPlace,
  getPendingRecurringOccurrences,
  importCsvPlan,
  parseBackupPayload,
  processRecurringRules,
  recordShortcutTransaction,
  resetAmountColors,
  restoreBackupData,
  saveAmountColors,
  saveBudget,
  saveCarrierCard,
  saveHomeLayout,
  saveLotteryDraw,
  saveMemberCard,
  saveNotePreset,
  savePinRecord,
  savePlace,
  saveRecurringRule,
  saveShortcut,
  saveTransaction,
  setAutoAddNotePresets,
  setAutoSelectLastPlace,
  setHideAmountsDefault,
  setNoSpendDay,
  skipRecurringOccurrence,
  softDeleteLotteryDraw,
  softDeleteNotePreset,
  softDeletePlace,
  softDeleteShortcut,
  softDeleteTransaction,
  swapNotePresetSortOrder,
  swapPlaceSortOrder,
  swapShortcutSortOrder,
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
    expect(backup.schemaVersion).toBe(15);
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
    expect(backup.schemaVersion).toBe(15);
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
      createdPlacesCount: 0,
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

describe('週期性收支資料庫邏輯（v6）', () => {
  it('刪除某期自動產生的交易後，再次執行 processRecurringRules 不會重新產生', async () => {
    const testDb = new ExpenseDatabase(`test-recurring-delete-${Date.now()}`);
    await ensureSeeded(testDb);

    const rule = await saveRecurringRule(
      {
        kind: 'expense',
        amount: 15000,
        accountId: 'seed-acc-bank',
        toAccountId: null,
        categoryId: 'seed-cat-housing',
        note: '房租',
        frequency: 'monthly',
        dayOfMonth: 5,
        weekday: 1,
        monthOfYear: 1,
        startDate: '2026-10-01',
        endDate: null,
        paused: false,
        autoPost: true,
      },
      testDb,
    );

    await processRecurringRules('2026-11-26', testDb);
    const octTxId = `rec-${rule.id}-2026-10-05`;
    const novTxId = `rec-${rule.id}-2026-11-05`;
    expect(await testDb.transactions.get(octTxId)).toBeDefined();
    expect(await testDb.transactions.get(novTxId)).toBeDefined();

    // 使用者刪除 10 月那一期
    await softDeleteTransaction(octTxId, testDb);
    expect((await testDb.transactions.get(octTxId))?.deleted).toBe(true);

    // 再次執行檢查（即使跨日）也不應重建已被軟刪除的 10 月那期
    const createdAgain = await processRecurringRules('2026-11-27', testDb);
    expect(createdAgain).toHaveLength(0);
    expect((await testDb.transactions.get(octTxId))?.deleted).toBe(true);

    await testDb.delete();
  });

  it('autoPost=false 的到期項目可入帳或略過，略過後不再出現於待確認清單', async () => {
    const testDb = new ExpenseDatabase(`test-recurring-manual-${Date.now()}`);
    await ensureSeeded(testDb);

    const rule = await saveRecurringRule(
      {
        kind: 'income',
        amount: 60000,
        accountId: 'seed-acc-bank',
        toAccountId: null,
        categoryId: 'seed-cat-income-salary',
        note: '薪資',
        frequency: 'monthly',
        dayOfMonth: 10,
        weekday: 1,
        monthOfYear: 1,
        startDate: '2026-10-01',
        endDate: null,
        paused: false,
        autoPost: false,
      },
      testDb,
    );

    const pending1 = await getPendingRecurringOccurrences('2026-11-26', testDb);
    expect(pending1.map((p) => p.occurrenceDate)).toEqual(['2026-10-10', '2026-11-10']);

    // 入帳 10 月、略過 11 月
    await confirmRecurringOccurrence(rule, '2026-10-10', testDb);
    await skipRecurringOccurrence(rule, '2026-11-10', testDb);

    const pending2 = await getPendingRecurringOccurrences('2026-11-26', testDb);
    expect(pending2).toHaveLength(0);

    const octTx = await testDb.transactions.get(`rec-${rule.id}-2026-10-10`);
    const novTx = await testDb.transactions.get(`rec-${rule.id}-2026-11-10`);
    expect(octTx?.deleted).toBe(false);
    expect(octTx?.amount).toBe(60000);
    expect(novTx?.deleted).toBe(true);

    await testDb.delete();
  });

  it('修改規則金額不會更改已產生的既有交易，只影響之後的期數', async () => {
    const testDb = new ExpenseDatabase(`test-recurring-edit-${Date.now()}`);
    await ensureSeeded(testDb);

    const rule = await saveRecurringRule(
      {
        kind: 'expense',
        amount: 390,
        accountId: 'seed-acc-credit',
        toAccountId: null,
        categoryId: 'seed-cat-entertainment',
        note: '串流訂閱',
        frequency: 'monthly',
        dayOfMonth: 15,
        weekday: 1,
        monthOfYear: 1,
        startDate: '2026-10-01',
        endDate: null,
        paused: false,
        autoPost: true,
      },
      testDb,
    );

    await processRecurringRules('2026-10-20', testDb);
    const octTxId = `rec-${rule.id}-2026-10-15`;
    expect((await testDb.transactions.get(octTxId))?.amount).toBe(390);

    // 漲價為 450
    await saveRecurringRule(
      {
        id: rule.id,
        kind: 'expense',
        amount: 450,
        accountId: 'seed-acc-credit',
        toAccountId: null,
        categoryId: 'seed-cat-entertainment',
        note: '串流訂閱',
        frequency: 'monthly',
        dayOfMonth: 15,
        weekday: 1,
        monthOfYear: 1,
        startDate: '2026-10-01',
        endDate: null,
        paused: false,
        autoPost: true,
      },
      testDb,
    );

    await processRecurringRules('2026-11-20', testDb);
    expect((await testDb.transactions.get(octTxId))?.amount).toBe(390);
    expect((await testDb.transactions.get(`rec-${rule.id}-2026-11-15`))?.amount).toBe(450);

    await testDb.delete();
  });

  it('JSON 備份含 recurringRules 且還原正確，舊資料庫（v5）升級至 v6 不影響既有資料', async () => {
    const dbName = `test-migrate-v5-to-v6-${Date.now()}`;
    const v5Db = new Dexie(dbName);
    v5Db.version(5).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions: 'id, kind, date, accountId, toAccountId, categoryId, invoiceNo, updatedAt, deleted',
      notePresets: 'id, categoryId, useCount, lastUsedAt, sortOrder, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });

    await v5Db.table('transactions').add({
      id: 'tx-v5-keep',
      kind: 'expense',
      date: '2026-11-10',
      amount: 250,
      accountId: 'seed-acc-cash',
      toAccountId: null,
      categoryId: 'seed-cat-food',
      note: 'v5 既有交易',
      updatedAt: 2000,
      deviceId: 'dev-v5',
      deleted: false,
    });
    v5Db.close();

    const v6Db = new ExpenseDatabase(dbName);
    await ensureSeeded(v6Db);
    expect((await v6Db.transactions.get('tx-v5-keep'))?.amount).toBe(250);

    const rule = await saveRecurringRule(
      {
        kind: 'expense',
        amount: 1200,
        accountId: 'seed-acc-bank',
        toAccountId: null,
        categoryId: 'seed-cat-daily',
        note: '電信費',
        frequency: 'monthly',
        dayOfMonth: 20,
        weekday: 1,
        monthOfYear: 1,
        startDate: '2026-11-01',
        endDate: null,
        paused: false,
        autoPost: true,
      },
      v6Db,
    );

    const backup = await exportBackupData(v6Db);
    expect(backup.recurringRules).toHaveLength(1);
    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));

    const restoreDb = new ExpenseDatabase(`test-restore-v6-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(parsed, restoreDb);
    expect(summary.recurringRules).toBe(1);
    expect((await restoreDb.recurringRules.get(rule.id))?.note).toBe('電信費');

    await v6Db.delete();
    await restoreDb.delete();
  });
});

describe('首頁捷徑資料庫邏輯（v7）', () => {
  it('有金額的捷徑一鍵記帳會寫入正確欄位與 outbox，復原時會軟刪除該筆交易', async () => {
    const testDb = new ExpenseDatabase(`test-shortcut-one-tap-${Date.now()}`);
    await ensureSeeded(testDb);

    const shortcut = await saveShortcut(
      {
        label: '早餐',
        icon: '🥐',
        kind: 'expense',
        amount: 60,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-breakfast',
        note: '蛋餅紅茶',
      },
      testDb,
    );

    const tx = await recordShortcutTransaction(shortcut, '2026-11-26', testDb);
    expect(tx.kind).toBe('expense');
    expect(tx.amount).toBe(60);
    expect(tx.date).toBe('2026-11-26');
    expect(tx.accountId).toBe('seed-acc-cash');
    expect(tx.categoryId).toBe('seed-cat-food-breakfast');
    expect(tx.note).toBe('蛋餅紅茶');

    const txOutbox = await testDb.outbox.get(`transactions:${tx.id}`);
    expect(txOutbox).toBeDefined();
    expect(txOutbox?.table).toBe('transactions');

    // 復原（軟刪除）
    await softDeleteTransaction(tx.id, testDb);
    const deletedTx = await testDb.transactions.get(tx.id);
    expect(deletedTx?.deleted).toBe(true);

    await testDb.delete();
  });

  it('無金額捷徑不可直接寫入交易', async () => {
    const testDb = new ExpenseDatabase(`test-shortcut-no-amount-${Date.now()}`);
    await ensureSeeded(testDb);

    const shortcut = await saveShortcut(
      {
        label: '午餐',
        icon: '🍱',
        kind: 'expense',
        amount: null,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        note: null,
      },
      testDb,
    );

    await expect(recordShortcutTransaction(shortcut, '2026-11-26', testDb)).rejects.toThrow();
    expect(await testDb.transactions.count()).toBe(0);

    await testDb.delete();
  });

  it('捷徑排序交換、軟刪除、JSON 備份還原與 v6 升級至 v7 保留既有資料', async () => {
    const dbName = `test-migrate-v6-to-v7-${Date.now()}`;
    const v6Db = new Dexie(dbName);
    v6Db.version(6).stores({
      accounts: 'id, updatedAt, deleted, sortOrder',
      categories: 'id, kind, parentId, updatedAt, deleted, sortOrder',
      transactions:
        'id, kind, date, accountId, toAccountId, categoryId, invoiceNo, recurringId, occurrenceDate, updatedAt, deleted',
      notePresets: 'id, categoryId, useCount, lastUsedAt, sortOrder, updatedAt, deleted',
      recurringRules: 'id, frequency, paused, startDate, endDate, updatedAt, deleted',
      meta: 'key',
      outbox: 'key, table, recordId, updatedAt',
    });

    await v6Db.table('transactions').add({
      id: 'tx-v6-keep',
      kind: 'expense',
      date: '2026-11-15',
      amount: 180,
      accountId: 'seed-acc-cash',
      toAccountId: null,
      categoryId: 'seed-cat-food',
      note: 'v6 既有交易',
      updatedAt: 2000,
      deviceId: 'dev-v6',
      deleted: false,
    });
    v6Db.close();

    const v7Db = new ExpenseDatabase(dbName);
    await ensureSeeded(v7Db);
    expect((await v7Db.transactions.get('tx-v6-keep'))?.amount).toBe(180);

    const s1 = await saveShortcut(
      {
        label: '捷運',
        icon: '🚇',
        kind: 'expense',
        amount: 25,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-transport',
        note: null,
      },
      v7Db,
    );
    const s2 = await saveShortcut(
      {
        label: '咖啡',
        icon: '☕',
        kind: 'expense',
        amount: null,
        accountId: 'seed-acc-credit',
        toAccountId: null,
        categoryId: 'seed-cat-food-snack',
        note: '美式',
      },
      v7Db,
    );

    await swapShortcutSortOrder(s1.id, s2.id, v7Db);
    const sorted = await v7Db.shortcuts.orderBy('sortOrder').toArray();
    expect(sorted.map((s) => s.id)).toEqual([s2.id, s1.id]);

    await softDeleteShortcut(s2.id, v7Db);

    const backup = await exportBackupData(v7Db);
    expect(backup.shortcuts).toHaveLength(2);
    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));

    const restoreDb = new ExpenseDatabase(`test-restore-v7-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(parsed, restoreDb);
    expect(summary.shortcuts).toBe(2);
    expect((await restoreDb.shortcuts.get(s1.id))?.label).toBe('捷運');
    expect((await restoreDb.shortcuts.get(s2.id))?.deleted).toBe(true);

    await v7Db.delete();
    await restoreDb.delete();
  });
});

describe('地點與時間資料庫邏輯（v8）', () => {
  it('同名地點不可重複，已使用地點不可刪除只能停用，儲存交易累加 useCount 並更新 lastUsedAt', async () => {
    const testDb = new ExpenseDatabase(`test-place-crud-${Date.now()}`);
    await ensureSeeded(testDb);

    // 預設不建立任何地點
    expect(await testDb.places.count()).toBe(0);

    const p1 = await savePlace({ name: '公司附近' }, testDb);
    expect(p1.icon).toBe('📍');
    expect(p1.useCount).toBe(0);

    await expect(savePlace({ name: '  公司附近  ' }, testDb)).rejects.toBeInstanceOf(
      DuplicatePlaceNameError,
    );

    const p2 = await savePlace({ name: '住家巷口', icon: '🏠' }, testDb);
    await swapPlaceSortOrder(p1.id, p2.id, testDb);
    const sorted = await testDb.places.orderBy('sortOrder').toArray();
    expect(sorted.map((p) => p.id)).toEqual([p2.id, p1.id]);

    // 儲存交易選取 p1，useCount + 1 且更新 lastUsedAt
    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        time: '12:30',
        amount: 120,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        placeId: p1.id,
        note: '便當',
      },
      testDb,
    );

    const updatedP1 = await testDb.places.get(p1.id);
    expect(updatedP1?.useCount).toBe(1);
    expect(updatedP1?.lastUsedAt).toBeGreaterThan(0);

    // 已使用地點不可刪除，只能停用
    await expect(softDeletePlace(p1.id, testDb)).rejects.toThrow();
    await archivePlace(p1.id, true, testDb);
    expect((await testDb.places.get(p1.id))?.archived).toBe(true);

    // 未被交易使用的地點可刪除
    await softDeletePlace(p2.id, testDb);
    expect((await testDb.places.get(p2.id))?.deleted).toBe(true);

    // 本機設定 autoSelectLastPlace 預設關閉
    expect(await getAutoSelectLastPlace(testDb)).toBe(false);
    await setAutoSelectLastPlace(true, testDb);
    expect(await getAutoSelectLastPlace(testDb)).toBe(true);

    await testDb.delete();
  });

  it('賣方統編首次綁定、不可同時綁兩個地點、改選後移轉綁定', async () => {
    const testDb = new ExpenseDatabase(`test-place-seller-${Date.now()}`);
    await ensureSeeded(testDb);

    const p1 = await savePlace({ name: '7-11 門市' }, testDb);
    const p2 = await savePlace({ name: '全家門市' }, testDb);

    await bindSellerIdToPlace(p1.id, '12345678', testDb);
    expect((await testDb.places.get(p1.id))?.sellerIds).toEqual(['12345678']);

    // savePlace 不可將同一統編綁定到另一個地點
    await expect(
      savePlace({ id: p2.id, name: '全家門市', sellerIds: ['12345678'] }, testDb),
    ).rejects.toBeInstanceOf(DuplicateSellerIdError);

    // bindSellerIdToPlace 移轉綁定至 p2，並從 p1 移除
    await bindSellerIdToPlace(p2.id, '12345678', testDb);
    expect((await testDb.places.get(p1.id))?.sellerIds ?? []).toEqual([]);
    expect((await testDb.places.get(p2.id))?.sellerIds).toEqual(['12345678']);

    await testDb.delete();
  });

  it('JSON 備份還原含 places，且 v7 升級至 v8 保留既有交易（time 與 placeId 為空）', async () => {
    const dbName = `test-migrate-v7-to-v8-${Date.now()}`;
    const v7Db = new Dexie(dbName);
    v7Db.version(7).stores({
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

    await v7Db.table('transactions').add({
      id: 'tx-v7-keep',
      kind: 'expense',
      date: '2026-11-20',
      amount: 250,
      accountId: 'seed-acc-cash',
      toAccountId: null,
      categoryId: 'seed-cat-food',
      note: 'v7 既有交易',
      updatedAt: 3000,
      deviceId: 'dev-v7',
      deleted: false,
    });
    v7Db.close();

    const v8Db = new ExpenseDatabase(dbName);
    await ensureSeeded(v8Db);
    const oldTx = await v8Db.transactions.get('tx-v7-keep');
    expect(oldTx?.amount).toBe(250);
    expect(oldTx?.time).toBeUndefined();
    expect(oldTx?.placeId).toBeUndefined();

    const place = await savePlace({ name: '公館夜市', icon: '🏮', sellerIds: ['87654321'] }, v8Db);
    const backup = await exportBackupData(v8Db);
    expect(backup.schemaVersion).toBe(15);
    expect(backup.places).toHaveLength(1);

    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));
    const restoreDb = new ExpenseDatabase(`test-restore-v8-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(parsed, restoreDb);
    expect(summary.places).toBe(1);
    const restoredPlace = await restoreDb.places.get(place.id);
    expect(restoredPlace?.name).toBe('公館夜市');
    expect(restoredPlace?.sellerIds).toEqual(['87654321']);

    await v8Db.delete();
    await restoreDb.delete();
  });
});

describe('發票開獎號碼資料庫邏輯（v9）', () => {
  it('saveLotteryDraw 使用固定 id draw-YYYY-MM 覆寫同期資料並寫入 outbox，且備份還原支援 lotteryDraws', async () => {
    const testDb = new ExpenseDatabase(`test-lottery-v9-${Date.now()}`);
    await ensureSeeded(testDb);

    const saved = await saveLotteryDraw(
      {
        period: '2026-09',
        special: '12345678',
        grand: '87654321',
        first: ['11111111', '22222222', '33333333'],
        extraSixth: ['999'],
      },
      testDb,
    );
    expect(saved.id).toBe('draw-2026-09');
    expect((await testDb.outbox.get('lotteryDraws:draw-2026-09'))?.recordId).toBe('draw-2026-09');

    await saveLotteryDraw(
      {
        period: '2026-09',
        special: '00000001',
        grand: '87654321',
        first: ['11111111', '22222222', '33333333'],
        extraSixth: [],
      },
      testDb,
    );
    expect(await testDb.lotteryDraws.count()).toBe(1);
    expect((await testDb.lotteryDraws.get('draw-2026-09'))?.special).toBe('00000001');

    const backup = await exportBackupData(testDb);
    expect(backup.lotteryDraws).toHaveLength(1);

    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));
    const restoreDb = new ExpenseDatabase(`test-lottery-restore-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(parsed, restoreDb);
    expect(summary.lotteryDraws).toBe(1);
    expect((await restoreDb.lotteryDraws.get('draw-2026-09'))?.special).toBe('00000001');

    await softDeleteLotteryDraw('2026-09', testDb);
    expect((await testDb.lotteryDraws.get('draw-2026-09'))?.deleted).toBe(true);

    await testDb.delete();
    await restoreDb.delete();
  });
});

describe('這天沒花錢標記資料庫邏輯（v11）', () => {
  it('setNoSpendDay 使用固定 id 寫入 outbox、取消時軟刪除，且 JSON 備份含 noSpendDays 並可還原舊版備份', async () => {
    const testDb = new ExpenseDatabase(`test-nospend-v11-${Date.now()}`);
    await ensureSeeded(testDb);

    const marked = await setNoSpendDay('2026-11-24', true, testDb);
    const unmarked = await setNoSpendDay('2026-11-25', true, testDb);
    expect(marked?.id).toBe('nospend-2026-11-24');
    expect(unmarked?.id).toBe('nospend-2026-11-25');
    expect((await testDb.outbox.get('noSpendDays:nospend-2026-11-24'))?.recordId).toBe(
      'nospend-2026-11-24',
    );

    // 取消標記會軟刪除並寫入 outbox
    const cancelled = await setNoSpendDay('2026-11-25', false, testDb);
    expect(cancelled).toBeNull();
    const deletedRow = await testDb.noSpendDays.get('nospend-2026-11-25');
    expect(deletedRow?.deleted).toBe(true);

    // JSON 備份含 noSpendDays（含軟刪除紀錄）
    const backup = await exportBackupData(testDb);
    expect(backup.noSpendDays).toHaveLength(2);

    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));
    const restoreDb = new ExpenseDatabase(`test-nospend-restore-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(parsed, restoreDb);
    expect(summary.noSpendDays).toBe(2);
    expect((await restoreDb.noSpendDays.get('nospend-2026-11-24'))?.deleted).toBe(false);
    expect((await restoreDb.noSpendDays.get('nospend-2026-11-25'))?.deleted).toBe(true);

    // 舊版備份（沒有 noSpendDays 欄位）也能正常還原
    const legacyRaw = JSON.parse(JSON.stringify(backup)) as Record<string, unknown>;
    delete legacyRaw.noSpendDays;
    const legacyParsed = parseBackupPayload(legacyRaw);
    expect(legacyParsed.noSpendDays).toEqual([]);
    const legacyRestoreDb = new ExpenseDatabase(`test-nospend-legacy-${Date.now()}`);
    await ensureSeeded(legacyRestoreDb);
    const legacySummary = await restoreBackupData(legacyParsed, legacyRestoreDb);
    expect(legacySummary.noSpendDays).toBe(0);

    await testDb.delete();
    await restoreDb.delete();
    await legacyRestoreDb.delete();
  });
});

describe('本機隱私與 ui.* 設定隔離（不進 JSON 備份與同步）', () => {
  it('首頁版面、密碼鎖雜湊與預設隱藏金額不會放進 JSON 備份，也不會排入 outbox 同步', async () => {
    const testDb = new ExpenseDatabase(`test-privacy-meta-${Date.now()}`);
    await ensureSeeded(testDb);
    const outboxBefore = await testDb.outbox.count();

    await saveHomeLayout(
      DEFAULT_HOME_SECTION_KEYS.map((key, idx) => ({ key, visible: idx % 2 === 0 })),
      testDb,
    );
    const pinRecord = await hashPin('2580');
    await savePinRecord(pinRecord, testDb);
    await setHideAmountsDefault(true, testDb);

    // 確認 outbox 未新增任何同步項目
    expect(await testDb.outbox.count()).toBe(outboxBefore);

    // 確認 JSON 備份中不含任何 ui.* meta 鍵值與 PIN 雜湊／salt
    const backup = await exportBackupData(testDb);
    const uiMetaKeys = (backup.meta ?? []).filter((entry) => entry.key.startsWith('ui.'));
    expect(uiMetaKeys).toEqual([]);

    const serialized = JSON.stringify(backup);
    expect(serialized).not.toContain(META_KEYS.UI_HOME_LAYOUT);
    expect(serialized).not.toContain(META_KEYS.UI_PIN_HASH);
    expect(serialized).not.toContain(META_KEYS.UI_HIDE_AMOUNTS_DEFAULT);
    expect(serialized).not.toContain(pinRecord.hash);
    expect(serialized).not.toContain(pinRecord.salt);

    await testDb.delete();
  });
});

describe('載具與會員卡資料庫邏輯（v12）', () => {
  it('cards 寫入 outbox、載具固定 id、軟刪除，且 JSON 備份含 cards 並可還原舊版備份', async () => {
    const testDb = new ExpenseDatabase(`test-cards-v12-${Date.now()}`);
    await ensureSeeded(testDb);

    const carrier = await saveCarrierCard('/abc1234', testDb);
    expect(carrier.id).toBe('card-carrier');
    expect(carrier.code).toBe('/ABC1234');
    expect(carrier.format).toBe('code39');
    expect((await testDb.outbox.get('cards:card-carrier'))?.recordId).toBe('card-carrier');

    const member = await saveMemberCard(
      { name: '全聯福利卡', code: '4006381333931' },
      testDb,
    );
    expect(member.format).toBe('ean13');
    expect((await testDb.outbox.get(`cards:${member.id}`))?.recordId).toBe(member.id);

    const memberToDelete = await saveMemberCard(
      { name: '家樂福', code: '99887766' },
      testDb,
    );
    await deleteCard(memberToDelete.id, testDb);
    expect((await testDb.cards.get(memberToDelete.id))?.deleted).toBe(true);

    // JSON 備份含 cards（含軟刪除紀錄）
    const backup = await exportBackupData(testDb);
    expect(backup.cards).toHaveLength(3);

    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));
    const restoreDb = new ExpenseDatabase(`test-cards-restore-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(parsed, restoreDb);
    expect(summary.cards).toBe(3);
    expect((await restoreDb.cards.get('card-carrier'))?.code).toBe('/ABC1234');
    expect((await restoreDb.cards.get(memberToDelete.id))?.deleted).toBe(true);

    // 舊版備份（沒有 cards 欄位）也能正常還原
    const legacyRaw = JSON.parse(JSON.stringify(backup)) as Record<string, unknown>;
    delete legacyRaw.cards;
    const legacyParsed = parseBackupPayload(legacyRaw);
    expect(legacyParsed.cards).toEqual([]);
    const legacyRestoreDb = new ExpenseDatabase(`test-cards-legacy-${Date.now()}`);
    await ensureSeeded(legacyRestoreDb);
    const legacySummary = await restoreBackupData(legacyParsed, legacyRestoreDb);
    expect(legacySummary.cards).toBe(0);

    await testDb.delete();
    await restoreDb.delete();
    await legacyRestoreDb.delete();
  });
});

describe('每月預算資料庫邏輯（v10）', () => {
  it('saveBudget 使用固定 id 寫入 outbox、設 0 會軟刪除，且 JSON 備份含 budgets 並可還原舊版備份', async () => {
    const testDb = new ExpenseDatabase(`test-budget-v10-${Date.now()}`);
    await ensureSeeded(testDb);

    const totalBudget = await saveBudget({ categoryId: null, amount: 30000 }, testDb);
    const foodBudget = await saveBudget({ categoryId: 'seed-cat-food', amount: 8000 }, testDb);
    expect(totalBudget?.id).toBe('budget-total');
    expect(foodBudget?.id).toBe('budget-seed-cat-food');

    expect((await testDb.outbox.get('budgets:budget-total'))?.recordId).toBe('budget-total');
    expect((await testDb.outbox.get('budgets:budget-seed-cat-food'))?.recordId).toBe(
      'budget-seed-cat-food',
    );

    // 設 0 會軟刪除並寫入 outbox
    const deletedResult = await saveBudget({ categoryId: 'seed-cat-food', amount: 0 }, testDb);
    expect(deletedResult).toBeNull();
    const deletedRow = await testDb.budgets.get('budget-seed-cat-food');
    expect(deletedRow?.deleted).toBe(true);

    // JSON 備份含 budgets（含軟刪除紀錄）
    const backup = await exportBackupData(testDb);
    expect(backup.budgets).toHaveLength(2);

    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));
    const restoreDb = new ExpenseDatabase(`test-budget-restore-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(parsed, restoreDb);
    expect(summary.budgets).toBe(2);
    expect((await restoreDb.budgets.get('budget-total'))?.amount).toBe(30000);

    // 舊版備份（沒有 budgets 欄位）也能正常還原
    const legacyRaw = JSON.parse(JSON.stringify(backup)) as Record<string, unknown>;
    delete legacyRaw.budgets;
    const legacyParsed = parseBackupPayload(legacyRaw);
    expect(legacyParsed.budgets).toEqual([]);
    const legacyRestoreDb = new ExpenseDatabase(`test-budget-legacy-${Date.now()}`);
    await ensureSeeded(legacyRestoreDb);
    const legacySummary = await restoreBackupData(legacyParsed, legacyRestoreDb);
    expect(legacySummary.budgets).toBe(0);

    await testDb.delete();
    await restoreDb.delete();
    await legacyRestoreDb.delete();
  });
});

describe('本機隱私與 ui.* 設定隔離（不進 JSON 備份與同步）', () => {
  it('首頁版面、密碼鎖雜湊與預設隱藏金額不會放進 JSON 備份，也不會排入 outbox 同步', async () => {
    const testDb = new ExpenseDatabase(`test-privacy-meta-${Date.now()}`);
    await ensureSeeded(testDb);
    const outboxBefore = await testDb.outbox.count();

    await saveHomeLayout(
      DEFAULT_HOME_SECTION_KEYS.map((key, idx) => ({ key, visible: idx % 2 === 0 })),
      testDb,
    );
    const pinRecord = await hashPin('2580');
    await savePinRecord(pinRecord, testDb);
    await setHideAmountsDefault(true, testDb);

    // 確認 outbox 未新增任何同步項目
    expect(await testDb.outbox.count()).toBe(outboxBefore);

    // 確認 JSON 備份中不含任何 ui.* meta 鍵值與 PIN 雜湊／salt
    const backup = await exportBackupData(testDb);
    const uiMetaKeys = (backup.meta ?? []).filter((entry) => entry.key.startsWith('ui.'));
    expect(uiMetaKeys).toEqual([]);

    const serialized = JSON.stringify(backup);
    expect(serialized).not.toContain(META_KEYS.UI_HOME_LAYOUT);
    expect(serialized).not.toContain(META_KEYS.UI_PIN_HASH);
    expect(serialized).not.toContain(META_KEYS.UI_HIDE_AMOUNTS_DEFAULT);
    expect(serialized).not.toContain(pinRecord.hash);
    expect(serialized).not.toContain(pinRecord.salt);

    await testDb.delete();
  });
});

describe('載具與會員卡資料庫邏輯（v12）', () => {
  it('cards 寫入 outbox、載具固定 id、軟刪除，且 JSON 備份含 cards 並可還原舊版備份', async () => {
    const testDb = new ExpenseDatabase(`test-cards-v12-${Date.now()}`);
    await ensureSeeded(testDb);

    const carrier = await saveCarrierCard('/abc1234', testDb);
    expect(carrier.id).toBe('card-carrier');
    expect(carrier.code).toBe('/ABC1234');
    expect(carrier.format).toBe('code39');
    expect((await testDb.outbox.get('cards:card-carrier'))?.recordId).toBe('card-carrier');

    const member = await saveMemberCard(
      { name: '全聯福利卡', code: '4006381333931' },
      testDb,
    );
    expect(member.format).toBe('ean13');
    expect((await testDb.outbox.get(`cards:${member.id}`))?.recordId).toBe(member.id);

    const memberToDelete = await saveMemberCard(
      { name: '家樂福', code: '99887766' },
      testDb,
    );
    await deleteCard(memberToDelete.id, testDb);
    expect((await testDb.cards.get(memberToDelete.id))?.deleted).toBe(true);

    // JSON 備份含 cards（含軟刪除紀錄）
    const backup = await exportBackupData(testDb);
    expect(backup.cards).toHaveLength(3);

    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));
    const restoreDb = new ExpenseDatabase(`test-cards-restore-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(parsed, restoreDb);
    expect(summary.cards).toBe(3);
    expect((await restoreDb.cards.get('card-carrier'))?.code).toBe('/ABC1234');
    expect((await restoreDb.cards.get(memberToDelete.id))?.deleted).toBe(true);

    // 舊版備份（沒有 cards 欄位）也能正常還原
    const legacyRaw = JSON.parse(JSON.stringify(backup)) as Record<string, unknown>;
    delete legacyRaw.cards;
    const legacyParsed = parseBackupPayload(legacyRaw);
    expect(legacyParsed.cards).toEqual([]);
    const legacyRestoreDb = new ExpenseDatabase(`test-cards-legacy-${Date.now()}`);
    await ensureSeeded(legacyRestoreDb);
    const legacySummary = await restoreBackupData(legacyParsed, legacyRestoreDb);
    expect(legacySummary.cards).toBe(0);

    await testDb.delete();
    await restoreDb.delete();
    await legacyRestoreDb.delete();
  });
});

describe('交易標籤（tags）資料庫與備份相容性', () => {
  it('交易儲存標籤後可正常讀取與備份還原，舊交易（無 tags）讀取與備份還原亦正常', async () => {
    const testDb = new ExpenseDatabase(`test-tags-${Date.now()}`);
    await ensureSeeded(testDb);

    // 寫入一筆無 tags 的舊格式交易
    await testDb.transactions.add({
      id: 'tx-legacy-no-tags',
      kind: 'expense',
      date: '2026-11-01',
      amount: 100,
      accountId: 'seed-acc-cash',
      toAccountId: null,
      categoryId: 'seed-cat-food',
      note: '舊交易',
      updatedAt: 1000,
      deviceId: 'dev-old',
      deleted: false,
    });

    const taggedTx = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 1200,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '拉麵',
        tags: ['#日本旅遊', '可報帳', '日本旅遊'],
      },
      testDb,
    );

    expect(taggedTx.tags).toEqual(['日本旅遊', '可報帳']);
    expect((await testDb.transactions.get('tx-legacy-no-tags'))?.tags).toBeUndefined();

    const backup = await exportBackupData(testDb);
    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));
    const restoreDb = new ExpenseDatabase(`test-tags-restore-${Date.now()}`);
    await ensureSeeded(restoreDb);
    await restoreBackupData(parsed, restoreDb);

    const restoredTagged = await restoreDb.transactions.get(taggedTx.id);
    const restoredLegacy = await restoreDb.transactions.get('tx-legacy-no-tags');
    expect(restoredTagged?.tags).toEqual(['日本旅遊', '可報帳']);
    expect(restoredLegacy?.note).toBe('舊交易');
    expect(restoredLegacy?.tags).toBeUndefined();

    await testDb.delete();
    await restoreDb.delete();
  });
});

describe('這天沒花錢標記資料庫邏輯（v11）', () => {
  it('setNoSpendDay 使用固定 id 寫入 outbox、取消時軟刪除，且 JSON 備份含 noSpendDays 並可還原舊版備份', async () => {
    const testDb = new ExpenseDatabase(`test-nospend-v11-${Date.now()}`);
    await ensureSeeded(testDb);

    const marked = await setNoSpendDay('2026-11-24', true, testDb);
    const unmarked = await setNoSpendDay('2026-11-25', true, testDb);
    expect(marked?.id).toBe('nospend-2026-11-24');
    expect(unmarked?.id).toBe('nospend-2026-11-25');
    expect((await testDb.outbox.get('noSpendDays:nospend-2026-11-24'))?.recordId).toBe(
      'nospend-2026-11-24',
    );

    // 取消標記會軟刪除並寫入 outbox
    const cancelled = await setNoSpendDay('2026-11-25', false, testDb);
    expect(cancelled).toBeNull();
    const deletedRow = await testDb.noSpendDays.get('nospend-2026-11-25');
    expect(deletedRow?.deleted).toBe(true);

    // JSON 備份含 noSpendDays（含軟刪除紀錄）
    const backup = await exportBackupData(testDb);
    expect(backup.noSpendDays).toHaveLength(2);

    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));
    const restoreDb = new ExpenseDatabase(`test-nospend-restore-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(parsed, restoreDb);
    expect(summary.noSpendDays).toBe(2);
    expect((await restoreDb.noSpendDays.get('nospend-2026-11-24'))?.deleted).toBe(false);
    expect((await restoreDb.noSpendDays.get('nospend-2026-11-25'))?.deleted).toBe(true);

    // 舊版備份（沒有 noSpendDays 欄位）也能正常還原
    const legacyRaw = JSON.parse(JSON.stringify(backup)) as Record<string, unknown>;
    delete legacyRaw.noSpendDays;
    const legacyParsed = parseBackupPayload(legacyRaw);
    expect(legacyParsed.noSpendDays).toEqual([]);
    const legacyRestoreDb = new ExpenseDatabase(`test-nospend-legacy-${Date.now()}`);
    await ensureSeeded(legacyRestoreDb);
    const legacySummary = await restoreBackupData(legacyParsed, legacyRestoreDb);
    expect(legacySummary.noSpendDays).toBe(0);

    await testDb.delete();
    await restoreDb.delete();
    await legacyRestoreDb.delete();
  });
});

describe('本機隱私與 ui.* 設定隔離（不進 JSON 備份與同步）', () => {
  it('首頁版面、密碼鎖雜湊與預設隱藏金額不會放進 JSON 備份，也不會排入 outbox 同步', async () => {
    const testDb = new ExpenseDatabase(`test-privacy-meta-${Date.now()}`);
    await ensureSeeded(testDb);
    const outboxBefore = await testDb.outbox.count();

    await saveHomeLayout(
      DEFAULT_HOME_SECTION_KEYS.map((key, idx) => ({ key, visible: idx % 2 === 0 })),
      testDb,
    );
    const pinRecord = await hashPin('2580');
    await savePinRecord(pinRecord, testDb);
    await setHideAmountsDefault(true, testDb);

    // 確認 outbox 未新增任何同步項目
    expect(await testDb.outbox.count()).toBe(outboxBefore);

    // 確認 JSON 備份中不含任何 ui.* meta 鍵值與 PIN 雜湊／salt
    const backup = await exportBackupData(testDb);
    const uiMetaKeys = (backup.meta ?? []).filter((entry) => entry.key.startsWith('ui.'));
    expect(uiMetaKeys).toEqual([]);

    const serialized = JSON.stringify(backup);
    expect(serialized).not.toContain(META_KEYS.UI_HOME_LAYOUT);
    expect(serialized).not.toContain(META_KEYS.UI_PIN_HASH);
    expect(serialized).not.toContain(META_KEYS.UI_HIDE_AMOUNTS_DEFAULT);
    expect(serialized).not.toContain(pinRecord.hash);
    expect(serialized).not.toContain(pinRecord.salt);

    await testDb.delete();
  });
});

describe('載具與會員卡資料庫邏輯（v12）', () => {
  it('cards 寫入 outbox、載具固定 id、軟刪除，且 JSON 備份含 cards 並可還原舊版備份', async () => {
    const testDb = new ExpenseDatabase(`test-cards-v12-${Date.now()}`);
    await ensureSeeded(testDb);

    const carrier = await saveCarrierCard('/abc1234', testDb);
    expect(carrier.id).toBe('card-carrier');
    expect(carrier.code).toBe('/ABC1234');
    expect(carrier.format).toBe('code39');
    expect((await testDb.outbox.get('cards:card-carrier'))?.recordId).toBe('card-carrier');

    const member = await saveMemberCard(
      { name: '全聯福利卡', code: '4006381333931' },
      testDb,
    );
    expect(member.format).toBe('ean13');
    expect((await testDb.outbox.get(`cards:${member.id}`))?.recordId).toBe(member.id);

    const memberToDelete = await saveMemberCard(
      { name: '家樂福', code: '99887766' },
      testDb,
    );
    await deleteCard(memberToDelete.id, testDb);
    expect((await testDb.cards.get(memberToDelete.id))?.deleted).toBe(true);

    // JSON 備份含 cards（含軟刪除紀錄）
    const backup = await exportBackupData(testDb);
    expect(backup.cards).toHaveLength(3);

    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));
    const restoreDb = new ExpenseDatabase(`test-cards-restore-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(parsed, restoreDb);
    expect(summary.cards).toBe(3);
    expect((await restoreDb.cards.get('card-carrier'))?.code).toBe('/ABC1234');
    expect((await restoreDb.cards.get(memberToDelete.id))?.deleted).toBe(true);

    // 舊版備份（沒有 cards 欄位）也能正常還原
    const legacyRaw = JSON.parse(JSON.stringify(backup)) as Record<string, unknown>;
    delete legacyRaw.cards;
    const legacyParsed = parseBackupPayload(legacyRaw);
    expect(legacyParsed.cards).toEqual([]);
    const legacyRestoreDb = new ExpenseDatabase(`test-cards-legacy-${Date.now()}`);
    await ensureSeeded(legacyRestoreDb);
    const legacySummary = await restoreBackupData(legacyParsed, legacyRestoreDb);
    expect(legacySummary.cards).toBe(0);

    await testDb.delete();
    await restoreDb.delete();
    await legacyRestoreDb.delete();
  });
});
