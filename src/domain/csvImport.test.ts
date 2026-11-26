import { describe, expect, it } from 'vitest';
import type { Account, Category, Transaction } from '../db/types';
import { toCsv } from './backup';
import { planCsvImport } from './csvImport';

const baseAccounts: Account[] = [
  {
    id: 'acc-cash',
    name: '現金',
    type: 'cash',
    initialBalance: 0,
    archived: false,
    sortOrder: 1,
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted: false,
  },
  {
    id: 'acc-bank',
    name: '銀行帳戶',
    type: 'bank',
    initialBalance: 10000,
    archived: false,
    sortOrder: 2,
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted: false,
  },
];

const baseCategories: Category[] = [
  {
    id: 'cat-food',
    name: '飲食',
    icon: '🍜',
    kind: 'expense',
    parentId: null,
    sortOrder: 1,
    archived: false,
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted: false,
  },
  {
    id: 'cat-lunch',
    name: '午餐',
    icon: '🍱',
    kind: 'expense',
    parentId: 'cat-food',
    sortOrder: 1,
    archived: false,
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted: false,
  },
  {
    id: 'cat-salary',
    name: '薪資',
    icon: '💰',
    kind: 'income',
    parentId: null,
    sortOrder: 1,
    archived: false,
    updatedAt: 1000,
    deviceId: 'dev-1',
    deleted: false,
  },
];

