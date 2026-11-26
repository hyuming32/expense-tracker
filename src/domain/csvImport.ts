import type {
  Account,
  AccountType,
  Category,
  CategoryKind,
  Place,
  Transaction,
  TransactionKind,
} from '../db/types';
import { normalizePlaceName } from './places';

export interface CsvImportItem {
  rowNumber: number;
  kind: TransactionKind;
  date: string;
  time: string | null;
  amount: number;
  accountName: string;
  toAccountName: string | null;
  categoryName: string;
  subCategoryName: string;
  placeName: string | null;
  note: string | null;
  invoiceNo: string | null;
}

export interface CsvNewAccount {
  name: string;
  type: AccountType;
}

export interface CsvNewCategory {
  kind: CategoryKind;
  name: string;
  parentName: string | null;
}

export interface CsvImportError {
  rowNumber: number;
  reason: string;
}

export interface CsvImportPlan {
  items: CsvImportItem[];
  newAccounts: CsvNewAccount[];
  newCategories: CsvNewCategory[];
  newPlaces: string[];
  skippedDuplicates: number;
  errors: CsvImportError[];
  totalRows: number;
}

export interface CsvImportExistingData {
  transactions: readonly Transaction[];
  categories: readonly Category[];
  accounts: readonly Account[];
  places?: readonly Place[];
}

interface ParsedCsvRow {
  lineNumber: number;
  cells: string[];
}

const REQUIRED_HEADERS = [
  '日期',
  '類型',
  '金額',
  '分類',
  '子分類',
  '帳戶',
  '轉入帳戶',
  '備註',
] as const;

const LABEL_TO_KIND: Record<string, TransactionKind> = {
  支出: 'expense',
  收入: 'income',
  轉帳: 'transfer',
};

function parseCsvRows(rawText: string): ParsedCsvRow[] {
  const text = rawText.startsWith('\uFEFF') ? rawText.slice(1) : rawText;
  const rows: ParsedCsvRow[] = [];

  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  let lineNumber = 1;
  let rowStartLine = 1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentCell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') {
          i += 1;
        }
        currentCell += '\n';
        lineNumber += 1;
      } else if (ch === '\n') {
        currentCell += '\n';
        lineNumber += 1;
      } else {
        currentCell += ch;
      }
      continue;
    }

    if (ch === '"' && currentCell.length === 0) {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentCell);
      currentCell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      currentRow.push(currentCell);
      currentCell = '';
      if (currentRow.some((cell) => cell !== '')) {
        rows.push({ lineNumber: rowStartLine, cells: currentRow });
      }
      currentRow = [];
      lineNumber += 1;
      rowStartLine = lineNumber;
    } else {
      currentCell += ch;
    }
  }

  if (currentRow.length > 0 || currentCell.length > 0) {
    currentRow.push(currentCell);
    if (currentRow.some((cell) => cell !== '')) {
      rows.push({ lineNumber: rowStartLine, cells: currentRow });
    }
  }

  return rows;
}

function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isValidTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function buildDuplicateSignature(
  date: string,
  kind: TransactionKind,
  amount: number,
  categoryName: string,
  subCategoryName: string,
  accountName: string,
  toAccountName: string,
  note: string,
): string {
  return JSON.stringify([
    date,
    kind,
    amount,
    categoryName,
    subCategoryName,
    accountName,
    toAccountName,
    note,
  ]);
}

function categoryKey(kind: CategoryKind, parentName: string | null, name: string): string {
  return `${kind}\0${parentName ?? ''}\0${name}`;
}

/**
 * 解析本 App 匯出的 CSV 字串並與現有資料比對，產生預覽與匯入計畫（純函式）。
 */
