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
  /** 正整數（新台幣元） */
  amount: number;
  accountId: string;
  /** 僅轉帳使用 */
  toAccountId: string | null;
  /** 轉帳時為 null */
  categoryId: string | null;
  note: string | null;
}

export interface MetaEntry {
  key: string;
  value: string;
}

export type SyncTableName = 'accounts' | 'categories' | 'transactions';

export interface OutboxEntry {
  /** 複合主鍵 `${table}:${recordId}`，避免同一筆紀錄重複排隊 */
  key: string;
  table: SyncTableName;
  recordId: string;
  updatedAt: number;
}
