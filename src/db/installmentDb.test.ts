import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ExpenseDatabase, ensureSeeded } from './database';
import {
  exportBackupData,
  parseBackupPayload,
  restoreBackupData,
  saveInstallmentTransactions,
  savePlace,
  saveTransaction,
  softDeleteInstallmentTransactions,
  updateInstallmentTransactions,
} from './repository';

describe('刷卡分期資料庫邏輯（v14）', () => {
  it('建立 3 期分期：產生 3 筆交易、共用 installmentId、outbox 3 筆、發票只在第 1 期、副作用只算一次', async () => {
    const testDb = new ExpenseDatabase(`test-inst-create-${Date.now()}`);
    await ensureSeeded(testDb);
    const place = await savePlace({ name: '百貨公司' }, testDb);
    await testDb.outbox.clear();

    const created = await saveInstallmentTransactions(
      {
        kind: 'expense',
        date: '2026-01-31',
        amount: 10000,
        accountId: 'seed-acc-credit',
        toAccountId: null,
        categoryId: 'seed-cat-daily',
        placeId: place.id,
        note: '吸塵器分期',
        tags: ['家電'],
        invoiceNo: 'ab12345678',
        installmentCount: 3,
      },
      testDb,
    );

    expect(created).toHaveLength(3);
    const installmentId = created[0]!.installmentId;
    expect(installmentId).toBeTruthy();
    expect(created.map((t) => t.amount)).toEqual([3334, 3333, 3333]);
    expect(created.map((t) => t.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(created.map((t) => t.installmentIndex)).toEqual([1, 2, 3]);
    expect(created.every((t) => t.installmentId === installmentId)).toBe(true);
    expect(created.every((t) => t.installmentCount === 3)).toBe(true);
    expect(created.every((t) => t.installmentTotal === 10000)).toBe(true);
    expect(created[0]!.invoiceNo).toBe('AB12345678');
    expect(created[1]!.invoiceNo).toBeUndefined();
    expect(created[2]!.invoiceNo).toBeUndefined();

    const txOutbox = await testDb.outbox.where('table').equals('transactions').toArray();
    expect(txOutbox).toHaveLength(3);

    const updatedPlace = await testDb.places.get(place.id);
    expect(updatedPlace?.useCount).toBe(1);

    const presets = await testDb.notePresets.filter((p) => !p.deleted).toArray();
    expect(presets).toHaveLength(1);
    expect(presets[0]?.useCount).toBe(1);

    await testDb.delete();
  });

  it('fromIndex=2 修改與刪除只影響第 2、3 期，且編輯單期後保留 installment 欄位', async () => {
    const testDb = new ExpenseDatabase(`test-inst-edit-${Date.now()}`);
    await ensureSeeded(testDb);

    const created = await saveInstallmentTransactions(
      {
        kind: 'expense',
        date: '2026-11-15',
        amount: 3000,
        accountId: 'seed-acc-credit',
        toAccountId: null,
        categoryId: 'seed-cat-daily',
        note: '筆電',
        tags: ['工作'],
        installmentCount: 3,
      },
      testDb,
    );
    const installmentId = created[0]!.installmentId!;

    await updateInstallmentTransactions(
      installmentId,
      2,
      {
        categoryId: 'seed-cat-entertainment',
        note: '筆電（已改）',
        tags: ['娛樂'],
      },
      testDb,
    );

    const afterUpdate = await testDb.transactions
      .where('installmentId')
      .equals(installmentId)
      .sortBy('installmentIndex');

    expect(afterUpdate[0]!.note).toBe('筆電');
    expect(afterUpdate[0]!.categoryId).toBe('seed-cat-daily');
    expect(afterUpdate[1]!.note).toBe('筆電（已改）');
    expect(afterUpdate[1]!.categoryId).toBe('seed-cat-entertainment');
    expect(afterUpdate[1]!.tags).toEqual(['娛樂']);
    expect(afterUpdate[2]!.note).toBe('筆電（已改）');

    // 編輯單期後，installment* 欄位必須保留
    const editedSingle = await saveTransaction(
      {
        id: afterUpdate[0]!.id,
        kind: 'expense',
        date: '2026-11-16',
        amount: 1200,
        accountId: 'seed-acc-credit',
        toAccountId: null,
        categoryId: 'seed-cat-daily',
        note: '第 1 期微調',
      },
      testDb,
    );
    expect(editedSingle.installmentId).toBe(installmentId);
    expect(editedSingle.installmentIndex).toBe(1);
    expect(editedSingle.installmentCount).toBe(3);
    expect(editedSingle.installmentTotal).toBe(3000);

    // fromIndex=2 軟刪除只刪第 2、3 期
    const deletedCount = await softDeleteInstallmentTransactions(installmentId, 2, testDb);
    expect(deletedCount).toBe(2);

    const afterDelete = await testDb.transactions
      .where('installmentId')
      .equals(installmentId)
      .sortBy('installmentIndex');
    expect(afterDelete[0]!.deleted).toBe(false);
    expect(afterDelete[1]!.deleted).toBe(true);
    expect(afterDelete[2]!.deleted).toBe(true);

    await testDb.delete();
  });

  it('外幣或非支出時拋錯，且 JSON 備份與還原保留分期欄位', async () => {
    const testDb = new ExpenseDatabase(`test-inst-err-${Date.now()}`);
    await ensureSeeded(testDb);

    await expect(
      saveInstallmentTransactions(
        {
          kind: 'expense',
          date: '2026-11-15',
          amount: 1000,
          currency: 'USD',
          originalAmount: 30,
          rate: 33.33,
          accountId: 'seed-acc-credit',
          toAccountId: null,
          categoryId: 'seed-cat-daily',
          note: '外幣測試',
          installmentCount: 3,
        },
        testDb,
      ),
    ).rejects.toThrow();

    await expect(
      saveInstallmentTransactions(
        {
          kind: 'income',
          date: '2026-11-15',
          amount: 1000,
          accountId: 'seed-acc-bank',
          toAccountId: null,
          categoryId: 'seed-cat-income-salary',
          note: '收入測試',
          installmentCount: 3,
        },
        testDb,
      ),
    ).rejects.toThrow();

    await saveInstallmentTransactions(
      {
        kind: 'expense',
        date: '2026-11-15',
        amount: 3000,
        accountId: 'seed-acc-credit',
        toAccountId: null,
        categoryId: 'seed-cat-daily',
        note: '備份測試',
        installmentCount: 3,
      },
      testDb,
    );

    const backup = await exportBackupData(testDb);
    expect(backup.schemaVersion).toBe(15);
    const parsed = parseBackupPayload(JSON.parse(JSON.stringify(backup)));
    expect(parsed.transactions[0]?.installmentId).toBeTruthy();
    expect(parsed.transactions[0]?.installmentCount).toBe(3);

    const targetDb = new ExpenseDatabase(`test-inst-restore-${Date.now()}`);
    await restoreBackupData(parsed, targetDb);
    const restored = await targetDb.transactions.toArray();
    expect(restored).toHaveLength(3);
    expect(restored.every((t) => Boolean(t.installmentId) && t.installmentCount === 3)).toBe(true);

    await testDb.delete();
    await targetDb.delete();
  });
});
