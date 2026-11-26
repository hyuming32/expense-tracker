export interface InvoiceItem {
  name: string;
  qty: number;
  unitPrice: number;
}

export interface ParsedInvoice {
  invoiceNo: string;
  /** 西元日期 YYYY-MM-DD */
  date: string;
  /** 總計額（含稅，整數） */
  amount: number;
  sellerId: string;
  items: InvoiceItem[];
}

const INVOICE_NO_PATTERN = /^[A-Za-z]{2}\d{8}$/;
const ROC_DATE_PATTERN = /^\d{7}$/;
const HEX8_PATTERN = /^[0-9A-Fa-f]{8}$/;

/**
 * 判斷掃描到的 QR Code 是否為台灣電子發票右側品目續行碼（以 `**` 開頭）。
 */
export function isInvoiceRightQr(text: string): boolean {
  return text.trim().startsWith('**');
}

function parseRocDate(rocDate: string): string | null {
  if (!ROC_DATE_PATTERN.test(rocDate)) {
    return null;
  }
  const rocYear = Number(rocDate.slice(0, 3));
  const month = Number(rocDate.slice(3, 5));
  const day = Number(rocDate.slice(5, 7));
  const year = rocYear + 1911;

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function decodeBase64Utf8(encoded: string): string | null {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeBig5(raw: string): string | null {
  try {
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i) & 0xff;
    }
    return new TextDecoder('big5', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeItemName(rawName: string, encoding: string): string | null {
  if (!rawName) {
    return null;
  }
  if (encoding === '1') {
    return rawName;
  }
  if (encoding === '2') {
    return decodeBase64Utf8(rawName);
  }
  if (encoding === '0') {
    return decodeBig5(rawName);
  }
  return null;
}

function parseInvoiceItems(rest: string): InvoiceItem[] {
  if (!rest) {
    return [];
  }
  const trimmedRest = rest.startsWith(':') ? rest.slice(1) : rest;
  if (!trimmedRest) {
    return [];
  }

  const fields = trimmedRest.split(':');
  // 至少需包含：營業人自行使用區、二維條碼品目筆數、總品目筆數、中文編碼參數
  if (fields.length < 4) {
    return [];
  }

  const encoding = fields[3] ?? '';
  if (encoding !== '0' && encoding !== '1' && encoding !== '2') {
    return [];
  }

  const items: InvoiceItem[] = [];
  for (let i = 4; i + 2 < fields.length; i += 3) {
    const rawName = fields[i] ?? '';
    const rawQty = fields[i + 1] ?? '';
    const rawUnitPrice = fields[i + 2] ?? '';

    const decodedName = decodeItemName(rawName, encoding);
    const qty = Number(rawQty);
    const unitPrice = Number(rawUnitPrice);

    if (
      decodedName &&
      decodedName.trim().length > 0 &&
      rawQty.trim().length > 0 &&
      rawUnitPrice.trim().length > 0 &&
      Number.isFinite(qty) &&
      Number.isFinite(unitPrice)
    ) {
      items.push({
        name: decodedName.trim(),
        qty,
        unitPrice,
      });
    }
  }

  return items;
}

/**
 * 解析台灣電子發票證明聯「左側」QR Code 內容。
 * 若為右側續行碼（`**` 開頭）或前 77 碼格式不合法，回傳 null。
 */
export function parseInvoiceQr(text: string): ParsedInvoice | null {
  const raw = text.trim();
  if (!raw || raw.startsWith('**') || raw.length < 77) {
    return null;
  }

  const rawInvoiceNo = raw.slice(0, 10);
  if (!INVOICE_NO_PATTERN.test(rawInvoiceNo)) {
    return null;
  }

  const date = parseRocDate(raw.slice(10, 17));
  if (!date) {
    return null;
  }

  const salesHex = raw.slice(21, 29);
  const totalHex = raw.slice(29, 37);
  if (!HEX8_PATTERN.test(salesHex) || !HEX8_PATTERN.test(totalHex)) {
    return null;
  }

  const amount = Number.parseInt(totalHex, 16);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return null;
  }

  const sellerId = raw.slice(45, 53);
  const items = parseInvoiceItems(raw.slice(77));

  return {
    invoiceNo: rawInvoiceNo.toUpperCase(),
    date,
    amount,
    sellerId,
    items,
  };
}

/**
 * 將解析後的發票品名整理為記帳備註（最多顯示前 3 項）。
 */
export function formatInvoiceNote(invoice: ParsedInvoice): string {
  if (invoice.items.length === 0) {
    return `發票 ${invoice.invoiceNo}`;
  }
  const preview = invoice.items
    .slice(0, 3)
    .map((item) => item.name)
    .join('、');
  if (invoice.items.length > 3) {
    return `${preview}等 ${invoice.items.length} 項`;
  }
  return preview;
}
