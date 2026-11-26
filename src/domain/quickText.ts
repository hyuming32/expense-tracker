import type {
  Account,
  AccountType,
  Category,
  NotePreset,
  Place,
  TransactionKind,
} from '../db/types';
import { normalizeTags } from './tags';

export interface QuickTextContext {
  categories: readonly Category[];
  accounts: readonly Account[];
  places: readonly Place[];
  notePresets?: readonly NotePreset[];
  /** 本地今日日期 YYYY-MM-DD */
  today: string;
  defaultAccountId: string;
}

export interface QuickTextResult {
  kind: TransactionKind;
  amount: number | null;
  categoryId: string | null;
  accountId: string;
  toAccountId: string | null;
  placeId: string | null;
  note: string | null;
  tags: string[];
  date: string;
  confidence: {
    category: boolean;
    amount: boolean;
  };
}

interface TextSpan {
  start: number;
  end: number;
}

interface KeywordRule {
  keywords: readonly string[];
  targetCategories: readonly string[];
}

const TRANSFER_WITHDRAW_KEYWORDS = ['領錢', '提款'] as const;
const TRANSFER_GENERAL_KEYWORDS = ['轉帳', '轉入', '匯款'] as const;

const INCOME_KEYWORDS = [
  '薪水',
  '薪資',
  '月薪',
  '底薪',
  '發薪',
  '獎金',
  '年終',
  '分紅',
  '紅包',
  '三節',
  '股息',
  '股利',
  '配息',
  '利息',
  '退款',
  '退費',
  '退貨',
  '現金回饋',
  '回饋',
  '兼職',
  '收入',
] as const;

const EXPENSE_KEYWORD_RULES: readonly KeywordRule[] = [
  {
    keywords: ['蛋餅', '吐司', '漢堡', '豆漿', '燒餅', '早點', '早餐'],
    targetCategories: ['早餐', '飲食'],
  },
  {
    keywords: ['便當', '中餐', '午飯', '午餐'],
    targetCategories: ['午餐', '飲食'],
  },
  {
    keywords: ['宵夜', '消夜', '晚飯', '晚餐'],
    targetCategories: ['晚餐', '飲食'],
  },
  {
    keywords: [
      '星巴克',
      '手搖飲',
      '下午茶',
      '咖啡',
      '飲料',
      '手搖',
      '珍奶',
      '奶茶',
      '紅茶',
      '綠茶',
      '拿鐵',
      '美式',
      '點心',
      '甜點',
      '蛋糕',
      '麵包',
      '零食',
    ],
    targetCategories: ['點心', '飲料', '飲食'],
  },
  {
    keywords: ['牛肉麵', '義大利麵', '吃飯', '聚餐', '火鍋', '拉麵', '小吃', '餐廳', '外送'],
    targetCategories: ['飲食'],
  },
  {
    keywords: [
      '計程車',
      '悠遊卡',
      '過路費',
      '高鐵',
      '台鐵',
      '火車',
      '捷運',
      '公車',
      '客運',
      'uber',
      'grab',
      '加油',
      '停車',
      '機票',
      '車資',
      '車票',
    ],
    targetCategories: ['交通'],
  },
  {
    keywords: [
      '演唱會',
      'netflix',
      'spotify',
      'switch',
      'steam',
      '電影',
      '遊戲',
      'ps5',
      'ktv',
      '唱歌',
      '展覽',
      '旅遊',
      '門票',
    ],
    targetCategories: ['娛樂'],
  },
  {
    keywords: ['看醫生', '掛號', '診所', '醫院', '看診', '牙醫', '健檢', '藥局', '買藥', '藥'],
    targetCategories: ['醫療'],
  },
  {
    keywords: [
      '管理費',
      '網路費',
      '第四台',
      '手機費',
      '電話費',
      '房租',
      '租金',
      '水電',
      '水費',
      '電費',
      '瓦斯',
    ],
    targetCategories: ['居住'],
  },
  {
    keywords: [
      '生活用品',
      '衛生紙',
      '日用品',
      '家樂福',
      '屈臣氏',
      '康是美',
      '洗髮精',
      '沐浴乳',
      '洗衣精',
      '全聯',
      '寶雅',
    ],
    targetCategories: ['日用品'],
  },
  {
    keywords: [
      'uniqlo',
      'zara',
      '衣服',
      '上衣',
      '褲子',
      '裙子',
      '外套',
      '鞋子',
      '球鞋',
      '襪子',
      '包包',
      '帽子',
    ],
    targetCategories: ['服飾'],
  },
  {
    keywords: ['買書', '書局', '書籍', '課程', '學費', '補習', '講座', '文具'],
    targetCategories: ['教育'],
  },
];

