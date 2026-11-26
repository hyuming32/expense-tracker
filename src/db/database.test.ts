import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ExpenseDatabase, META_KEYS, ensureSeeded } from './database';

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
