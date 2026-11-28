import { db, type ExpenseDatabase } from '../db/database';
import type {
  Account,
  Budget,
  Category,
  CurrencyRate,
  LotteryDraw,
  Member,
  NoSpendDay,
  NotePreset,
  Place,
  RecurringRule,
  Shortcut,
  Transaction,
  WalletCard,
} from '../db/types';
import type { SyncRecordsPayload } from '../sync/syncEngine';

export const FAMILY_LEDGER_FORMAT = 'fun2young-family-ledger' as const;
export const FAMILY_LEDGER_VERSION = 1 as const;

export interface FamilyLedgerRecords extends SyncRecordsPayload {
  members: Member[];
}

export interface FamilyLedgerFile {
  format: 'fun2young-family-ledger';
  version: 1;
  ledgerName: string;
  updatedAt: number;
  records: FamilyLedgerRecords;
}

function assertOptionalRecordArray<T>(
  records: Record<string, unknown>,
  key: string,
): T[] {
  const value = records[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`家庭帳本檔案欄位「${key}」格式不正確`);
  }
  return value as T[];
}

/**
 * 驗證並解析家庭帳本共用 JSON 檔案，格式錯誤時拋出繁體中文錯誤訊息。
 */
export function parseFamilyLedgerFile(raw: unknown): FamilyLedgerFile {
  let target: unknown = raw;
  if (typeof raw === 'string') {
    try {
      target = JSON.parse(raw);
    } catch {
      throw new Error('家庭帳本檔案不是有效的 JSON 格式');
    }
  }

  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    throw new Error('家庭帳本檔案格式不正確');
  }

  const obj = target as Record<string, unknown>;
  if (obj.format !== FAMILY_LEDGER_FORMAT) {
    throw new Error('這不是有效的 Fun2young 家庭帳本檔案');
  }
  if (obj.version !== FAMILY_LEDGER_VERSION) {
    throw new Error('不支援的家庭帳本檔案版本');
  }
  if (typeof obj.ledgerName !== 'string' || obj.ledgerName.trim().length === 0) {
    throw new Error('家庭帳本檔案缺少帳本名稱');
  }
  if (typeof obj.updatedAt !== 'number' || !Number.isFinite(obj.updatedAt)) {
    throw new Error('家庭帳本檔案缺少有效的更新時間');
  }
  if (typeof obj.records !== 'object' || obj.records === null || Array.isArray(obj.records)) {
    throw new Error('家庭帳本檔案缺少資料紀錄區段');
  }

  const rec = obj.records as Record<string, unknown>;
  if (
    !Array.isArray(rec.accounts) ||
    !Array.isArray(rec.categories) ||
    !Array.isArray(rec.transactions) ||
    !Array.isArray(rec.members)
  ) {
    throw new Error('家庭帳本檔案缺少必要的資料表');
  }

  return {
    format: FAMILY_LEDGER_FORMAT,
    version: FAMILY_LEDGER_VERSION,
    ledgerName: obj.ledgerName.trim(),
    updatedAt: obj.updatedAt,
    records: {
      accounts: rec.accounts as Account[],
      categories: rec.categories as Category[],
      transactions: rec.transactions as Transaction[],
      notePresets: assertOptionalRecordArray<NotePreset>(rec, 'notePresets'),
      recurringRules: assertOptionalRecordArray<RecurringRule>(rec, 'recurringRules'),
      shortcuts: assertOptionalRecordArray<Shortcut>(rec, 'shortcuts'),
      places: assertOptionalRecordArray<Place>(rec, 'places'),
      lotteryDraws: assertOptionalRecordArray<LotteryDraw>(rec, 'lotteryDraws'),
      budgets: assertOptionalRecordArray<Budget>(rec, 'budgets'),
      noSpendDays: assertOptionalRecordArray<NoSpendDay>(rec, 'noSpendDays'),
      cards: assertOptionalRecordArray<WalletCard>(rec, 'cards'),
      currencies: assertOptionalRecordArray<CurrencyRate>(rec, 'currencies'),
      members: rec.members as Member[],
    },
  };
}

/**
 * 蒐集家庭帳本資料庫中所有同步表的全部列（包含已軟刪除的墓碑紀錄）。
 */
export async function collectAllRecords(
  database: ExpenseDatabase = db,
): Promise<FamilyLedgerRecords> {
  const [
    accounts,
    categories,
    transactions,
    notePresets,
    recurringRules,
    shortcuts,
    places,
    lotteryDraws,
    budgets,
    noSpendDays,
    cards,
    currencies,
    members,
  ] = await Promise.all([
    database.accounts.toArray(),
    database.categories.toArray(),
    database.transactions.toArray(),
    database.notePresets.toArray(),
    database.recurringRules.toArray(),
    database.shortcuts.toArray(),
    database.places.toArray(),
    database.lotteryDraws.toArray(),
    database.budgets.toArray(),
    database.noSpendDays.toArray(),
    database.cards.toArray(),
    database.currencies.toArray(),
    database.members.toArray(),
  ]);

  return {
    accounts,
    categories,
    transactions,
    notePresets,
    recurringRules,
    shortcuts,
    places,
    lotteryDraws,
    budgets,
    noSpendDays,
    cards,
    currencies,
    members,
  };
}
