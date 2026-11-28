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
  /** 金額（永遠為主幣別金額，已依主幣別小數位換算） */
  amount: number;
  /** 外幣 ISO 3 碼代碼（選填；null 或未設定代表主幣別） */
  currency?: string | null;
  /** 外幣原幣金額（外幣交易時必填） */
  originalAmount?: number | null;
  /** 當下匯率快照（1 單位原幣 = rate 單位主幣別） */
  rate?: number | null;
  accountId: string;
  /** 僅轉帳使用 */
  toAccountId: string | null;
  /** 轉帳時為 null */
  categoryId: string | null;
  /** 地點識別碼（選填，可空） */
  placeId?: string | null;
  note: string | null;
  /** 標籤清單（選填，最多 5 個） */
  tags?: string[];
  /** 電子發票字軌號碼（選填，例如 AB12345678） */
  invoiceNo?: string | null;
  /** 所屬週期性收支規則識別碼（選填） */
  recurringId?: string | null;
  /** 對應的週期發生日期 YYYY-MM-DD（選填） */
  occurrenceDate?: string | null;
  /** 同一組分期共用的識別碼（uuidv7，選填） */
  installmentId?: string | null;
  /** 分期期數索引（1 起算，選填） */
  installmentIndex?: number | null;
  /** 分期總期數（選填） */
  installmentCount?: number | null;
  /** 分期總額（主幣別，選填） */
  installmentTotal?: number | null;
  /** 建立此筆交易的成員識別碼（家庭帳本使用，建立後不變） */
  memberId?: string | null;
  /** 最後修改或刪除者的成員識別碼（家庭帳本使用） */
  lastEditedBy?: string | null;
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

export interface Budget extends BaseRecord {
  /** null 代表本月總預算或成員個人預算；否則為「支出」主分類 id */
  categoryId: string | null;
  /** 每月預算金額（正整數，新台幣元） */
  amount: number;
  /** 成員個人預算所屬成員識別碼（家庭帳本使用） */
  memberId?: string | null;
}

export type MemberRole = 'owner' | 'member';

export interface Member extends BaseRecord {
  /** 成員顯示名稱 */
  name: string;
  /** 代表色（#RRGGBB） */
  color: string;
  /** Google 帳號 Email */
  email: string;
  /** 成員角色（owner 建立者／member 一般成員） */
  role: MemberRole;
  /** 是否已被建立者移除 */
  removed: boolean;
}

export interface NoSpendDay extends BaseRecord {
  /** 標記為「這天沒花錢」的本地日期字串 YYYY-MM-DD */
  date: string;
}

export type WalletCardType = 'carrier' | 'member';
export type WalletCardFormat = 'code39' | 'code128' | 'ean13' | 'qr';

export interface WalletCard extends BaseRecord {
  type: WalletCardType;
  /** 載具固定「手機條碼」；會員卡最長 20 字 */
  name: string;
  /** 條碼內容 */
  code: string;
  /** 載具固定 code39 */
  format: WalletCardFormat;
  /** 卡片底色 */
  color: string;
  sortOrder: number;
  lastUsedAt: number;
}

export interface CurrencyRate extends BaseRecord {
  /** 3 個大寫英文字母代碼（id 與 code 相同） */
  code: string;
  /** 幣別名稱（最長 10 字） */
  name: string;
  /** 最新匯率：1 單位此幣 = rate 單位主幣別（主幣別固定為 1） */
  rate: number;
  /** 小數位數（0 或 2） */
  decimals: number;
  /** 是否為主幣別（全表最多一筆為 true） */
  isMain: boolean;
  sortOrder: number;
  archived: boolean;
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
  | 'lotteryDraws'
  | 'budgets'
  | 'noSpendDays'
  | 'cards'
  | 'currencies'
  | 'members';

export interface OutboxEntry {
  /** 複合主鍵 `${table}:${recordId}`，避免同一筆紀錄重複排隊 */
  key: string;
  table: SyncTableName;
  recordId: string;
  updatedAt: number;
}
