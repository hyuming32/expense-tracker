import type { Account, Transaction } from '../db/types';

export interface MonthSummaryResult {
  income: number;
  expense: number;
  net: number;
}

export interface DayGroup {
  date: string;
  expenseTotal: number;
  incomeTotal: number;
  transactions: Transaction[];
}

/**
 * 計算指定月份（YYYY-MM）的收支彙總，排除已刪除與轉帳紀錄。
 */
export function monthSummary(transactions: readonly Transaction[], month: string): MonthSummaryResult {
  let income = 0;
  let expense = 0;

  for (const tx of transactions) {
    if (tx.deleted || !tx.date.startsWith(month)) {
      continue;
    }
    if (tx.kind === 'income') {
      income += tx.amount;
    } else if (tx.kind === 'expense') {
      expense += tx.amount;
    }
  }

  return {
    income,
    expense,
    net: income - expense,
  };
}

/**
 * 計算單一帳戶的目前餘額：初始餘額 + 收入 - 支出 - 轉出 + 轉入。
 */
export function accountBalance(account: Account, transactions: readonly Transaction[]): number {
  let balance = account.initialBalance;

  for (const tx of transactions) {
    if (tx.deleted) {
      continue;
    }
    if (tx.kind === 'income' && tx.accountId === account.id) {
      balance += tx.amount;
    } else if (tx.kind === 'expense' && tx.accountId === account.id) {
      balance -= tx.amount;
    } else if (tx.kind === 'transfer') {
      if (tx.accountId === account.id) {
        balance -= tx.amount;
      }
      if (tx.toAccountId === account.id) {
        balance += tx.amount;
      }
    }
  }

  return balance;
}

/**
 * 依日期由新到舊分組交易紀錄，並計算每日支出與收入小計（排除轉帳與已刪除）。
 */
export function groupByDay(transactions: readonly Transaction[]): DayGroup[] {
  const map = new Map<string, DayGroup>();

  for (const tx of transactions) {
    if (tx.deleted) {
      continue;
    }
    let group = map.get(tx.date);
    if (!group) {
      group = {
        date: tx.date,
        expenseTotal: 0,
        incomeTotal: 0,
        transactions: [],
      };
      map.set(tx.date, group);
    }

    if (tx.kind === 'expense') {
      group.expenseTotal += tx.amount;
    } else if (tx.kind === 'income') {
      group.incomeTotal += tx.amount;
    }
    group.transactions.push(tx);
  }

  const groups = Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
  for (const group of groups) {
    group.transactions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return groups;
}
