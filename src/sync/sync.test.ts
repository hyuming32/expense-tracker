import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ExpenseDatabase, META_KEYS, ensureSeeded } from '../db/database';
import {
  bindSellerIdToPlace,
  getPendingRecurringOccurrences,
  processRecurringRules,
  saveAccount,
  saveBudget,
  saveCarrierCard,
  saveCategory,
  saveLotteryDraw,
  saveMemberCard,
  saveNotePreset,
  savePlace,
  saveRecurringRule,
  saveShortcut,
  saveTransaction,
  setNoSpendDay,
  skipRecurringOccurrence,
  softDeleteNotePreset,
  softDeleteShortcut,
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

    expect(await dbA.outbox.count()).toBe(2);
    drive.failNextUpload = true;

    await expect(
      syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' }),
    ).rejects.toThrow('模擬上傳失敗');

    // outbox 仍保留，localSeq 尚未寫入
    expect(await dbA.outbox.count()).toBe(2);
    expect(await dbA.meta.get(META_KEYS.SYNC_LOCAL_SEQ)).toBeUndefined();

    // 下次同步成功清掉 outbox 並更新 localSeq
    const result = await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    expect(result.uploadedCount).toBe(2);
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

  it('交易的 invoiceNo 會在雙裝置同步合併後完整保留', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('invoice-sync-a');
    const dbB = createTestDb('invoice-sync-b');

    const tx = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 240,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '超商購物',
        invoiceNo: 'EF11223344',
      },
      dbA,
    );

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    const syncedTx = await dbB.transactions.get(tx.id);
    expect(syncedTx?.invoiceNo).toBe('EF11223344');
  });

  it('常用備註（notePresets）的新增與軟刪除會在兩裝置同步後完全一致', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('preset-sync-a');
    const dbB = createTestDb('preset-sync-b');

    const presetA = await saveNotePreset({ text: 'A 常用備註', categoryId: 'seed-cat-food' }, dbA);
    const presetB = await saveNotePreset({ text: 'B 常用備註', categoryId: null }, dbB);

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });

    const [aPresets1, bPresets1] = await Promise.all([
      dbA.notePresets.orderBy('id').toArray(),
      dbB.notePresets.orderBy('id').toArray(),
    ]);
    expect(aPresets1).toEqual(bPresets1);
    expect(aPresets1).toHaveLength(2);

    // A 軟刪除 presetB 後再同步
    await new Promise((resolve) => setTimeout(resolve, 5));
    await softDeleteNotePreset(presetB.id, dbA);
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    expect((await dbB.notePresets.get(presetA.id))?.deleted).toBe(false);
    expect((await dbB.notePresets.get(presetB.id))?.deleted).toBe(true);
    expect(await dbB.outbox.count()).toBe(0);
  });

  it('兩台裝置各自依同一週期規則產生交易後同步，因決定性 id 不會重複產生', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('recurring-sync-a');
    const dbB = createTestDb('recurring-sync-b');

    const rule = await saveRecurringRule(
      {
        kind: 'expense',
        amount: 12000,
        accountId: 'seed-acc-bank',
        toAccountId: null,
        categoryId: 'seed-cat-housing',
        note: '房租',
        frequency: 'monthly',
        dayOfMonth: 5,
        weekday: 1,
        monthOfYear: 1,
        startDate: '2026-11-01',
        endDate: null,
        paused: false,
        autoPost: true,
      },
      dbA,
    );

    // 先將規則同步給 B
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    // A 與 B 各自在 2026-11-05 產生當期交易
    await processRecurringRules('2026-11-05', dbA);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await processRecurringRules('2026-11-05', dbB);

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });

    const aTxs = await dbA.transactions.filter((t) => !t.deleted).toArray();
    const bTxs = await dbB.transactions.filter((t) => !t.deleted).toArray();

    expect(aTxs).toHaveLength(1);
    expect(bTxs).toHaveLength(1);
    expect(aTxs[0]?.id).toBe(`rec-${rule.id}-2026-11-05`);
    expect(bTxs[0]?.id).toBe(`rec-${rule.id}-2026-11-05`);
  });

  it('裝置 A 略過待確認週期項目後同步到裝置 B，B 不會再顯示該期待確認', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('recurring-skip-a');
    const dbB = createTestDb('recurring-skip-b');

    const rule = await saveRecurringRule(
      {
        kind: 'expense',
        amount: 500,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-daily',
        note: '管理費',
        frequency: 'monthly',
        dayOfMonth: 10,
        weekday: 1,
        monthOfYear: 1,
        startDate: '2026-11-01',
        endDate: null,
        paused: false,
        autoPost: false,
      },
      dbA,
    );

    await skipRecurringOccurrence(rule, '2026-11-10', dbA);

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    const pendingOnB = await getPendingRecurringOccurrences('2026-11-26', dbB);
    expect(pendingOnB).toHaveLength(0);
  });

  it('首頁捷徑（shortcuts）的新增、更新與軟刪除會在兩裝置同步後完全一致', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('shortcut-a');
    const dbB = createTestDb('shortcut-b');

    const s1 = await saveShortcut(
      {
        label: '早餐',
        icon: '🥐',
        kind: 'expense',
        amount: 60,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-breakfast',
        note: null,
      },
      dbA,
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
        note: '拿鐵',
      },
      dbA,
    );

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    expect((await dbB.shortcuts.get(s1.id))?.amount).toBe(60);
    expect((await dbB.shortcuts.get(s2.id))?.label).toBe('咖啡');

    await softDeleteShortcut(s2.id, dbB);
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });

    expect((await dbA.shortcuts.get(s2.id))?.deleted).toBe(true);
    expect((await dbA.shortcuts.get(s1.id))?.deleted).toBe(false);
  });

  it('地點清單與統編綁定／移轉會在兩裝置同步後完全一致', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('place-a');
    const dbB = createTestDb('place-b');

    const p1 = await savePlace({ name: '公司附近', sellerIds: ['12345678'] }, dbA);
    const p2 = await savePlace({ name: '住家巷口', icon: '🏠' }, dbA);

    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        time: '12:30',
        amount: 150,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        placeId: p1.id,
        note: '午餐',
      },
      dbA,
    );

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    const bP1 = await dbB.places.get(p1.id);
    const bP2 = await dbB.places.get(p2.id);
    expect(bP1?.name).toBe('公司附近');
    expect(bP1?.useCount).toBe(1);
    expect(bP1?.sellerIds).toEqual(['12345678']);
    expect(bP2?.name).toBe('住家巷口');

    // 裝置 B 將統編移轉綁定至 p2，同步回裝置 A 後兩邊一致
    await bindSellerIdToPlace(p2.id, '12345678', dbB);
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });

    expect((await dbA.places.get(p1.id))?.sellerIds ?? []).toEqual([]);
    expect((await dbA.places.get(p2.id))?.sellerIds).toEqual(['12345678']);
  });

  it('兩台裝置輸入同一期 lotteryDraws 會以固定 id 互相覆蓋而非重複', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('lottery-a');
    const dbB = createTestDb('lottery-b');

    await saveLotteryDraw(
      {
        period: '2026-09',
        special: '11111111',
        grand: '22222222',
        first: ['33333333', '44444444', '55555555'],
        extraSixth: [],
      },
      dbA,
    );
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    expect((await dbB.lotteryDraws.get('draw-2026-09'))?.special).toBe('11111111');

    // 裝置 B 修改同一期並同步回 A
    await saveLotteryDraw(
      {
        period: '2026-09',
        special: '99999999',
        grand: '22222222',
        first: ['33333333', '44444444', '55555555'],
        extraSixth: ['777'],
      },
      dbB,
    );
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });

    expect(await dbA.lotteryDraws.count()).toBe(1);
    const drawOnA = await dbA.lotteryDraws.get('draw-2026-09');
    expect(drawOnA?.special).toBe('99999999');
    expect(drawOnA?.extraSixth).toEqual(['777']);
  });

  it('兩台裝置同步同一分類預算會以固定 id 互相覆蓋而非重複', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('budget-a');
    const dbB = createTestDb('budget-b');

    await saveBudget({ categoryId: null, amount: 25000 }, dbA);
    await saveBudget({ categoryId: 'seed-cat-food', amount: 6000 }, dbA);
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    expect((await dbB.budgets.get('budget-total'))?.amount).toBe(25000);
    expect((await dbB.budgets.get('budget-seed-cat-food'))?.amount).toBe(6000);

    // 裝置 B 修改同一分類預算並同步回 A
    await saveBudget({ categoryId: 'seed-cat-food', amount: 9000 }, dbB);
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });

    expect(await dbA.budgets.count()).toBe(2);
    expect((await dbA.budgets.get('budget-seed-cat-food'))?.amount).toBe(9000);
  });

  it('交易的 tags 會在雙裝置同步合併後完整保留', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('tags-a');
    const dbB = createTestDb('tags-b');

    const saved = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 1200,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-dinner',
        note: '拉麵',
        tags: ['日本旅遊', '可報帳'],
      },
      dbA,
    );

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    const synced = await dbB.transactions.get(saved.id);
    expect(synced?.tags).toEqual(['日本旅遊', '可報帳']);
  });

  it('兩台裝置同步同一天的沒花錢標記會以固定 id 互相覆蓋而非重複', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('nospend-a');
    const dbB = createTestDb('nospend-b');

    await setNoSpendDay('2026-11-24', true, dbA);
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    expect(await dbB.noSpendDays.count()).toBe(1);
    expect((await dbB.noSpendDays.get('nospend-2026-11-24'))?.deleted).toBe(false);

    // 裝置 B 在同一天也標記或取消標記並同步回 A，不會產生重複紀錄
    await setNoSpendDay('2026-11-24', false, dbB);
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });

    expect(await dbA.noSpendDays.count()).toBe(1);
    expect((await dbA.noSpendDays.get('nospend-2026-11-24'))?.deleted).toBe(true);
  });

  it('A 裝置記 3 筆並同步，全新 B 裝置同步後回報帶進 3 筆交易', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('restore-a');
    const dbB = createTestDb('restore-b');

    await ensureSeeded(dbA);
    await ensureSeeded(dbB);

    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-24',
        amount: 80,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-breakfast',
        note: '蛋餅',
      },
      dbA,
    );
    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-25',
        amount: 150,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        note: '便當',
      },
      dbA,
    );
    await saveTransaction(
      {
        kind: 'income',
        date: '2026-11-26',
        amount: 30000,
        accountId: 'seed-acc-bank',
        toAccountId: null,
        categoryId: 'seed-cat-income-salary',
        note: '薪水',
      },
      dbA,
    );
    const deletedTx = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 99,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-snack',
        note: '已刪除',
      },
      dbA,
    );
    await softDeleteTransaction(deletedTx.id, dbA);

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    const resultB = await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });

    expect(resultB.appliedTransactionsCount).toBe(3);

    const secondSyncB = await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    expect(secondSyncB.appliedTransactionsCount).toBe(0);
  });

  it('兩台裝置各自設定載具並同步，因固定 id card-carrier 不會重複', async () => {
    const drive = new MemoryDriveStore();
    const dbA = createTestDb('cards-a');
    const dbB = createTestDb('cards-b');

    await saveCarrierCard('/AAA1111', dbA);
    await new Promise((r) => setTimeout(r, 5));
    await saveCarrierCard('/BBB2222', dbB);
    await saveMemberCard({ name: '7-11', code: '7110001' }, dbA);

    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });
    await syncOnce({ database: dbB, driveStore: drive, deviceId: 'device-b' });
    await syncOnce({ database: dbA, driveStore: drive, deviceId: 'device-a' });

    const cardsA = (await dbA.cards.toArray()).filter((c) => !c.deleted);
    const cardsB = (await dbB.cards.toArray()).filter((c) => !c.deleted);
    expect(cardsA.filter((c) => c.type === 'carrier')).toHaveLength(1);
    expect(cardsB.filter((c) => c.type === 'carrier')).toHaveLength(1);
    expect(cardsA.find((c) => c.id === 'card-carrier')?.code).toBe('/BBB2222');
    expect(cardsB.find((c) => c.id === 'card-carrier')?.code).toBe('/BBB2222');
    expect(cardsA).toHaveLength(2);
    expect(cardsB).toHaveLength(2);
  });
});
