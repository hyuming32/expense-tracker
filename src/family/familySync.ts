import { db, type ExpenseDatabase, META_KEYS } from '../db/database';
import { processRecurringRules } from '../db/repository';
import type { BaseRecord } from '../db/types';
import { DriveApiError } from '../sync/driveStore';
import { mergeTableRecords } from '../sync/syncEngine';
import {
  collectAllRecords,
  FAMILY_LEDGER_FORMAT,
  FAMILY_LEDGER_VERSION,
  type FamilyLedgerFile,
  type FamilyLedgerRecords,
  parseFamilyLedgerFile,
} from './familyFile';
import type { FamilyDriveStore } from './familyStore';

/**
 * 家庭帳本存取權限遺失錯誤（例如已被建立者移除或檔案已遭刪除）。
 */
export class FamilyAccessLostError extends Error {
  constructor(message = '您已失去此家庭帳本的存取權限') {
    super(message);
    this.name = 'FamilyAccessLostError';
  }
}

export interface SyncFamilyOnceOptions {
  database?: ExpenseDatabase;
  store: FamilyDriveStore;
  fileId: string;
}

export interface SyncFamilyOnceResult {
  applied: number;
  uploaded: boolean;
}

function isLocalAhead<T extends BaseRecord>(local: T, remote: T | undefined): boolean {
  if (!remote) {
    return true;
  }
  if (local.updatedAt > remote.updatedAt) {
    return true;
  }
  if (local.updatedAt < remote.updatedAt) {
    return false;
  }
  return local.deviceId > remote.deviceId;
}

function hasAnyLocalAhead<T extends BaseRecord>(
  localRows: readonly T[],
  remoteRows: readonly T[],
): boolean {
  if (localRows.length === 0) {
    return false;
  }
  const remoteById = new Map<string, T>();
  for (const row of remoteRows) {
    remoteById.set(row.id, row);
  }
  for (const localRow of localRows) {
    if (isLocalAhead(localRow, remoteById.get(localRow.id))) {
      return true;
    }
  }
  return false;
}

function needsUploadComparedToRemote(
  localRecords: FamilyLedgerRecords,
  remoteRecords: FamilyLedgerRecords,
): boolean {
  return (
    hasAnyLocalAhead(localRecords.accounts, remoteRecords.accounts) ||
    hasAnyLocalAhead(localRecords.categories, remoteRecords.categories) ||
    hasAnyLocalAhead(localRecords.transactions, remoteRecords.transactions) ||
    hasAnyLocalAhead(localRecords.notePresets ?? [], remoteRecords.notePresets ?? []) ||
    hasAnyLocalAhead(localRecords.recurringRules ?? [], remoteRecords.recurringRules ?? []) ||
    hasAnyLocalAhead(localRecords.shortcuts ?? [], remoteRecords.shortcuts ?? []) ||
    hasAnyLocalAhead(localRecords.places ?? [], remoteRecords.places ?? []) ||
    hasAnyLocalAhead(localRecords.lotteryDraws ?? [], remoteRecords.lotteryDraws ?? []) ||
    hasAnyLocalAhead(localRecords.budgets ?? [], remoteRecords.budgets ?? []) ||
    hasAnyLocalAhead(localRecords.noSpendDays ?? [], remoteRecords.noSpendDays ?? []) ||
    hasAnyLocalAhead(localRecords.cards ?? [], remoteRecords.cards ?? []) ||
    hasAnyLocalAhead(localRecords.currencies ?? [], remoteRecords.currencies ?? []) ||
    hasAnyLocalAhead(localRecords.members, remoteRecords.members)
  );
}

/**
 * 執行一次家庭帳本同步：下載共用 JSON、逐筆最後修改為準合併、必要時上傳完整檔案並處理週期交易。
 */
