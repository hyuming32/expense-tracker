import type { Account, Transaction } from '../db/types';

const SEED_DEVICE_ID = 'seed';
const BACKUP_NAME_TIME_REGEX = /^記帳備份_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\.json$/;

export interface RestoreDataSummary {
  transactionCount: number;
  accountCount: number;
  minDate: string | null;
  maxDate: string | null;
}

/**
 * 判斷本機是否為「新裝置」（尚未有任何使用者自建的未刪除交易；種子帳戶與分類不算）。
 */
export function isNewDevice(
  transactions: readonly Pick<Transaction, 'deleted' | 'deviceId'>[],
): boolean {
  for (const tx of transactions) {
    if (!tx.deleted && tx.deviceId !== SEED_DEVICE_ID) {
      return false;
    }
  }
  return true;
}

/**
 * 統計未刪除的交易筆數、日期範圍與帳戶數。
 */
export function summarizeTransactionsAndAccounts(
  transactions: readonly Pick<Transaction, 'deleted' | 'date'>[],
  accounts: readonly Pick<Account, 'deleted'>[],
): RestoreDataSummary {
  let transactionCount = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const tx of transactions) {
    if (tx.deleted) {
      continue;
    }
    transactionCount += 1;
    if (tx.date) {
      if (minDate === null || tx.date < minDate) {
        minDate = tx.date;
      }
      if (maxDate === null || tx.date > maxDate) {
        maxDate = tx.date;
      }
    }
  }

  let accountCount = 0;
  for (const acc of accounts) {
    if (!acc.deleted) {
      accountCount += 1;
    }
  }

  return {
    transactionCount,
    accountCount,
    minDate,
    maxDate,
  };
}

/**
 * 解析備份內容的交易筆數、帳戶數與最早～最新日期。
 */
export function summarizeBackupPayload(payload: {
  transactions: readonly Pick<Transaction, 'deleted' | 'date'>[];
  accounts: readonly Pick<Account, 'deleted'>[];
}): RestoreDataSummary {
  return summarizeTransactionsAndAccounts(payload.transactions, payload.accounts);
}

/**
 * 將位元組數格式化為易讀的檔案大小字串。
 */
export function formatBackupFileSize(bytes?: number): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 將備份檔的建立時間或檔名轉換為易讀的日期時間文字。
 */
export function formatBackupFileLabel(file: { name: string; createdTime?: string }): string {
  if (file.createdTime) {
    const ms = Date.parse(file.createdTime);
    if (Number.isFinite(ms)) {
      const date = new Date(ms);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      return `${y}/${m}/${d} ${hh}:${mm}`;
    }
  }

  const match = BACKUP_NAME_TIME_REGEX.exec(file.name);
  if (match) {
    return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}`;
  }

  return file.name;
}