export function planCsvImport(csvText: string, existing: CsvImportExistingData): CsvImportPlan {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) {
    throw new Error('CSV 檔案內容為空');
  }

  const headerRow = rows[0]!;
  const headerIndex = new Map<string, number>();
  headerRow.cells.forEach((cell, idx) => {
    const trimmed = cell.trim();
    if (trimmed && !headerIndex.has(trimmed)) {
      headerIndex.set(trimmed, idx);
    }
  });

  const missingHeaders = REQUIRED_HEADERS.filter((name) => !headerIndex.has(name));
  if (missingHeaders.length > 0) {
    throw new Error(`CSV 缺少必要欄位：${missingHeaders.join('、')}`);
  }

  const activeAccounts = existing.accounts.filter((a) => !a.deleted);
  const activeCategories = existing.categories.filter((c) => !c.deleted);
  const activePlaces = (existing.places ?? []).filter((p) => !p.deleted);
  const accountById = new Map(existing.accounts.map((a) => [a.id, a]));
  const categoryById = new Map(existing.categories.map((c) => [c.id, c]));

  const existingAccountNames = new Set(activeAccounts.map((a) => a.name.trim()));
  const existingPlaceNames = new Set(activePlaces.map((p) => p.name.trim()));
  const existingParentMap = new Map<string, Category>();
  const existingChildKeys = new Set<string>();

  for (const cat of activeCategories) {
    if (cat.parentId === null) {
      existingParentMap.set(`${cat.kind}\0${cat.name.trim()}`, cat);
    }
  }
  for (const cat of activeCategories) {
    if (cat.parentId !== null) {
      const parent = categoryById.get(cat.parentId);
      if (parent && !parent.deleted) {
        existingChildKeys.add(categoryKey(cat.kind, parent.name.trim(), cat.name.trim()));
      }
    }
  }

  const existingSignatures = new Set<string>();
  const existingInvoices = new Set<string>();

  for (const tx of existing.transactions) {
    if (tx.deleted) {
      continue;
    }
    const accountName = accountById.get(tx.accountId)?.name.trim() ?? '';
    const toAccountName =
      tx.kind === 'transfer' && tx.toAccountId
        ? (accountById.get(tx.toAccountId)?.name.trim() ?? '')
        : '';

    let categoryName = '';
    let subCategoryName = '';
    if (tx.kind !== 'transfer' && tx.categoryId) {
      const cat = categoryById.get(tx.categoryId);
      if (cat) {
        const parent = cat.parentId ? categoryById.get(cat.parentId) : undefined;
        if (parent) {
          categoryName = parent.name.trim();
          subCategoryName = cat.name.trim();
        } else {
          categoryName = cat.name.trim();
        }
      }
    }

    existingSignatures.add(
      buildDuplicateSignature(
        tx.date,
        tx.kind,
        tx.amount,
        categoryName,
        subCategoryName,
        accountName,
        toAccountName,
        (tx.note ?? '').trim(),
      ),
    );

    const normalizedInvoice = tx.invoiceNo?.trim().toUpperCase();
    if (normalizedInvoice) {
      existingInvoices.add(normalizedInvoice);
    }
  }

  const getCell = (cells: readonly string[], columnName: string): string => {
    const idx = headerIndex.get(columnName);
    if (idx === undefined) {
      return '';
    }
    return cells[idx] ?? '';
  };

  const items: CsvImportItem[] = [];
  const newAccounts: CsvNewAccount[] = [];
  const newAccountNames = new Set<string>();
  const newCategories: CsvNewCategory[] = [];
  const newCategoryKeys = new Set<string>();
  const newPlaces: string[] = [];
  const newPlaceNames = new Set<string>();
  const errors: CsvImportError[] = [];
  let skippedDuplicates = 0;

  const ensureAccount = (name: string) => {
    if (!existingAccountNames.has(name) && !newAccountNames.has(name)) {
      newAccountNames.add(name);
      newAccounts.push({ name, type: 'cash' });
    }
  };

  const ensurePlace = (name: string) => {
    if (!existingPlaceNames.has(name) && !newPlaceNames.has(name)) {
      newPlaceNames.add(name);
      newPlaces.push(name);
    }
  };

  const ensureCategory = (kind: CategoryKind, parentName: string, subName: string) => {
    const parentExists = existingParentMap.has(`${kind}\0${parentName}`);
    const parentKey = categoryKey(kind, null, parentName);
    if (!parentExists && !newCategoryKeys.has(parentKey)) {
      newCategoryKeys.add(parentKey);
      newCategories.push({ kind, name: parentName, parentName: null });
    }

    if (subName) {
      const childKey = categoryKey(kind, parentName, subName);
      if (!existingChildKeys.has(childKey) && !newCategoryKeys.has(childKey)) {
        newCategoryKeys.add(childKey);
        newCategories.push({ kind, name: subName, parentName });
      }
    }
  };

  const dataRows = rows.slice(1);
  for (const row of dataRows) {
    const date = getCell(row.cells, '日期').trim();
    if (!isValidDateString(date)) {
      errors.push({ rowNumber: row.lineNumber, reason: '日期格式錯誤（需為 YYYY-MM-DD）' });
      continue;
    }

    const rawTime = getCell(row.cells, '時間').trim();
    if (rawTime && !isValidTimeString(rawTime)) {
      errors.push({ rowNumber: row.lineNumber, reason: '時間格式錯誤（需為 HH:mm）' });
      continue;
    }
    const time = rawTime || null;

    const kindLabel = getCell(row.cells, '類型').trim();
    const kind = LABEL_TO_KIND[kindLabel];
    if (!kind) {
      errors.push({ rowNumber: row.lineNumber, reason: '類型未知（需為 支出／收入／轉帳）' });
      continue;
    }

    const amountRaw = getCell(row.cells, '金額').trim();
    const amount = Number(amountRaw);
    if (!/^\d+$/.test(amountRaw) || !Number.isSafeInteger(amount) || amount <= 0) {
      errors.push({ rowNumber: row.lineNumber, reason: '金額需為正整數' });
      continue;
    }

    const accountName = getCell(row.cells, '帳戶').trim();
    if (!accountName) {
      errors.push({ rowNumber: row.lineNumber, reason: '缺少帳戶名稱' });
      continue;
    }

    let toAccountName: string | null = null;
    let categoryName = '';
    let subCategoryName = '';

    if (kind === 'transfer') {
      const rawTo = getCell(row.cells, '轉入帳戶').trim();
      if (!rawTo) {
        errors.push({ rowNumber: row.lineNumber, reason: '轉帳缺少轉入帳戶' });
        continue;
      }
      if (rawTo === accountName) {
        errors.push({ rowNumber: row.lineNumber, reason: '轉出與轉入帳戶不可相同' });
        continue;
      }
      toAccountName = rawTo;
    } else {
      categoryName = getCell(row.cells, '分類').trim();
      if (!categoryName) {
        errors.push({ rowNumber: row.lineNumber, reason: '缺少分類名稱' });
        continue;
      }
      subCategoryName = getCell(row.cells, '子分類').trim();
    }

    const rawPlaceName = normalizePlaceName(getCell(row.cells, '地點'));
    const placeName = rawPlaceName || null;
    const rawNote = getCell(row.cells, '備註').trim();
    const note = rawNote || null;
    const rawInvoice = getCell(row.cells, '發票號碼').trim().toUpperCase();
    const invoiceNo = rawInvoice || null;

    const sig = buildDuplicateSignature(
      date,
      kind,
      amount,
      categoryName,
      subCategoryName,
      accountName,
      toAccountName ?? '',
      note ?? '',
    );

    if (existingSignatures.has(sig) || (invoiceNo !== null && existingInvoices.has(invoiceNo))) {
      skippedDuplicates += 1;
      continue;
    }

    existingSignatures.add(sig);
    if (invoiceNo !== null) {
      existingInvoices.add(invoiceNo);
    }

    ensureAccount(accountName);
    if (toAccountName) {
      ensureAccount(toAccountName);
    }
    if (kind !== 'transfer') {
      ensureCategory(kind, categoryName, subCategoryName);
    }
    if (placeName) {
      ensurePlace(placeName);
    }

    items.push({
      rowNumber: row.lineNumber,
      kind,
      date,
      time,
      amount,
      accountName,
      toAccountName,
      categoryName,
      subCategoryName,
      placeName,
      note,
      invoiceNo,
    });
  }

  return {
    items,
    newAccounts,
    newCategories,
    newPlaces,
    skippedDuplicates,
    errors,
    totalRows: dataRows.length,
  };
}