describe('planCsvImport', () => {
  it('toCsv 匯出後再由 planCsvImport 解析，資料完全一致（來回測試）', () => {
    const txs: Transaction[] = [
      {
        id: 'tx-1',
        kind: 'expense',
        date: '2026-11-20',
        amount: 185,
        accountId: 'acc-cash',
        toAccountId: null,
        categoryId: 'cat-lunch',
        note: '牛肉麵, 加蛋\n"特大碗"',
        invoiceNo: 'AB12345678',
        updatedAt: 2000,
        deviceId: 'dev-1',
        deleted: false,
      },
      {
        id: 'tx-2',
        kind: 'income',
        date: '2026-11-19',
        amount: 50000,
        accountId: 'acc-bank',
        toAccountId: null,
        categoryId: 'cat-salary',
        note: null,
        updatedAt: 1500,
        deviceId: 'dev-1',
        deleted: false,
      },
      {
        id: 'tx-3',
        kind: 'transfer',
        date: '2026-11-18',
        amount: 3000,
        accountId: 'acc-bank',
        toAccountId: 'acc-cash',
        categoryId: null,
        note: '領現',
        updatedAt: 1200,
        deviceId: 'dev-1',
        deleted: false,
      },
    ];

    const csv = toCsv(txs, baseCategories, baseAccounts);
    const plan = planCsvImport(csv, {
      transactions: [],
      categories: baseCategories,
      accounts: baseAccounts,
    });

    expect(plan.errors).toEqual([]);
    expect(plan.skippedDuplicates).toBe(0);
    expect(plan.newAccounts).toEqual([]);
    expect(plan.newCategories).toEqual([]);
    expect(plan.items).toEqual([
      {
        rowNumber: 2,
        kind: 'expense',
        date: '2026-11-20',
        time: null,
        amount: 185,
        accountName: '現金',
        toAccountName: null,
        categoryName: '飲食',
        subCategoryName: '午餐',
        placeName: null,
        note: '牛肉麵, 加蛋\n"特大碗"',
        invoiceNo: 'AB12345678',
      },
      {
        rowNumber: 4,
        kind: 'income',
        date: '2026-11-19',
        time: null,
        amount: 50000,
        accountName: '銀行帳戶',
        toAccountName: null,
        categoryName: '薪資',
        subCategoryName: '',
        placeName: null,
        note: null,
        invoiceNo: null,
      },
      {
        rowNumber: 5,
        kind: 'transfer',
        date: '2026-11-18',
        time: null,
        amount: 3000,
        accountName: '銀行帳戶',
        toAccountName: '現金',
        categoryName: '',
        subCategoryName: '',
        placeName: null,
        note: '領現',
        invoiceNo: null,
      },
    ]);
  });

  it('正確處理 BOM、引號、逗號與欄位內換行，以及無發票號碼欄的舊格式', () => {
    const legacyCsv =
      '\uFEFF日期,類型,金額,分類,子分類,帳戶,轉入帳戶,備註\r\n' +
      '2026-11-21,支出,120,飲食,午餐,現金,,"咖啡, 麵包\r\n""外帶"""\r\n';

    const plan = planCsvImport(legacyCsv, {
      transactions: [],
      categories: baseCategories,
      accounts: baseAccounts,
    });

    expect(plan.errors).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      rowNumber: 2,
      kind: 'expense',
      date: '2026-11-21',
      amount: 120,
      categoryName: '飲食',
      subCategoryName: '午餐',
      accountName: '現金',
      note: '咖啡, 麵包\n"外帶"',
      invoiceNo: null,
    });
  });

  it('未知分類、子分類與帳戶會列入將新建清單且自動去重', () => {
    const csv = [
      '日期,類型,金額,分類,子分類,帳戶,轉入帳戶,備註,發票號碼',
      '2026-11-21,支出,350,寵物,飼料,悠遊卡,,貓糧,',
      '2026-11-22,支出,200,寵物,玩具,悠遊卡,,逗貓棒,',
      '2026-11-23,轉帳,1000,,,現金,郵局,存款,',
    ].join('\n');

    const plan = planCsvImport(csv, {
      transactions: [],
      categories: baseCategories,
      accounts: baseAccounts,
    });

    expect(plan.errors).toEqual([]);
    expect(plan.items).toHaveLength(3);
    expect(plan.newAccounts).toEqual([
      { name: '悠遊卡', type: 'cash' },
      { name: '郵局', type: 'cash' },
    ]);
    expect(plan.newCategories).toEqual([
      { kind: 'expense', name: '寵物', parentName: null },
      { kind: 'expense', name: '飼料', parentName: '寵物' },
      { kind: 'expense', name: '玩具', parentName: '寵物' },
    ]);
  });

  it('同內容或同發票號碼的未刪除交易會視為重複並略過（已刪除交易不擋匯入）', () => {
    const existingTxs: Transaction[] = [
      {
        id: 'tx-active',
        kind: 'expense',
        date: '2026-11-20',
        amount: 100,
        accountId: 'acc-cash',
        toAccountId: null,
        categoryId: 'cat-lunch',
        note: '便當',
        invoiceNo: 'CD99887766',
        updatedAt: 1000,
        deviceId: 'dev-1',
        deleted: false,
      },
      {
        id: 'tx-deleted',
        kind: 'expense',
        date: '2026-11-19',
        amount: 90,
        accountId: 'acc-cash',
        toAccountId: null,
        categoryId: 'cat-lunch',
        note: '已刪便當',
        invoiceNo: 'EF11223344',
        updatedAt: 1000,
        deviceId: 'dev-1',
        deleted: true,
      },
    ];

    const csv = [
      '日期,類型,金額,分類,子分類,帳戶,轉入帳戶,備註,發票號碼',
      // 完全相同
      '2026-11-20,支出,100,飲食,午餐,現金,,便當,',
      // 發票號碼相同（即使金額不同）
      '2026-11-21,支出,250,飲食,午餐,現金,,不同備註,cd99887766',
      // 對應已刪除紀錄，不應略過
      '2026-11-19,支出,90,飲食,午餐,現金,,已刪便當,EF11223344',
      // 同一份 CSV 內重複列
      '2026-11-19,支出,90,飲食,午餐,現金,,已刪便當,EF11223344',
    ].join('\n');

    const plan = planCsvImport(csv, {
      transactions: existingTxs,
      categories: baseCategories,
      accounts: baseAccounts,
    });

    expect(plan.errors).toEqual([]);
    expect(plan.skippedDuplicates).toBe(3);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.date).toBe('2026-11-19');
  });

  it('錯誤列（金額非數字、日期錯誤、類型未知）會回報正確行號與原因', () => {
    const csv = [
      '日期,類型,金額,分類,子分類,帳戶,轉入帳戶,備註,發票號碼',
      '2026-11-20,支出,abc,飲食,午餐,現金,,金額錯,',
      '2026-02-30,支出,100,飲食,午餐,現金,,日期錯,',
      '2026-11-20,借貸,100,飲食,午餐,現金,,類型錯,',
      '2026-11-20,支出,150,飲食,午餐,現金,,正常列,',
    ].join('\n');

    const plan = planCsvImport(csv, {
      transactions: [],
      categories: baseCategories,
      accounts: baseAccounts,
    });

    expect(plan.items).toHaveLength(1);
    expect(plan.errors).toEqual([
      { rowNumber: 2, reason: '金額需為正整數' },
      { rowNumber: 3, reason: '日期格式錯誤（需為 YYYY-MM-DD）' },
      { rowNumber: 4, reason: '類型未知（需為 支出／收入／轉帳）' },
    ]);
  });

  it('CSV 新格式含時間與地點來回一致，未知地點列入將新建清單', () => {
    const places = [
      {
        id: 'pl-1',
        name: '公司附近',
        icon: '📍',
        useCount: 2,
        lastUsedAt: 1000,
        sortOrder: 1,
        archived: false,
        updatedAt: 1000,
        deviceId: 'dev-1',
        deleted: false,
      },
    ];
    const txs: Transaction[] = [
      {
        id: 'tx-place-1',
        kind: 'expense',
        date: '2026-11-26',
        time: '12:30',
        amount: 150,
        accountId: 'acc-cash',
        toAccountId: null,
        categoryId: 'cat-lunch',
        placeId: 'pl-1',
        note: '便當',
        updatedAt: 1000,
        deviceId: 'dev-1',
        deleted: false,
      },
    ];

    const exported = toCsv(txs, baseCategories, baseAccounts, places);
    const roundtripPlan = planCsvImport(exported, {
      transactions: [],
      categories: baseCategories,
      accounts: baseAccounts,
      places,
    });
    expect(roundtripPlan.errors).toEqual([]);
    expect(roundtripPlan.newPlaces).toEqual([]);
    expect(roundtripPlan.items[0]).toMatchObject({
      date: '2026-11-26',
      time: '12:30',
      placeName: '公司附近',
      amount: 150,
    });

    const withNewPlaceCsv = [
      '日期,時間,類型,金額,分類,子分類,帳戶,轉入帳戶,地點,備註,發票號碼',
      '2026-11-26,18:45,支出,220,飲食,午餐,現金,,新地點店,晚餐,',
      '2026-11-26,19:00,支出,80,飲食,午餐,現金,,新地點店,飲料,',
    ].join('\n');
    const newPlacePlan = planCsvImport(withNewPlaceCsv, {
      transactions: [],
      categories: baseCategories,
      accounts: baseAccounts,
      places,
    });
    expect(newPlacePlan.errors).toEqual([]);
    expect(newPlacePlan.newPlaces).toEqual(['新地點店']);
  });
});
