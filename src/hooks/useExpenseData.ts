import { useLiveQuery } from 'dexie-react-hooks';
import { db, META_KEYS } from '../db/database';
import { getLastDriveBackupAt } from '../sync/driveBackup';
import {
  type AmountColors,
  DEFAULT_AMOUNT_COLORS,
  getAmountColors,
  getAutoAddNotePresets,
  getAutoSelectLastPlace,
  getPendingRecurringOccurrences,
  getReportPeriodKind,
  getSyncSchedule,
  type PendingRecurringOccurrence,
  type SyncSchedule,
} from '../db/repository';
import type {
  Account,
  Category,
  LotteryDraw,
  NotePreset,
  Place,
  RecurringRule,
  Shortcut,
  Transaction,
} from '../db/types';
import { compareTransactionsByDateTimeDesc, getTodayDateString, type PeriodKind } from '../domain';

export interface LastUsedMeta {
  lastAccountId: string | null;
  lastExpenseCategoryId: string | null;
  lastIncomeCategoryId: string | null;
  lastPlaceId: string | null;
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
      return rows.filter((t) => !t.deleted).sort(compareTransactionsByDateTimeDesc);
    }, []) ?? []
  );
}

/**
 * 訂閱最近一次使用的帳戶、分類與地點設定。
 */
export function useLastUsedMeta(): LastUsedMeta {
  return (
    useLiveQuery(async () => {
      const [acc, expCat, incCat, place] = await Promise.all([
        db.meta.get(META_KEYS.LAST_ACCOUNT_ID),
        db.meta.get(META_KEYS.LAST_EXPENSE_CATEGORY_ID),
        db.meta.get(META_KEYS.LAST_INCOME_CATEGORY_ID),
        db.meta.get(META_KEYS.LAST_PLACE_ID),
      ]);
      return {
        lastAccountId: acc?.value ?? null,
        lastExpenseCategoryId: expCat?.value ?? null,
        lastIncomeCategoryId: incCat?.value ?? null,
        lastPlaceId: place?.value ?? null,
      };
    }, []) ?? {
      lastAccountId: null,
      lastExpenseCategoryId: null,
      lastIncomeCategoryId: null,
      lastPlaceId: null,
    }
  );
}

/**
 * 訂閱本機金額顯示顏色設定（支出／收入）。
 */
export function useAmountColors(): AmountColors {
  return (
    useLiveQuery(async () => getAmountColors(db), []) ?? DEFAULT_AMOUNT_COLORS
  );
}

/**
 * 訂閱報表頁上次選擇的期間模式（月／季／年）。
 */
export function useReportPeriodKind(): PeriodKind {
  return useLiveQuery(async () => getReportPeriodKind(db), []) ?? 'month';
}

/**
 * 訂閱所有未刪除的常用備註（依 sortOrder 排序）。
 */
export function useNotePresets(): NotePreset[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.notePresets.orderBy('sortOrder').toArray();
      return rows.filter((p) => !p.deleted);
    }, []) ?? []
  );
}

/**
 * 訂閱是否啟用「自動加入常用備註」本機設定。
 */
export function useAutoAddNotePresets(): boolean {
  return useLiveQuery(async () => getAutoAddNotePresets(db), []) ?? true;
}

/**
 * 訂閱所有未刪除的週期性收支規則（依建立與更新排序）。
 */
export function useRecurringRules(): RecurringRule[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.recurringRules.toArray();
      return rows
        .filter((r) => !r.deleted)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }, []) ?? []
  );
}

/**
 * 訂閱尚未處理的待確認週期性收支項目（autoPost=false）。
 */
export function usePendingRecurringOccurrences(): PendingRecurringOccurrence[] {
  return (
    useLiveQuery(async () => {
      await db.recurringRules.count();
      await db.transactions.count();
      return getPendingRecurringOccurrences(getTodayDateString(), db);
    }, []) ?? []
  );
}

/**
 * 訂閱所有未刪除的首頁捷徑（依 sortOrder 排序）。
 */
export function useShortcuts(): Shortcut[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.shortcuts.orderBy('sortOrder').toArray();
      return rows.filter((s) => !s.deleted);
    }, []) ?? []
  );
}

/**
 * 訂閱所有未刪除的地點（依 sortOrder 排序）。
 */
export function usePlaces(): Place[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.places.orderBy('sortOrder').toArray();
      return rows.filter((p) => !p.deleted);
    }, []) ?? []
  );
}

/**
 * 訂閱是否啟用「新增記帳時自動帶入上次的地點」本機設定。
 */
export function useAutoSelectLastPlace(): boolean {
  return useLiveQuery(async () => getAutoSelectLastPlace(db), []) ?? false;
}

/**
 * 訂閱本機定時同步頻率設定（daily / weekly / none）。
 */
export function useSyncSchedule(): SyncSchedule {
  return useLiveQuery(async () => getSyncSchedule(db), []) ?? 'daily';
}

/**
 * 訂閱本機待同步 outbox 筆數。
 */
export function useOutboxCount(): number {
  return useLiveQuery(async () => db.outbox.count(), []) ?? 0;
}

/**
 * 訂閱本機記錄的上次備份到 Google Drive 時間戳記。
 */
export function useLastDriveBackupAt(): number | null {
  return useLiveQuery(async () => getLastDriveBackupAt(db), []) ?? null;
}

/**
 * 訂閱所有未刪除的發票開獎號碼（依期別由新到舊排序）。
 */
export function useLotteryDraws(): LotteryDraw[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.lotteryDraws.toArray();
      return rows.filter((d) => !d.deleted).sort((a, b) => b.period.localeCompare(a.period));
    }, []) ?? []
  );
}