const INCOME_KEYWORD_RULES: readonly KeywordRule[] = [
  {
    keywords: ['薪水', '薪資', '月薪', '底薪', '發薪'],
    targetCategories: ['薪資', '薪水'],
  },
  {
    keywords: ['獎金', '年終', '分紅', '紅包', '三節'],
    targetCategories: ['獎金'],
  },
  {
    keywords: ['股息', '股利', '配息', '利息', '投資', '基金', '股票'],
    targetCategories: ['投資'],
  },
  {
    keywords: ['現金回饋', '退款', '退費', '退貨', '回饋'],
    targetCategories: ['退款', '其他'],
  },
];

const ACCOUNT_ALIAS_RULES: ReadonlyArray<{ alias: string; type: AccountType }> = [
  { alias: '信用卡', type: 'credit' },
  { alias: '刷卡', type: 'credit' },
  { alias: '金融卡', type: 'bank' },
  { alias: '現金', type: 'cash' },
  { alias: '銀行', type: 'bank' },
  { alias: '戶頭', type: 'bank' },
];

/**
 * 將全形英數符號與全形空白轉為半形，維持字元長度 1:1 對應以便精確計算索引。
 */
function toHalfWidthKeepLength(input: string): string {
  let result = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 0x3000) {
      result += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      result += String.fromCharCode(code - 0xfee0);
    } else {
      result += input[i];
    }
  }
  return result;
}

function normalizeForMatch(input: string): string {
  return toHalfWidthKeepLength(input).toLowerCase();
}

function formatYmd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDateString(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) {
    return ymd;
  }
  const date = new Date(y, m - 1, d + deltaDays);
  return formatYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function isValidMonthDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/**
 * 將指定範圍的字元替換為空白（保留字串長度，避免後續比對索引錯位）。
 */
