import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ExpenseDatabase, META_KEYS, ensureSeeded } from '../db/database';
import {
  saveAccount,
  saveCategory,
  saveTransaction,
  softDeleteTransaction,
} from '../db/repository';
import type { Transaction } from '../db/types';
import { MemoryDriveStore } from './driveStore';
import { mergeRecord } from './merge';
import { syncOnce } from './syncEngine';

const createdDbs: ExpenseDatabase[] = [];

function createTestDb(label: string): ExpenseDatabase {
  const database = new ExpenseDatabase(`test-sync-${label}-${Date.now()}-${Math.random()}`);
  createdDbs.push(database);
  return database;
}

afterEach(async () => {
  while (createdDbs.length > 0) {
    const database = createdDbs.pop();
    if (database) {
      await database.delete();
    }
  }
});

describe('mergeRecord', () => {
  const baseTx: Transaction = {
    id: 'tx-1',
    kind: 'expense',
    date: '2026-11-20',
    amount: 100,
    accountId: 'acc-1',
    toAccountId: null,
    categoryId: 'cat-1',
    note: '午餐',
    updatedAt: 1000,
    deviceId: 'device-a',
    deleted: false,
  };

  it('取 updatedAt 較大的紀錄', () => {
    const remote: Transaction = { ...baseTx, amount: 200, updatedAt: 2000, deviceId: 'device-b' };
    expect(mergeRecord(baseTx, remote)).toEqual(remote);
    expect(mergeRecord(remote, baseTx)).toEqual(remote);
  });

  it('updatedAt 相同時以 deviceId 字串較大者決勝', () => {
    const remoteHigher: Transaction = { ...baseTx, amount: 300, deviceId: 'device-b' };
    const remoteLower: Transaction = { ...baseTx, amount: 400, deviceId: 'device-0' };
    expect(mergeRecord(baseTx, remoteHigher)).toEqual(remoteHigher);
    expect(mergeRecord(baseTx, remoteLower)).toEqual(baseTx);
  });

  it('軟刪除會蓋掉較舊的未刪除紀錄', () => {
    const remoteDeleted: Transaction = {
      ...baseTx,
      deleted: true,
      updatedAt: 1500,
      deviceId: 'device-b',
    };
    const merged = mergeRecord(baseTx, remoteDeleted);
    expect(merged.deleted).toBe(true);
    expect(merged.updatedAt).toBe(1500);
  });
});

