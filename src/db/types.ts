export interface BaseRecord {
  id: string;
  updatedAt: number;
  deviceId: string;
  deleted: boolean;
}

export type AccountType = 'cash' | 'bank' | 'credit';

export interface Account extends BaseRecord {
  name: string;
  type: AccountType;
  /** 初始餘額（整數，新台幣元） */
  initialBalance: number;
  archived: boolean;
  sortOrder: number;
}

export type CategoryKind = 'expense' | 'income';

export interface Category extends BaseRecord {
  name: string;
  icon: string;
  kind: CategoryKind;
  parentId: string | null;
  sortOrder: number;
  archived: boolean;
}

export type TransactionKind = 'expense' | 'income' | 'transfer';

export interface Transaction extends BaseRecord {
  kind: TransactionKind;
  /** 本地日期字串 YYYY-MM-DD */
  date: string;
  /** 本地時間字串 HH:mm（選填，可空） */
  time?: string | null;
  /** 正整數（新台幣元） */
  amount: number;
  accountId: string;
  /** 僅轉帳使用 */
  toAccountId: string | null;
  /** 轉帳時為 null */
  categoryId: string | null;
  /** 地點識別碼（選填，可空） */
  placeId?: string | null;
  note: string | null;
  /** 電子發票字軌號碼（選填，例如 AB12345678） */
  invoiceNo?: string | null;
  /** 所屬週期性收支規則識別碼（選填） */
  recurringId?: string | null;
  /** 對應的週期發生日期 YYYY-MM-DD（選填） */
  occurrenceDate?: string | null;
}

export interface Place extends BaseRecord {
  /** 地點名稱（最長 30 字，未刪除項目不可重複） */
  name: string;
  /** 圖示（emoji，預設 📍） */
  icon: string;
  useCount: number;
  lastUsedAt: number;
  sortOrder: number;
  archived: boolean;
  /** 綁定的電子發票賣方統一編號清單（8 位數字） */
  sellerIds?: string[];
}

export type RecurringFrequency = 'monthly' | 'weekly' | 'yearly';

export interface RecurringRule extends BaseRecord {
  kind: TransactionKind;
  /** 正整數（新台幣元） */
  amount: number;
  accountId: string;
  /** 僅轉帳使用 */
  toAccountId: string | null;
  /** 轉帳時為 null */
  categoryId: string | null;
  note: string | null;
  frequency: RecurringFrequency;
  /** 每月或每年使用的日（1–31；當月無該日則取月底） */
  dayOfMonth: number;
  /** 每週使用的星期（0–6，0 為週日） */
  weekday: number;
  /** 每年使用的月份（1–12） */
  monthOfYear: number;
  /** 開始日期 YYYY-MM-DD */
  startDate: string;
  /** 結束日期 YYYY-MM-DD（可空） */
  endDate: string | null;
  /** 是否暫停 */
  paused: boolean;
  /** true＝自動入帳；false＝到期於首頁顯示待確認 */
  autoPost: boolean;
}

export interface NotePreset extends BaseRecord {
  text: string;
  /** null 代表所有分類都顯示 */
  categoryId: string | null;
  useCount: number;
  lastUsedAt: number;
  sortOrder: number;
}

export interface Shortcut extends BaseRecord {
  /** 顯示名稱（例如「早餐」） */
  label: string;
  /** 圖示（emoji，預設使用分類圖示） */
  icon: string;
  kind: TransactionKind;
  /** 金額（可空；null 代表點選後開啟記帳面板輸入金額） */
  amount: number | null;
  accountId: string;
  /** 僅轉帳使用 */
  toAccountId: string | null;
  /** 轉帳時為 null */
  categoryId: string | null;
  note: string | null;
  sortOrder: number;
}

export interface LotteryDraw extends BaseRecord {
  /** 期別起始單數月 YYYY-MM（例如 2026-09 代表 9–10 月） */
  period: string;
  /** 特別獎（8 碼數字） */
  special: string;
  /** 特獎（8 碼數字） */
  grand: string;
  /** 頭獎（8 碼數字陣列，通常 3 組） */
  first: string[];
  /** 增開六獎（3 碼數字陣列，可為空） */
  extraSixth: string[];
}

export interface MetaEntry {
  key: string;
  value: string;
}

export type SyncTableName =
  | 'accounts'
  | 'categories'
  | 'transactions'
  | 'notePresets'
  | 'recurringRules'
  | 'shortcuts'
  | 'places'
  | 'lotteryDraws';

export interface OutboxEntry {
  /** 複合主鍵 `${table}:${recordId}`，避免同一筆紀錄重複排隊 */
  key: string;
  table: SyncTableName;
  recordId: string;
  updatedAt: number;
}
