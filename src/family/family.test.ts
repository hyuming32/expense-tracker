import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureSeeded,
  ExpenseDatabase,
  FAMILY_DB_NAME,
  META_KEYS,
  personalDb,
} from '../db/database';
import {
  getBudgets,
  getMemberBudgets,
  getPinRecord,
  saveAccount,
  saveBudget,
  saveCategory,
  saveInstallmentTransactions,
  saveMemberBudget,
  savePlace,
  savePinRecord,
  savePrivateTransactionFromFamily,
  saveTransaction,
  softDeleteTransaction,
  stampMember,
} from '../db/repository';
import { computeBudgetStatus } from '../domain/budget';
import { hashPin } from '../lib/pinLock';
import {
  clearFamilyConfig,
  getActiveLedger,
  getFamilyConfig,
  isFamilyReadOnly,
  setActiveLedger,
  setFamilyConfig,
} from './familyConfig';
import { parseFamilyLedgerFile } from './familyFile';
import {
  createFamilyLedger,
  getMembers,
  inviteMember,
  joinFamilyLedger,
  removeMember,
} from './familyManager';
import { MemoryFamilyDriveStore } from './familyStore';
import { FamilyAccessLostError, syncFamilyOnce } from './familySync';

const createdDbs: ExpenseDatabase[] = [];

function createIsolatedFamilyDb(): ExpenseDatabase {
  const database = new ExpenseDatabase(FAMILY_DB_NAME, {
    indexedDB: new IDBFactory(),
    IDBKeyRange: globalThis.IDBKeyRange,
  });
  createdDbs.push(database);
  return database;
}

function createNamedDb(label: string): ExpenseDatabase {
  const database = new ExpenseDatabase(`test-family-${label}-${Date.now()}-${Math.random()}`);
  createdDbs.push(database);
  return database;
}

const USER_A = {
  permissionId: 'perm-user-a',
  emailAddress: 'alice@example.com',
  displayName: 'Alice',
};

const USER_B = {
  permissionId: 'perm-user-b',
  emailAddress: 'bob@example.com',
  displayName: 'Bob',
};

function installMemoryLocalStorage(): void {
  if (typeof globalThis.localStorage !== 'undefined') {
    globalThis.localStorage.clear();
    return;
  }
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, String(value));
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
      clear: () => {
        map.clear();
      },
    },
  });
}

beforeEach(() => {
  installMemoryLocalStorage();
  clearFamilyConfig();
});

afterEach(async () => {
  clearFamilyConfig();
  while (createdDbs.length > 0) {
    const database = createdDbs.pop();
    if (database) {
      await database.delete();
    }
  }
});