describe('syncOnce 雙裝置與快照同步', () => {
  it('兩個模擬裝置 A、B 各自記帳後輪流 syncOnce，最終兩邊資料完全一致', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('a');
    const dbB = createTestDb('b');

    const accA = await saveAccount(
      { name: '現金A', type: 'cash', initialBalance: 1000 },
      dbA,
    );
    const catA = await saveCategory(
      { name: '飲食A', icon: '🍜', kind: 'expense', parentId: null },
      dbA,
    );
    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 120,
        accountId: accA.id,
        toAccountId: null,
        categoryId: catA.id,
        note: 'A 的午餐',
      },
      dbA,
    );

    const accB = await saveAccount(
      { name: '銀行B', type: 'bank', initialBalance: 5000 },
      dbB,
    );
    await saveTransaction(
      {
        kind: 'income',
        date: '2026-11-26',
        amount: 3000,
        accountId: accB.id,
        toAccountId: null,
        categoryId: catA.id,
        note: 'B 的獎金',
      },
      dbB,
    );

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });

    const [aAccounts, bAccounts, aCats, bCats, aTxs, bTxs] = await Promise.all([
      dbA.accounts.orderBy('id').toArray(),
      dbB.accounts.orderBy('id').toArray(),
      dbA.categories.orderBy('id').toArray(),
      dbB.categories.orderBy('id').toArray(),
      dbA.transactions.orderBy('id').toArray(),
      dbB.transactions.orderBy('id').toArray(),
    ]);

    expect(aAccounts).toEqual(bAccounts);
    expect(aCats).toEqual(bCats);
    expect(aTxs).toEqual(bTxs);
    expect(aTxs).toHaveLength(2);
  });

  it('A 刪除一筆交易後，B 同步後該筆也成為 deleted，且合併不會產生新的 outbox 項目', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('del-a');
    const dbB = createTestDb('del-b');

    const tx = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 85,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: '飲料',
      },
      dbA,
    );

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    expect((await dbB.transactions.get(tx.id))?.deleted).toBe(false);
    expect(await dbB.outbox.count()).toBe(0);

    // 確保 updatedAt 嚴格大於前一筆
    await new Promise((resolve) => setTimeout(resolve, 5));
    await softDeleteTransaction(tx.id, dbA);
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    const bTx = await dbB.transactions.get(tx.id);
    expect(bTx?.deleted).toBe(true);
    expect(await dbB.outbox.count()).toBe(0);
  });

  it('新裝置 C 在快照產生後同步，能從快照加上後續變更得到完整資料', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('snap-a');
    const dbC = createTestDb('snap-c');

    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-24',
        amount: 100,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: '第一筆（將進入快照）',
      },
      dbA,
    );
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a', snapshotThreshold: 2 });

    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-25',
        amount: 200,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: '第二筆（將進入快照）',
      },
      dbA,
    );
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a', snapshotThreshold: 2 });

    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 300,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: '第三筆（觸發快照壓縮）',
      },
      dbA,
    );
    const compactResult = await syncOnce({
      database: dbA,
      driveStore: drive,
      deviceId: 'device-a',
      snapshotThreshold: 2,
    });
    expect(compactResult.compacted).toBe(true);

    // 快照產生後，A 又新增第四筆變更
    await saveTransaction(
      {
        kind: 'income',
        date: '2026-11-26',
        amount: 5000,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-2',
        note: '第四筆（快照後變更）',
      },
      dbA,
    );
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a', snapshotThreshold: 200 });

    // 全新裝置 C 同步
    const cResult = await syncOnce({ database: dbC, driveStore: drive, deviceId: 'device-c' });
    expect(cResult.usedSnapshot).toBe(true);
    expect(cResult.downloadedChanges).toBe(1);

    const cTxs = await dbC.transactions.toArray();
    expect(cTxs.map((t) => t.amount).sort((a, b) => a - b)).toEqual([100, 200, 300, 5000]);
    expect(await dbC.outbox.count()).toBe(0);
  });

  it('outbox 上傳失敗時保留項目，下次再試即可成功上傳', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('retry-a');

    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 55,
        accountId: 'acc-1',
        toAccountId: null,
        categoryId: 'cat-1',
        note: '重試測試',
      },
      dbA,
    );

    expect(await dbA.outbox.count()).toBe(1);
    drive.failNextUpload = true;

    await expect(
      syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' }),
    ).rejects.toThrow('模擬上傳失敗');

    // outbox 仍保留，localSeq 尚未寫入
    expect(await dbA.outbox.count()).toBe(1);
    expect(await dbA.meta.get(META_KEYS.SYNC_LOCAL_SEQ)).toBeUndefined();

    // 下次同步成功清掉 outbox 並更新 localSeq
    const result = await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    expect(result.uploadedCount).toBe(1);
    expect(await dbA.outbox.count()).toBe(0);
    expect((await dbA.meta.get(META_KEYS.SYNC_LOCAL_SEQ))?.value).toBe('1');
  });

  it('B 用預設「午餐」與「現金」記帳，同步到 A 後，A 能用該 categoryId 與 accountId 找到對應分類與帳戶', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('seed-sync-a');
    const dbB = createTestDb('seed-sync-b');

    await ensureSeeded(dbA);
    await ensureSeeded(dbB);

    const bCash = (await dbB.accounts.toArray()).find((a) => a.name === '現金');
    const bLunch = (await dbB.categories.toArray()).find((c) => c.name === '午餐');
    expect(bCash).toBeDefined();
    expect(bLunch).toBeDefined();

    const tx = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 135,
        accountId: bCash!.id,
        toAccountId: null,
        categoryId: bLunch!.id,
        note: 'B 吃的午餐',
      },
      dbB,
    );

    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });

    const aTx = await dbA.transactions.get(tx.id);
    expect(aTx).toBeDefined();

    const aMatchedAccount = await dbA.accounts.get(aTx!.accountId);
    const aMatchedCategory = aTx!.categoryId ? await dbA.categories.get(aTx!.categoryId) : undefined;

    expect(aMatchedAccount?.name).toBe('現金');
    expect(aMatchedCategory?.name).toBe('午餐');
  });
});