export async function syncFamilyOnce(
  options: SyncFamilyOnceOptions,
): Promise<SyncFamilyOnceResult> {
  const database = options.database ?? db;
  const { store, fileId } = options;

  // 1. 下載並解析遠端共用 JSON 檔案
  let rawContent: string;
  try {
    rawContent = await store.download(fileId);
  } catch (err) {
    if (err instanceof DriveApiError && (err.status === 403 || err.status === 404)) {
      throw new FamilyAccessLostError();
    }
    throw err;
  }

  const parsedJson: unknown = JSON.parse(rawContent);
  const remoteFile = parseFamilyLedgerFile(parsedJson);
  const remoteRecords = remoteFile.records;

  // 2. 逐表合併進本機資料庫（僅遠端勝出時寫入）
  const applied = await database.transaction(
    'rw',
    [
      database.accounts,
      database.categories,
      database.transactions,
      database.notePresets,
      database.recurringRules,
      database.shortcuts,
      database.places,
      database.lotteryDraws,
      database.budgets,
      database.noSpendDays,
      database.cards,
      database.currencies,
      database.members,
    ],
    async () => {
      const [
        appliedAccounts,
        appliedCategories,
        appliedTransactions,
        appliedNotePresets,
        appliedRecurringRules,
        appliedShortcuts,
        appliedPlaces,
        appliedLotteryDraws,
        appliedBudgets,
        appliedNoSpendDays,
        appliedCards,
        appliedCurrencies,
        appliedMembers,
      ] = await Promise.all([
        mergeTableRecords(database.accounts, remoteRecords.accounts),
        mergeTableRecords(database.categories, remoteRecords.categories),
        mergeTableRecords(database.transactions, remoteRecords.transactions),
        mergeTableRecords(database.notePresets, remoteRecords.notePresets ?? []),
        mergeTableRecords(database.recurringRules, remoteRecords.recurringRules ?? []),
        mergeTableRecords(database.shortcuts, remoteRecords.shortcuts ?? []),
        mergeTableRecords(database.places, remoteRecords.places ?? []),
        mergeTableRecords(database.lotteryDraws, remoteRecords.lotteryDraws ?? []),
        mergeTableRecords(database.budgets, remoteRecords.budgets ?? []),
        mergeTableRecords(database.noSpendDays, remoteRecords.noSpendDays ?? []),
        mergeTableRecords(database.cards, remoteRecords.cards ?? []),
        mergeTableRecords(database.currencies, remoteRecords.currencies ?? []),
        mergeTableRecords(database.members, remoteRecords.members),
      ]);

      return (
        appliedAccounts.length +
        appliedCategories.length +
        appliedTransactions.length +
        appliedNotePresets.length +
        appliedRecurringRules.length +
        appliedShortcuts.length +
        appliedPlaces.length +
        appliedLotteryDraws.length +
        appliedBudgets.length +
        appliedNoSpendDays.length +
        appliedCards.length +
        appliedCurrencies.length +
        appliedMembers.length
      );
    },
  );

  // 3. 比對本機與遠端：只要本機有遠端沒有的紀錄，或本機版本勝出，就上傳完整檔案
  const localRecords = await collectAllRecords(database);
  const needUpload = needsUploadComparedToRemote(localRecords, remoteRecords);

  // 4. 若需要上傳則覆寫遠端共用檔案
  if (needUpload) {
    const nextFile: FamilyLedgerFile = {
      format: FAMILY_LEDGER_FORMAT,
      version: FAMILY_LEDGER_VERSION,
      ledgerName: remoteFile.ledgerName,
      updatedAt: Date.now(),
      records: localRecords,
    };
    try {
      await store.update(fileId, JSON.stringify(nextFile));
    } catch (err) {
      if (err instanceof DriveApiError && (err.status === 403 || err.status === 404)) {
        throw new FamilyAccessLostError();
      }
      throw err;
    }
  }

  // 5. 清空該資料庫的 outbox
  await database.outbox.clear();

  // 6. 記錄 family.lastSyncAt
  await database.meta.put({
    key: META_KEYS.FAMILY_LAST_SYNC_AT,
    value: String(Date.now()),
  });

  // 7. 最後處理到期週期性交易（固定 id，多人同時產生亦可合併成同一筆）
  await processRecurringRules(undefined, database);

  return { applied, uploaded: needUpload };
}
