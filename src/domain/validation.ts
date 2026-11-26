import type { TransactionKind } from '../db/types';

export interface TransactionValidationInput {
  kind: TransactionKind;
  date: string;
  amount: number;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 驗證交易資料是否合法，回傳繁體中文錯誤訊息陣列。
 */
export function validateTransaction(tx: TransactionValidationInput): string[] {
  const errors: string[] = [];

  if (!Number.isInteger(tx.amount) || tx.amount <= 0) {
    errors.push('金額需為正整數');
  }

  if (!DATE_PATTERN.test(tx.date)) {
    errors.push('請選擇有效的日期');
  }

  if (!tx.accountId) {
    errors.push('請選擇帳戶');
  }

  if (tx.kind === 'expense' || tx.kind === 'income') {
    if (!tx.categoryId) {
      errors.push('請選擇分類');
    }
    if (tx.toAccountId) {
      errors.push('一般收支不應指定轉入帳戶');
    }
  } else if (tx.kind === 'transfer') {
    if (!tx.toAccountId) {
      errors.push('請選擇轉入帳戶');
    } else if (tx.accountId && tx.accountId === tx.toAccountId) {
      errors.push('轉出與轉入帳戶不可相同');
    }
    if (tx.categoryId) {
      errors.push('轉帳不應指定分類');
    }
  }

  return errors;
}
