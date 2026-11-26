import { useLiveQuery } from 'dexie-react-hooks';
import { db, META_KEYS } from '../db/database';
import type { Account, Category, Transaction } from '../db/types';

export interface LastUsedMeta {
  lastAccountId: string | null;
  lastExpenseCategoryId: string | null;
  lastIncomeCategoryId: string | null;
}

/**
 * 訂閱所有未刪除且未封存的帳戶（依 sortOrder 排序）。
 */
export function useActiveAccounts(): Account[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.accounts.orderBy('sortOrder').toArray();
      return rows.filter((a) => !a.deleted && !a.archived);
    }, []) ?? []
  );
}

/**
 * 訂閱所有未刪除的帳戶（包含已停用供設定頁與歷史紀錄顯示）。
 */
export function useAllAccounts(): Account[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.accounts.orderBy('sortOrder').toArray();
      return rows.filter((a) => !a.deleted);
    }, []) ?? []
  );
}

/**
 * 訂閱所有未刪除的分類（包含已封存供歷史紀錄顯示）。
 */
export function useAllCategories(): Category[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.categories.orderBy('sortOrder').toArray();
      return rows.filter((c) => !c.deleted);
    }, []) ?? []
  );
}

/**
 * 訂閱所有未刪除的交易紀錄（依日期與更新時間由新到舊排序）。
 */
export function useTransactions(): Transaction[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.transactions.toArray();
      return rows
        .filter((t) => !t.deleted)
        .sort((a, b) => {
          const dateCmp = b.date.localeCompare(a.date);
          return dateCmp !== 0 ? dateCmp : b.updatedAt - a.updatedAt;
        });
    }, []) ?? []
  );
}

/**
 * 訂閱最近一次使用的帳戶與分類設定。
 */
export function useLastUsedMeta(): LastUsedMeta {
  return (
    useLiveQuery(async () => {
      const [acc, expCat, incCat] = await Promise.all([
        db.meta.get(META_KEYS.LAST_ACCOUNT_ID),
        db.meta.get(META_KEYS.LAST_EXPENSE_CATEGORY_ID),
        db.meta.get(META_KEYS.LAST_INCOME_CATEGORY_ID),
      ]);
      return {
        lastAccountId: acc?.value ?? null,
        lastExpenseCategoryId: expCat?.value ?? null,
        lastIncomeCategoryId: incCat?.value ?? null,
      };
    }, []) ?? {
      lastAccountId: null,
      lastExpenseCategoryId: null,
      lastIncomeCategoryId: null,
    }
  );
}