describe('家庭帳本資料層與同步核心', () => {
  it('1. A 建檔、B 加入；A 記 1 筆、B 記 1 筆，各同步兩次後兩邊都有 2 筆，memberId 分別正確', async () => {
    const rootStore = new MemoryFamilyDriveStore(USER_A);
    const storeA = rootStore;
    const storeB = rootStore.asUser(USER_B);

    const dbA = createIsolatedFamilyDb();
    const dbB = createIsolatedFamilyDb();

    // A 建檔並邀請 B
    const configA = await createFamilyLedger(
      { ledgerName: '我們家', myName: '爸爸', color: '#2563EB' },
      { store: storeA, database: dbA },
    );
    await inviteMember(USER_B.emailAddress, { store: storeA });

    // B 加入
    const configB = await joinFamilyLedger(
      { myName: '媽媽', color: '#E11D48' },
      { store: storeB, database: dbB },
    );
    expect(configB.fileId).toBe(configA.fileId);
    expect(configB.role).toBe('member');

    // A 記 1 筆
    setFamilyConfig(configA);
    const txA = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 250,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        note: 'A 的午餐',
      },
      dbA,
    );
    expect(txA.memberId).toBe(USER_A.permissionId);
    expect(txA.lastEditedBy).toBe(USER_A.permissionId);

    // B 記 1 筆
    setFamilyConfig(configB);
    const txB = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 420,
        accountId: 'seed-acc-credit',
        toAccountId: null,
        categoryId: 'seed-cat-daily',
        note: 'B 買日用品',
      },
      dbB,
    );
    expect(txB.memberId).toBe(USER_B.permissionId);
    expect(txB.lastEditedBy).toBe(USER_B.permissionId);

    // 各同步兩次
    await syncFamilyOnce({ database: dbA, store: storeA, fileId: configA.fileId });
    await syncFamilyOnce({ database: dbB, store: storeB, fileId: configB.fileId });
    await syncFamilyOnce({ database: dbA, store: storeA, fileId: configA.fileId });
    await syncFamilyOnce({ database: dbB, store: storeB, fileId: configB.fileId });

    const aTxs = (await dbA.transactions.orderBy('id').toArray()).filter((t) => !t.deleted);
    const bTxs = (await dbB.transactions.orderBy('id').toArray()).filter((t) => !t.deleted);
    expect(aTxs).toHaveLength(2);
    expect(bTxs).toHaveLength(2);
    expect(aTxs).toEqual(bTxs);

    expect((await dbA.transactions.get(txA.id))?.memberId).toBe(USER_A.permissionId);
    expect((await dbA.transactions.get(txB.id))?.memberId).toBe(USER_B.permissionId);
    expect((await dbB.transactions.get(txA.id))?.memberId).toBe(USER_A.permissionId);
    expect((await dbB.transactions.get(txB.id))?.memberId).toBe(USER_B.permissionId);

    const membersA = await getMembers(dbA);
    expect(membersA.map((m) => m.id).sort()).toEqual([USER_A.permissionId, USER_B.permissionId].sort());
  });

  it('2. 覆蓋情境：A、B 同版出發，B 覆蓋掉 A 的新紀錄後，各自再同步一次最終一致', async () => {
    const rootStore = new MemoryFamilyDriveStore(USER_A);
    const storeA = rootStore;
    const storeB = rootStore.asUser(USER_B);

    const dbA = createIsolatedFamilyDb();
    const dbB = createIsolatedFamilyDb();

    const configA = await createFamilyLedger(
      { ledgerName: '家帳', myName: 'A', color: '#111111' },
      { store: storeA, database: dbA },
    );
    await inviteMember(USER_B.emailAddress, { store: storeA });
    const configB = await joinFamilyLedger(
      { myName: 'B', color: '#222222' },
      { store: storeB, database: dbB },
    );

    // 雙方先同步到同一版
    await syncFamilyOnce({ database: dbA, store: storeA, fileId: configA.fileId });
    await syncFamilyOnce({ database: dbB, store: storeB, fileId: configB.fileId });

    // A 記一筆並先上傳
    setFamilyConfig(configA);
    const txA = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 100,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: 'A 先傳但將被蓋掉',
      },
      dbA,
    );
    await syncFamilyOnce({ database: dbA, store: storeA, fileId: configA.fileId });

    // 模擬 B 尚未下載 A 的新版，直接拿舊版檔案合併（此處直接用 B 下載前已記好的離線筆＋先鎖住遠端舊版來模擬同時上傳覆蓋）
    const snapshotBeforeA = JSON.stringify({
      ...parseFamilyLedgerFile(await storeB.download(configB.fileId)),
      records: {
        ...parseFamilyLedgerFile(await storeB.download(configB.fileId)).records,
        transactions: [],
      },
    });
    // 把雲端暫時放回 B 下載時看到的舊版（不含 txA），讓 B 同步時把自己的 txB 上傳蓋掉 txA
    await storeB.update(configB.fileId, snapshotBeforeA);

    setFamilyConfig(configB);
    const txB = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 200,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: 'B 同時上傳蓋掉 A',
      },
      dbB,
    );
    const resB1 = await syncFamilyOnce({ database: dbB, store: storeB, fileId: configB.fileId });
    expect(resB1.uploaded).toBe(true);

    // 此時雲端檔案中只有 txB，沒有 txA
    const remoteMid = parseFamilyLedgerFile(await storeA.download(configA.fileId));
    expect(remoteMid.records.transactions.map((t) => t.id)).toEqual([txB.id]);

    // A 再同步一次：A 本機仍有 txA，因「遠端缺這筆」會補上傳完整檔案
    const resA2 = await syncFamilyOnce({ database: dbA, store: storeA, fileId: configA.fileId });
    expect(resA2.uploaded).toBe(true);

    // B 再同步一次：拿到 txA，兩邊都有全部紀錄
    await syncFamilyOnce({ database: dbB, store: storeB, fileId: configB.fileId });

    const aIds = (await dbA.transactions.toArray()).map((t) => t.id).sort();
    const bIds = (await dbB.transactions.toArray()).map((t) => t.id).sort();
    expect(aIds).toEqual([txA.id, txB.id].sort());
    expect(bIds).toEqual([txA.id, txB.id].sort());
  });

  it('3. 刪除會傳播，且 lastEditedBy 是刪除者（原始 memberId 保留不變）', async () => {
    const rootStore = new MemoryFamilyDriveStore(USER_A);
    const storeA = rootStore;
    const storeB = rootStore.asUser(USER_B);

    const dbA = createIsolatedFamilyDb();
    const dbB = createIsolatedFamilyDb();

    const configA = await createFamilyLedger(
      { ledgerName: '家帳', myName: 'A', color: '#111111' },
      { store: storeA, database: dbA },
    );
    await inviteMember(USER_B.emailAddress, { store: storeA });
    const configB = await joinFamilyLedger(
      { myName: 'B', color: '#222222' },
      { store: storeB, database: dbB },
    );

    // A 新增一筆交易並同步給 B
    setFamilyConfig(configA);
    const txA = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 350,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '待刪除紀錄',
      },
      dbA,
    );
    await syncFamilyOnce({ database: dbA, store: storeA, fileId: configA.fileId });
    await syncFamilyOnce({ database: dbB, store: storeB, fileId: configB.fileId });

    // B 軟刪除該筆交易
    await new Promise((resolve) => setTimeout(resolve, 5));
    setFamilyConfig(configB);
    await softDeleteTransaction(txA.id, dbB);
    await syncFamilyOnce({ database: dbB, store: storeB, fileId: configB.fileId });

    // A 同步後看到 deleted=true 且 lastEditedBy 為 B，但 memberId 仍為 A
    await syncFamilyOnce({ database: dbA, store: storeA, fileId: configA.fileId });
    const aRecord = await dbA.transactions.get(txA.id);
    expect(aRecord?.deleted).toBe(true);
    expect(aRecord?.memberId).toBe(USER_A.permissionId);
    expect(aRecord?.lastEditedBy).toBe(USER_B.permissionId);
  });

  it('4. 同一筆兩人都改，updatedAt 較新者勝出，且保留原始 memberId', async () => {
    const rootStore = new MemoryFamilyDriveStore(USER_A);
    const storeA = rootStore;
    const storeB = rootStore.asUser(USER_B);

    const dbA = createIsolatedFamilyDb();
    const dbB = createIsolatedFamilyDb();

    const configA = await createFamilyLedger(
      { ledgerName: '家帳', myName: 'A', color: '#111111' },
      { store: storeA, database: dbA },
    );
    await inviteMember(USER_B.emailAddress, { store: storeA });
    const configB = await joinFamilyLedger(
      { myName: 'B', color: '#222222' },
      { store: storeB, database: dbB },
    );

    setFamilyConfig(configA);
    const txA = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 100,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '原版',
      },
      dbA,
    );
    await syncFamilyOnce({ database: dbA, store: storeA, fileId: configA.fileId });
    await syncFamilyOnce({ database: dbB, store: storeB, fileId: configB.fileId });

    // A 先改（較舊）
    await new Promise((resolve) => setTimeout(resolve, 5));
    setFamilyConfig(configA);
    await saveTransaction(
      {
        id: txA.id,
        kind: 'expense',
        date: '2026-11-28',
        amount: 150,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: 'A 改較舊',
      },
      dbA,
    );

    // B 晚一點改（updatedAt 較新）
    await new Promise((resolve) => setTimeout(resolve, 10));
    setFamilyConfig(configB);
    await saveTransaction(
      {
        id: txA.id,
        kind: 'expense',
        date: '2026-11-28',
        amount: 280,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: 'B 改較新',
      },
      dbB,
    );

    await syncFamilyOnce({ database: dbA, store: storeA, fileId: configA.fileId });
    await syncFamilyOnce({ database: dbB, store: storeB, fileId: configB.fileId });
    await syncFamilyOnce({ database: dbA, store: storeA, fileId: configA.fileId });

    const finalA = await dbA.transactions.get(txA.id);
    const finalB = await dbB.transactions.get(txA.id);
    expect(finalA?.amount).toBe(280);
    expect(finalA?.note).toBe('B 改較新');
    expect(finalA?.memberId).toBe(USER_A.permissionId);
    expect(finalA?.lastEditedBy).toBe(USER_B.permissionId);
    expect(finalB).toEqual(finalA);
  });

  it('5. download 403（例如被移除權限）會拋出 FamilyAccessLostError', async () => {
    const rootStore = new MemoryFamilyDriveStore(USER_A);
    const storeA = rootStore;
    const storeB = rootStore.asUser(USER_B);

    const dbA = createIsolatedFamilyDb();
    const dbB = createIsolatedFamilyDb();

    const configA = await createFamilyLedger(
      { ledgerName: '家帳', myName: 'A', color: '#111111' },
      { store: storeA, database: dbA },
    );
    await inviteMember(USER_B.emailAddress, { store: storeA });
    const configB = await joinFamilyLedger(
      { myName: 'B', color: '#222222' },
      { store: storeB, database: dbB },
    );

    setFamilyConfig(configA);
    await removeMember(USER_B.permissionId, { store: storeA, database: dbA });

    const membersAfterRemove = await getMembers(dbA);
    const removedB = membersAfterRemove.find((m) => m.id === USER_B.permissionId);
    expect(removedB?.removed).toBe(true);

    // B 再次同步時應得到 403 並拋出 FamilyAccessLostError
    await expect(
      syncFamilyOnce({ database: dbB, store: storeB, fileId: configB.fileId }),
    ).rejects.toThrow(FamilyAccessLostError);
  });

  it('6. 裝置設定：家庭模式下 savePinRecord / getPinRecord 預設讀寫 personalDb', async () => {
    // 模擬切換成家庭模式
    setFamilyConfig({
      fileId: 'file-123',
      ledgerName: '家帳',
      memberId: USER_A.permissionId,
      email: USER_A.emailAddress,
      role: 'owner',
      status: 'active',
      joinedAt: Date.now(),
    });
    setActiveLedger('family');
    expect(getActiveLedger()).toBe('family');
    expect(isFamilyReadOnly()).toBe(false);

    const pin = await hashPin('1357');
    await savePinRecord(pin);

    // 預設讀取 personalDb 應可讀到剛存的 PIN，且測試用的獨立家庭 DB 裡沒有該設定
    const loaded = await getPinRecord();
    expect(loaded).toEqual(pin);
    expect(await personalDb.meta.get(META_KEYS.UI_PIN_HASH)).toBeDefined();

    const separateFamilyDb = createIsolatedFamilyDb();
    expect(await getPinRecord(separateFamilyDb)).toBeNull();

    // 若狀態變為 removed，isFamilyReadOnly() 為 true
    setFamilyConfig({ ...getFamilyConfig()!, status: 'removed' });
    expect(isFamilyReadOnly()).toBe(true);

    // 清理 personalDb 測試資料
    await personalDb.meta.delete(META_KEYS.UI_PIN_HASH);
  });

  it('7. savePrivateTransactionFromFamily：同 id、同名對應、找不到時的退路三種情況', async () => {
    const familyDb = createIsolatedFamilyDb();
    const personalTestDb = createNamedDb('personal-target');
    await ensureSeeded(familyDb);
    await ensureSeeded(personalTestDb);

    // 在個人帳本建立自訂帳戶與分類（含子分類），以及地點
    const pAccCustom = await saveAccount(
      { name: '私房錢包', type: 'cash', initialBalance: 0 },
      personalTestDb,
    );
    const pParentCustom = await saveCategory(
      { name: '嗜好', icon: '🎨', kind: 'expense', parentId: null },
      personalTestDb,
    );
    const pChildCustom = await saveCategory(
      { name: '模型', icon: '🤖', kind: 'expense', parentId: pParentCustom.id },
      personalTestDb,
    );
    const pPlace = await savePlace({ name: '常去的店' }, personalTestDb);

    // 在家庭帳本建立不同 id 但同名的帳戶與子分類，及完全找不到對應的帳戶與分類
    const fAccSameName = await saveAccount(
      { name: '私房錢包', type: 'cash', initialBalance: 0 },
      familyDb,
    );
    const fAccUnknown = await saveAccount(
      { name: '家庭共用卡', type: 'credit', initialBalance: 0 },
      familyDb,
    );
    const fParentSameName = await saveCategory(
      { name: '嗜好', icon: '🎨', kind: 'expense', parentId: null },
      familyDb,
    );
    const fChildSameName = await saveCategory(
      { name: '模型', icon: '🤖', kind: 'expense', parentId: fParentSameName.id },
      familyDb,
    );
    const fCatUnknown = await saveCategory(
      { name: '小孩才藝', icon: '🎹', kind: 'expense', parentId: null },
      familyDb,
    );

    // 情境 A：同 id 存在且未刪除（預設 seed id）＋地點存在＋外幣／發票保留
    const savedSameId = await savePrivateTransactionFromFamily(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 310,
        currency: 'USD',
        originalAmount: 10,
        rate: 31,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        placeId: pPlace.id,
        invoiceNo: 'AB12345678',
        note: '同 ID',
      },
      familyDb,
      personalTestDb,
    );
    expect(savedSameId.accountId).toBe('seed-acc-cash');
    expect(savedSameId.categoryId).toBe('seed-cat-food-lunch');
    expect(savedSameId.placeId).toBe(pPlace.id);
    expect(savedSameId.currency).toBe('USD');
    expect(savedSameId.originalAmount).toBe(10);
    expect(savedSameId.rate).toBe(31);
    expect(savedSameId.invoiceNo).toBe('AB12345678');
    expect('memberId' in savedSameId).toBe(false);

    // 情境 B：不同 id 但同名帳戶＋同名父子分類
    const savedSameName = await savePrivateTransactionFromFamily(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 1200,
        accountId: fAccSameName.id,
        toAccountId: null,
        categoryId: fChildSameName.id,
        placeId: 'non-existent-place-id',
        note: '同名對應',
      },
      familyDb,
      personalTestDb,
    );
    expect(savedSameName.accountId).toBe(pAccCustom.id);
    expect(savedSameName.categoryId).toBe(pChildCustom.id);
    expect(savedSameName.placeId).toBeNull();

    // 情境 C：找不到對應時的退路（帳戶用第一個未封存帳戶、分類用該 kind 的「其他」）
    const savedFallback = await savePrivateTransactionFromFamily(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 500,
        accountId: fAccUnknown.id,
        toAccountId: null,
        categoryId: fCatUnknown.id,
        note: '退路對應',
      },
      familyDb,
      personalTestDb,
    );
    expect(savedFallback.accountId).toBe('seed-acc-cash');
    expect(savedFallback.categoryId).toBe('seed-cat-expense-other');
  });

  it('8. 個人帳本的紀錄不會出現 memberId 欄位；有 memberId 的預算不影響既有總預算計算', async () => {
    const personalTestDb = createNamedDb('personal-clean');
    await ensureSeeded(personalTestDb);

    // 即使目前有 familyConfig，只要不是 FAMILY_DB_NAME，stampMember 一律回傳 null
    setFamilyConfig({
      fileId: 'file-xyz',
      ledgerName: '家帳',
      memberId: USER_A.permissionId,
      email: USER_A.emailAddress,
      role: 'owner',
      status: 'active',
      joinedAt: Date.now(),
    });
    expect(stampMember(personalTestDb)).toBeNull();

    const pTx = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 500,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '個人消費',
      },
      personalTestDb,
    );
    expect('memberId' in pTx).toBe(false);
    expect('lastEditedBy' in pTx).toBe(false);
    expect((pTx as unknown as Record<string, unknown>).memberId).toBeUndefined();

    // 分期也不應有 memberId
    const pInst = await saveInstallmentTransactions(
      {
        kind: 'expense',
        date: '2026-11-28',
        amount: 3000,
        accountId: 'seed-acc-credit',
        toAccountId: null,
        categoryId: 'seed-cat-daily',
        note: '個人分期',
        installmentCount: 3,
      },
      personalTestDb,
    );
    expect(pInst.every((t) => !('memberId' in t) && !('lastEditedBy' in t))).toBe(true);

    // 成員預算測試：儲存總預算 20000，與兩位成員個人預算（各 8000）
    await saveBudget({ categoryId: null, amount: 20000 }, personalTestDb);
    const mbA = await saveMemberBudget(USER_A.permissionId, 8000, personalTestDb);
    const mbB = await saveMemberBudget(USER_B.permissionId, 6000, personalTestDb);
    expect(mbA?.id).toBe(`budget-member-${USER_A.permissionId}`);
    expect(mbA?.categoryId).toBeNull();
    expect(mbB?.memberId).toBe(USER_B.permissionId);

    // getBudgets 只回傳一般預算，不含成員預算；getMemberBudgets 回傳成員預算
    const regularBudgets = await getBudgets(personalTestDb);
    expect(regularBudgets).toHaveLength(1);
    expect(regularBudgets[0]?.amount).toBe(20000);

    const memberBudgets = await getMemberBudgets(personalTestDb);
    expect(memberBudgets).toHaveLength(2);

    // 就算直接把包含 memberId 的全部 budgets 傳入 computeBudgetStatus，總預算仍必須維持 20000
    const allBudgetRows = await personalTestDb.budgets.toArray();
    const categories = await personalTestDb.categories.toArray();
    const status = computeBudgetStatus(allBudgetRows, [pTx], categories, '2026-11-28');
    expect(status.total?.budget).toBe(20000);
    expect(status.total?.spent).toBe(500);
    expect(status.categories).toEqual([]);

    // 清除成員預算會軟刪除
    await saveMemberBudget(USER_A.permissionId, null, personalTestDb);
    expect(await getMemberBudgets(personalTestDb)).toHaveLength(1);
  });
});