function maskSpans(text: string, spans: readonly TextSpan[]): string {
  if (spans.length === 0) {
    return text;
  }
  const chars = text.split('');
  for (const span of spans) {
    for (let i = span.start; i < span.end && i < chars.length; i += 1) {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

function extractTags(rawText: string): { tags: string[]; spans: TextSpan[] } {
  const halfWidthText = toHalfWidthKeepLength(rawText);
  const tagRegex = /#([^\s,，、#]+)/g;
  const rawTags: string[] = [];
  const spans: TextSpan[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(halfWidthText)) !== null) {
    const token = match[1];
    if (token) {
      rawTags.push(token);
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return {
    tags: normalizeTags(rawTags),
    spans,
  };
}

function extractDate(
  normalizedText: string,
  today: string,
): { date: string; span: TextSpan | null } {
  const relativeRules: Array<{ word: string; delta: number }> = [
    { word: '前天', delta: -2 },
    { word: '昨天', delta: -1 },
    { word: '今天', delta: 0 },
  ];

  for (const rule of relativeRules) {
    const idx = normalizedText.indexOf(rule.word);
    if (idx !== -1) {
      return {
        date: shiftDateString(today, rule.delta),
        span: { start: idx, end: idx + rule.word.length },
      };
    }
  }

  const todayYear = Number(today.slice(0, 4)) || new Date().getFullYear();
  const mdRegex = /(?<!\d)(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})\s*日?(?!\d)/g;
  let match: RegExpExecArray | null;
  while ((match = mdRegex.exec(normalizedText)) !== null) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    let targetYear = todayYear;
    if (!isValidMonthDay(targetYear, month, day)) {
      if (isValidMonthDay(targetYear - 1, month, day)) {
        targetYear -= 1;
      } else {
        continue;
      }
    }
    let candidate = formatYmd(targetYear, month, day);
    if (candidate > today) {
      targetYear -= 1;
      if (!isValidMonthDay(targetYear, month, day)) {
        continue;
      }
      candidate = formatYmd(targetYear, month, day);
    }
    return {
      date: candidate,
      span: { start: match.index, end: match.index + match[0].length },
    };
  }

  return { date: today, span: null };
}

function extractAmount(normalizedText: string): {
  amount: number | null;
  span: TextSpan | null;
} {
  const amountRegex = /(?:nt\$|\$)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\s*(?:元|塊))?/gi;
  let lastMatch: { value: number; span: TextSpan } | null = null;
  let match: RegExpExecArray | null;

  while ((match = amountRegex.exec(normalizedText)) !== null) {
    const rawDigits = match[1];
    if (!rawDigits) {
      continue;
    }
    const numeric = Number(rawDigits.replace(/,/g, ''));
    if (Number.isFinite(numeric) && numeric > 0) {
      lastMatch = {
        value: Math.trunc(numeric),
        span: { start: match.index, end: match.index + match[0].length },
      };
    }
  }

  if (!lastMatch) {
    return { amount: null, span: null };
  }

  return { amount: lastMatch.value, span: lastMatch.span };
}

interface AccountMatch {
  accountId: string;
  span: TextSpan;
}

function findAccountMatches(
  normalizedText: string,
  activeAccounts: readonly Account[],
): AccountMatch[] {
  const candidates: Array<{ token: string; accountId: string }> = [];

  const sortedAccounts = [...activeAccounts].sort(
    (a, b) => normalizeForMatch(b.name).length - normalizeForMatch(a.name).length,
  );
  for (const acc of sortedAccounts) {
    const token = normalizeForMatch(acc.name).trim();
    if (token) {
      candidates.push({ token, accountId: acc.id });
    }
  }

  for (const aliasRule of ACCOUNT_ALIAS_RULES) {
    const matchedAcc = activeAccounts.find((a) => a.type === aliasRule.type);
    if (matchedAcc) {
      candidates.push({ token: aliasRule.alias, accountId: matchedAcc.id });
    }
  }

  // 依關鍵字長度由長到短匹配，避免短詞搶先截斷長帳戶名
  candidates.sort((a, b) => b.token.length - a.token.length);

  const occupied: boolean[] = new Array(normalizedText.length).fill(false);
  const found: AccountMatch[] = [];

  for (const candidate of candidates) {
    let searchFrom = 0;
    while (searchFrom < normalizedText.length) {
      const idx = normalizedText.indexOf(candidate.token, searchFrom);
      if (idx === -1) {
        break;
      }
      const end = idx + candidate.token.length;
      const overlaps = occupied.slice(idx, end).some(Boolean);
      if (!overlaps) {
        for (let i = idx; i < end; i += 1) {
          occupied[i] = true;
        }
        found.push({
          accountId: candidate.accountId,
          span: { start: idx, end },
        });
      }
      searchFrom = end;
    }
  }

  return found.sort((a, b) => a.span.start - b.span.start);
}

function detectTransfer(normalizedText: string): {
  isTransfer: boolean;
  isWithdraw: boolean;
  spans: TextSpan[];
} {
  for (const kw of TRANSFER_WITHDRAW_KEYWORDS) {
    const idx = normalizedText.indexOf(kw);
    if (idx !== -1) {
      return {
        isTransfer: true,
        isWithdraw: true,
        spans: [{ start: idx, end: idx + kw.length }],
      };
    }
  }

  for (const kw of TRANSFER_GENERAL_KEYWORDS) {
    const idx = normalizedText.indexOf(kw);
    if (idx !== -1) {
      return {
        isTransfer: true,
        isWithdraw: false,
        spans: [{ start: idx, end: idx + kw.length }],
      };
    }
  }

  return { isTransfer: false, isWithdraw: false, spans: [] };
}

function detectIncomeKind(
  normalizedText: string,
  activeCategories: readonly Category[],
): boolean {
  const incomeCategories = activeCategories.filter(
    (c) => c.kind === 'income' && normalizeForMatch(c.name) !== '其他',
  );
  for (const cat of incomeCategories) {
    const name = normalizeForMatch(cat.name).trim();
    if (name && normalizedText.includes(name)) {
      return true;
    }
  }

  return INCOME_KEYWORDS.some((kw) => normalizedText.includes(kw));
}

function matchPlace(normalizedText: string, places: readonly Place[]): string | null {
  const activePlaces = places
    .filter((p) => !p.deleted && !p.archived && p.name.trim().length > 0)
    .sort((a, b) => normalizeForMatch(b.name).length - normalizeForMatch(a.name).length);

  for (const place of activePlaces) {
    const name = normalizeForMatch(place.name).trim();
    if (name && normalizedText.includes(name)) {
      return place.id;
    }
  }
  return null;
}

function matchCategory(
  normalizedText: string,
  kind: 'expense' | 'income',
  activeCategories: readonly Category[],
  notePresets: readonly NotePreset[],
): {
  categoryId: string | null;
  confidence: boolean;
  removeSpan: TextSpan | null;
} {
  const kindCategories = activeCategories.filter((c) => c.kind === kind);
  const nonOtherCategories = kindCategories.filter(
    (c) => normalizeForMatch(c.name).trim() !== '其他',
  );

  // 1. 先比對分類名稱（先子分類、再主分類，同層級最長字串優先）
  const orderedCategories = [...nonOtherCategories].sort((a, b) => {
    const aIsChild = a.parentId !== null ? 1 : 0;
    const bIsChild = b.parentId !== null ? 1 : 0;
    if (aIsChild !== bIsChild) {
      return bIsChild - aIsChild;
    }
    return normalizeForMatch(b.name).length - normalizeForMatch(a.name).length;
  });

  for (const cat of orderedCategories) {
    const name = normalizeForMatch(cat.name).trim();
    if (!name) {
      continue;
    }
    const idx = normalizedText.indexOf(name);
    if (idx !== -1) {
      return {
        categoryId: cat.id,
        confidence: true,
        removeSpan: { start: idx, end: idx + name.length },
      };
    }
  }

  // 2. 內建關鍵字表（只對應到存在且未封存的分類）
  const rules = kind === 'income' ? INCOME_KEYWORD_RULES : EXPENSE_KEYWORD_RULES;
  const keywordEntries: Array<{ keyword: string; targetCategories: readonly string[] }> = [];
  for (const rule of rules) {
    for (const kw of rule.keywords) {
      keywordEntries.push({ keyword: kw, targetCategories: rule.targetCategories });
    }
  }
  keywordEntries.sort((a, b) => b.keyword.length - a.keyword.length);

  for (const entry of keywordEntries) {
    if (!normalizedText.includes(entry.keyword)) {
      continue;
    }
    for (const targetName of entry.targetCategories) {
      const targetNorm = normalizeForMatch(targetName);
      const matchedCat = kindCategories.find(
        (c) => normalizeForMatch(c.name).trim() === targetNorm,
      );
      if (matchedCat) {
        return {
          categoryId: matchedCat.id,
          confidence: true,
          removeSpan: null,
        };
      }
    }
  }

  // 3. 嘗試比對常用備註（notePresets）對應的分類
  const orderedPresets = [...notePresets]
    .filter((p) => !p.deleted && p.categoryId !== null && p.text.trim().length > 0)
    .sort((a, b) => normalizeForMatch(b.text).length - normalizeForMatch(a.text).length);

  for (const preset of orderedPresets) {
    const presetText = normalizeForMatch(preset.text).trim();
    if (!presetText || !normalizedText.includes(presetText)) {
      continue;
    }
    const matchedCat = kindCategories.find((c) => c.id === preset.categoryId);
    if (matchedCat) {
      return {
        categoryId: matchedCat.id,
        confidence: true,
        removeSpan: null,
      };
    }
  }

  // 4. 找不到則 fallback 到「其他」，confidence.category = false
  const otherCategory = kindCategories.find(
    (c) => normalizeForMatch(c.name).trim() === '其他',
  );
  return {
    categoryId: otherCategory?.id ?? null,
    confidence: false,
    removeSpan: null,
  };
}

function buildFinalNote(rawText: string, removeSpans: readonly TextSpan[]): string | null {
  const masked = maskSpans(rawText, removeSpans);
  const cleaned = masked
    .replace(/[\s,，、]+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * 將使用者輸入的一句話純文字（本機規則解析）拆解為記帳欄位。
 */
export function parseQuickText(text: string, ctx: QuickTextContext): QuickTextResult {
  const activeAccounts = ctx.accounts.filter((a) => !a.deleted && !a.archived);
  const activeCategories = ctx.categories.filter((c) => !c.deleted && !c.archived);
  const fallbackAccountId =
    (ctx.defaultAccountId && activeAccounts.some((a) => a.id === ctx.defaultAccountId)
      ? ctx.defaultAccountId
      : activeAccounts[0]?.id) ?? '';

  const normalizedOriginal = normalizeForMatch(text);
  const removeSpans: TextSpan[] = [];

  // 0. 解析 #標籤（先遮罩避免干擾日期、金額與分類）
  const tagResult = extractTags(text);
  if (tagResult.spans.length > 0) {
    removeSpans.push(...tagResult.spans);
  }

  // 1. 解析日期（先於金額，避免 11/24 被誤判為金額）
  const afterTagsNormalized = maskSpans(normalizedOriginal, removeSpans);
  const dateResult = extractDate(afterTagsNormalized, ctx.today);
  if (dateResult.span) {
    removeSpans.push(dateResult.span);
  }

  // 2. 解析金額（取最後一個數字）
  const afterDateNormalized = maskSpans(normalizedOriginal, removeSpans);
  const amountResult = extractAmount(afterDateNormalized);
  if (amountResult.span) {
    removeSpans.push(amountResult.span);
  }

  // 3. 判斷交易類型（轉帳 / 收入 / 支出）
  const afterAmountNormalized = maskSpans(normalizedOriginal, removeSpans);
  const transferInfo = detectTransfer(afterAmountNormalized);
  if (transferInfo.isTransfer) {
    removeSpans.push(...transferInfo.spans);
  }

  // 4. 解析帳戶
  const afterTransferNormalized = maskSpans(normalizedOriginal, removeSpans);
  const accountMatches = findAccountMatches(afterTransferNormalized, activeAccounts);
  for (const accMatch of accountMatches) {
    removeSpans.push(accMatch.span);
  }

  // 5. 解析地點（保留於備註中）
  const placeId = matchPlace(afterTransferNormalized, ctx.places);

  let kind: TransactionKind = 'expense';
  let accountId = fallbackAccountId;
  let toAccountId: string | null = null;
  let categoryId: string | null = null;
  let categoryConfidence = false;

  if (transferInfo.isTransfer) {
    kind = 'transfer';
    categoryConfidence = true;

    // 在轉帳語境下移除「到」「至」等連接詞
    const afterAccountsNormalized = maskSpans(normalizedOriginal, removeSpans);
    const connectorRegex = /(?:^|[\s,，])(到|至|轉到|轉至)(?=$|[\s,，])/g;
    let connMatch: RegExpExecArray | null;
    while ((connMatch = connectorRegex.exec(afterAccountsNormalized)) !== null) {
      const connectorWord = connMatch[1];
      if (!connectorWord) {
        continue;
      }
      const wordOffset = connMatch[0].indexOf(connectorWord);
      removeSpans.push({
        start: connMatch.index + wordOffset,
        end: connMatch.index + wordOffset + connectorWord.length,
      });
    }

    const firstAccount = accountMatches[0];
    const secondAccount = accountMatches[1];
    if (transferInfo.isWithdraw && !firstAccount) {
      const bankAcc = activeAccounts.find((a) => a.type === 'bank');
      const cashAcc = activeAccounts.find((a) => a.type === 'cash');
      accountId = bankAcc?.id ?? fallbackAccountId;
      toAccountId = cashAcc?.id ?? activeAccounts.find((a) => a.id !== accountId)?.id ?? null;
    } else if (firstAccount && secondAccount) {
      accountId = firstAccount.accountId;
      toAccountId = secondAccount.accountId;
    } else if (firstAccount) {
      accountId = firstAccount.accountId;
      toAccountId = activeAccounts.find((a) => a.id !== accountId)?.id ?? null;
    } else {
      toAccountId = activeAccounts.find((a) => a.id !== accountId)?.id ?? null;
    }
  } else {
    const isIncome = detectIncomeKind(afterTransferNormalized, activeCategories);
    kind = isIncome ? 'income' : 'expense';
    accountId = accountMatches[0]?.accountId ?? fallbackAccountId;

    const afterAccountNormalized = maskSpans(normalizedOriginal, removeSpans);
    const catResult = matchCategory(
      afterAccountNormalized,
      kind,
      activeCategories,
      ctx.notePresets ?? [],
    );
    categoryId = catResult.categoryId;
    categoryConfidence = catResult.confidence;
    if (catResult.removeSpan) {
      removeSpans.push(catResult.removeSpan);
    }
  }

  const note = buildFinalNote(text, removeSpans);

  return {
    kind,
    amount: amountResult.amount,
    categoryId,
    accountId,
    toAccountId,
    placeId,
    note,
    tags: tagResult.tags,
    date: dateResult.date,
    confidence: {
      category: categoryConfidence,
      amount: amountResult.amount !== null,
    },
  };
}
