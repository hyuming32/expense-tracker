import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { convertToMain, formatRateDisplay, isValidRate } from '../domain/currency';
import { planCsvImport } from '../domain/csvImport';
import { ExpenseDatabase, META_KEYS, ensureSeeded } from './database';
import {
  archiveCurrency,
  exportBackupData,
  importCsvPlan,
  parseBackupPayload,
  recordShortcutTransaction,
  restoreBackupData,
  saveAccount,
  saveBudget,
  saveCurrency,
  saveRecurringRule,
  saveShortcut,
  saveTransaction,
  softDeleteCurrency,
  switchMainCurrency,
} from './repository';

describe('多幣別與匯率資料庫邏輯（v13）', () => {
  it('新增外幣帳更新最新匯率；編輯舊帳或修改最新匯率不改既有帳；使用中幣別只能封存不能刪除', async () => {
    const testDb = new ExpenseDatabase(`test-currency-rules-${Date.now()}`);
    await ensureSeeded(testDb);

    await saveCurrency({ code: 'JPY', name: '日圓', decimals: 0, rate: 0.21 }, testDb);

    // 1. 新增第一筆日圓帳（輸入新匯率 0.22）→ 更新 JPY 最新匯率為 0.22
    const tx1 = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 220,
        currency: 'JPY',
        originalAmount: 1000,
        rate: 0.22,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '第一筆日圓',
      },
      testDb,
    );
    expect((await testDb.currencies.get('JPY'))?.rate).toBe(0.22);
    expect((await testDb.outbox.get('currencies:JPY'))?.recordId).toBe('JPY');

    // 2. 使用中的幣別只能封存不能刪除
    await expect(softDeleteCurrency('JPY', testDb)).rejects.toThrow('僅可封存');
    await archiveCurrency('JPY', true, testDb);
    expect((await testDb.currencies.get('JPY'))?.archived).toBe(true);
    await archiveCurrency('JPY', false, testDb);

    // 3. 編輯舊帳改匯率為 0.25 → 只更新該筆 tx1.amount，不可改 currencies.JPY.rate
    const editedTx1 = await saveTransaction(
      {
        id: tx1.id,
        kind: 'expense',
        date: '2026-11-26',
        amount: 250,
        currency: 'JPY',
        originalAmount: 1000,
        rate: 0.25,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '第一筆日圓',
      },
      testDb,
    );
    expect(editedTx1.amount).toBe(250);
    expect((await testDb.currencies.get('JPY'))?.rate).toBe(0.22);

    // 4. 在設定頁改最新匯率為 0.23 → 不重算 tx1
    await saveCurrency({ code: 'JPY', name: '日圓', decimals: 0, rate: 0.23 }, testDb);
    expect((await testDb.currencies.get('JPY'))?.rate).toBe(0.23);
    expect((await testDb.transactions.get(tx1.id))?.amount).toBe(250);
    expect((await testDb.transactions.get(tx1.id))?.rate).toBe(0.25);

    // 5. 編輯該筆選回主幣別 → currency / originalAmount / rate 清除為 null
    const clearedTx = await saveTransaction(
      {
        id: tx1.id,
        kind: 'expense',
        date: '2026-11-26',
        amount: 300,
        currency: null,
        originalAmount: null,
        rate: null,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '改回台幣',
      },
      testDb,
    );
    expect(clearedTx.currency).toBeNull();
    expect(clearedTx.originalAmount).toBeNull();
    expect(clearedTx.rate).toBeNull();

    // 6. 未使用中的幣別可軟刪除
    await softDeleteCurrency('JPY', testDb);
    expect((await testDb.currencies.get('JPY'))?.deleted).toBe(true);

    await testDb.delete();
  });

  it('JSON 備份含 currencies 並可還原舊備份，切換主幣別單一交易寫入並排入 outbox', async () => {
    const testDb = new ExpenseDatabase(`test-currency-backup-${Date.now()}`);
    await ensureSeeded(testDb);

    await saveCurrency({ code: 'USD', name: '美元', decimals: 2, rate: 32 }, testDb);
    const acc = await saveAccount(
      { name: '美金預備', type: 'bank', initialBalance: 32000 },
      testDb,
    );
    await saveBudget({ categoryId: null, amount: 16000 }, testDb);
    await saveRecurringRule(
      {
        kind: 'expense',
        amount: 640,
        accountId: acc.id,
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '月費',
        frequency: 'monthly',
        dayOfMonth: 1,
        weekday: 1,
        monthOfYear: 1,
        startDate: '2026-11-01',
        endDate: null,
        paused: false,
        autoPost: true,
      },
      testDb,
    );
    await saveShortcut(
      {
        label: '早餐',
        icon: '🥐',
        kind: 'expense',
        amount: 160,
        accountId: acc.id,
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: null,
      },
      testDb,
    );
    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 160,
        accountId: acc.id,
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '台幣帳',
      },
      testDb,
    );

    const backup = await exportBackupData(testDb);
    expect(backup.currencies).toHaveLength(1);

    const restoreDb = new ExpenseDatabase(`test-currency-restore-${Date.now()}`);
    await ensureSeeded(restoreDb);
    const summary = await restoreBackupData(
      parseBackupPayload(JSON.parse(JSON.stringify(backup))),
      restoreDb,
    );
    expect(summary.currencies).toBe(1);
    expect((await restoreDb.currencies.get('USD'))?.rate).toBe(32);

    // 舊備份沒有 currencies 欄位也能正常還原
    const legacyRaw = JSON.parse(JSON.stringify(backup)) as Record<string, unknown>;
    delete legacyRaw.currencies;
    const legacyParsed = parseBackupPayload(legacyRaw);
    expect(legacyParsed.currencies).toEqual([]);
    const legacyDb = new ExpenseDatabase(`test-currency-legacy-${Date.now()}`);
    await ensureSeeded(legacyDb);
    const legacySummary = await restoreBackupData(legacyParsed, legacyDb);
    expect(legacySummary.currencies).toBe(0);

    // 切換主幣別為 USD（R=32）
    await testDb.outbox.clear();
    const switchResult = await switchMainCurrency(
      { newCode: 'USD', newName: '美元', newDecimals: 2, rate: 32 },
      testDb,
    );
    expect(switchResult.convertedTransactions).toBe(1);
    const usdRecord = await testDb.currencies.get('USD');
    const twdRecord = await testDb.currencies.get('TWD');
    expect(usdRecord?.isMain).toBe(true);
    expect(usdRecord?.rate).toBe(1);
    expect(twdRecord?.isMain).toBe(false);
    expect(twdRecord?.rate).toBe(1 / 32);
    expect((await testDb.accounts.get(acc.id))?.initialBalance).toBe(1000);
    expect((await testDb.budgets.get('budget-total'))?.amount).toBe(500);
    expect((await testDb.outbox.get('currencies:USD'))?.recordId).toBe('USD');
    expect((await testDb.outbox.get('currencies:TWD'))?.recordId).toBe('TWD');

    // TWD → USD (R=32) 後新增一筆 TWD 外幣帳，帶入最新匯率 0.03125，100 TWD 換算為 3.13 USD
    const fetchedTwd = await testDb.currencies.get('TWD');
    expect(fetchedTwd?.rate).toBe(0.03125);
    const convertedUsdAmount = convertToMain(100, fetchedTwd!.rate, 2);
    expect(convertedUsdAmount).toBe(3.13);
    const newTwdTx = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-27',
        amount: convertedUsdAmount,
        currency: 'TWD',
        originalAmount: 100,
        rate: fetchedTwd!.rate,
        accountId: acc.id,
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '切回前買飲料',
      },
      testDb,
    );
    expect(newTwdTx.amount).toBe(3.13);
    expect(newTwdTx.rate).toBe(0.03125);

    await testDb.delete();
    await restoreDb.delete();
    await legacyDb.delete();
  });

  it('編輯一筆 rate=1/30.5 的舊帳只改備註，存檔成功且 amount 與 rate 不變', async () => {
    const testDb = new ExpenseDatabase(`test-currency-long-rate-${Date.now()}`);
    await ensureSeeded(testDb);

    const exactRate = 1 / 30.5;
    expect(isValidRate(exactRate)).toBe(true);
    expect(formatRateDisplay(exactRate)).toBe('0.032786885');

    await saveCurrency({ code: 'USD', name: '美元', decimals: 2, rate: 30.5 }, testDb);
    const acc = (await testDb.accounts.toArray())[0]!;
    const originalTx = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-26',
        amount: 1000,
        accountId: acc.id,
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '原本備註',
      },
      testDb,
    );

    await switchMainCurrency(
      { newCode: 'USD', newName: '美元', newDecimals: 2, rate: 30.5 },
      testDb,
    );
    const switchedTx = await testDb.transactions.get(originalTx.id);
    expect(switchedTx?.rate).toBe(exactRate);
    expect(switchedTx?.amount).toBe(32.79);

    // 編輯舊帳僅修改備註，未動到匯率時原值存回
    const saved = await saveTransaction(
      {
        id: switchedTx!.id,
        kind: switchedTx!.kind,
        date: switchedTx!.date,
        amount: convertToMain(switchedTx!.originalAmount!, switchedTx!.rate!, 2),
        currency: switchedTx!.currency,
        originalAmount: switchedTx!.originalAmount,
        rate: switchedTx!.rate,
        accountId: switchedTx!.accountId,
        toAccountId: switchedTx!.toAccountId,
        categoryId: switchedTx!.categoryId,
        note: '更新後的備註',
      },
      testDb,
    );

    expect(saved.note).toBe('更新後的備註');
    expect(saved.amount).toBe(32.79);
    expect(saved.rate).toBe(exactRate);

    await testDb.delete();
  });

  it('CSV 匯入外幣列時會自動建立缺少的幣別紀錄並寫入 outbox', async () => {
    const testDb = new ExpenseDatabase(`test-currency-csv-import-${Date.now()}`);
    await ensureSeeded(testDb);
    await testDb.outbox.clear();

    const [accounts, categories, transactions] = await Promise.all([
      testDb.accounts.toArray(),
      testDb.categories.toArray(),
      testDb.transactions.toArray(),
    ]);

    const csv = [
      '日期,類型,金額,分類,子分類,帳戶,轉入帳戶,備註,發票號碼,幣別,原幣金額,匯率',
      '2026-11-27,支出,4558,飲食,午餐,現金,,拉麵,,JPY,21200,0.215',
    ].join('\n');

    const plan = planCsvImport(csv, { transactions, categories, accounts });
    expect(plan.errors).toEqual([]);
    const res = await importCsvPlan(plan, testDb);
    expect(res.importedCount).toBe(1);
    expect(res.createdCurrenciesCount).toBe(1);

    const jpy = await testDb.currencies.get('JPY');
    expect(jpy?.rate).toBe(0.215);
    expect((await testDb.outbox.get('currencies:JPY'))?.recordId).toBe('JPY');

    const txs = await testDb.transactions.toArray();
    expect(txs[0]).toMatchObject({
      amount: 4558,
      currency: 'JPY',
      originalAmount: 21200,
      rate: 0.215,
    });

    await testDb.delete();
  });

  it('LAST_CURRENCY 僅在新增且明確傳入 currency 時更新，編輯與捷徑記帳不覆蓋', async () => {
    const testDb = new ExpenseDatabase(`test-last-currency-${Date.now()}`);
    await ensureSeeded(testDb);
    await saveCurrency({ code: 'JPY', name: '日圓', decimals: 0, rate: 0.21 }, testDb);

    // 1. 一開始沒有記錄
    expect(await testDb.meta.get(META_KEYS.LAST_CURRENCY)).toBeUndefined();

    // 2. 新增日圓帳 → 記為 'JPY'
    const jpyTx = await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-27',
        amount: 210,
        currency: 'JPY',
        originalAmount: 1000,
        rate: 0.21,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '拉麵',
      },
      testDb,
    );
    expect((await testDb.meta.get(META_KEYS.LAST_CURRENCY))?.value).toBe('JPY');

    // 3. 新增主幣別帳（currency: null）→ 記為 ''
    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-27',
        amount: 100,
        currency: null,
        originalAmount: null,
        rate: null,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '便當',
      },
      testDb,
    );
    expect((await testDb.meta.get(META_KEYS.LAST_CURRENCY))?.value).toBe('');

    // 4. 編輯舊的日圓帳 → 仍是 ''
    await saveTransaction(
      {
        id: jpyTx.id,
        kind: 'expense',
        date: '2026-11-27',
        amount: 220,
        currency: 'JPY',
        originalAmount: 1000,
        rate: 0.22,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '拉麵加蛋',
      },
      testDb,
    );
    expect((await testDb.meta.get(META_KEYS.LAST_CURRENCY))?.value).toBe('');

    // 5. 再新增日圓帳 → 'JPY'
    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-11-27',
        amount: 420,
        currency: 'JPY',
        originalAmount: 2000,
        rate: 0.21,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: '藥妝',
      },
      testDb,
    );
    expect((await testDb.meta.get(META_KEYS.LAST_CURRENCY))?.value).toBe('JPY');

    // 6. 用 saveShortcut 建捷徑並 recordShortcutTransaction 記一筆 → 仍是 'JPY'
    const shortcut = await saveShortcut(
      {
        label: '早餐',
        icon: '🥐',
        kind: 'expense',
        amount: 65,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food',
        note: null,
      },
      testDb,
    );
    await recordShortcutTransaction(shortcut, '2026-11-27', testDb);
    expect((await testDb.meta.get(META_KEYS.LAST_CURRENCY))?.value).toBe('JPY');

    await testDb.delete();
  });
});
