/**
 * 首頁自訂區塊的固定識別鍵與預設順序。
 */
export const DEFAULT_HOME_SECTION_KEYS = [
  'syncStatus',
  'reminders',
  'cards',
  'quickText',
  'summary',
  'habit',
  'budget',
  'lottery',
  'pendingRecurring',
  'recentTransactions',
  'shortcuts',
] as const;

export type HomeSectionKey = (typeof DEFAULT_HOME_SECTION_KEYS)[number];

export interface HomeLayoutItem<T extends string = HomeSectionKey> {
  key: T;
  visible: boolean;
}

export interface HomeSectionMeta {
  key: HomeSectionKey;
  label: string;
  hideWarning?: string;
}

export const HOME_SECTION_META: Readonly<Record<HomeSectionKey, HomeSectionMeta>> = {
  syncStatus: {
    key: 'syncStatus',
    label: '同步狀態',
  },
  reminders: {
    key: 'reminders',
    label: '提醒卡（資料保護／加到主畫面）',
    hideWarning: '隱藏後不會再提醒',
  },
  cards: {
    key: 'cards',
    label: '卡片（載具與會員卡）',
  },
  quickText: {
    key: 'quickText',
    label: '一句話記帳',
  },
  summary: {
    key: 'summary',
    label: '本月收支摘要',
  },
  habit: {
    key: 'habit',
    label: '連續記帳',
  },
  budget: {
    key: 'budget',
    label: '本月預算',
  },
  lottery: {
    key: 'lottery',
    label: '發票對獎提醒',
  },
  pendingRecurring: {
    key: 'pendingRecurring',
    label: '待確認定期收支',
    hideWarning: '隱藏後不會再提醒',
  },
  recentTransactions: {
    key: 'recentTransactions',
    label: '最近交易',
  },
  shortcuts: {
    key: 'shortcuts',
    label: '首頁捷徑',
  },
};

/**
 * 依據使用者儲存的首頁版面設定與目前所有區塊鍵值，解析最終渲染清單。
 * - 若無儲存設定，依預設順序全部顯示。
 * - 已不存在於 allKeys 的舊鍵值會被忽略。
 * - 新增的區塊（saved 中沒有）會依預設順序插入並預設顯示。
 */
export function resolveHomeLayout<T extends string>(
  saved: readonly HomeLayoutItem<string>[] | null | undefined,
  allKeys: readonly T[],
): HomeLayoutItem<T>[] {
  if (!saved || saved.length === 0) {
    return allKeys.map((key) => ({ key, visible: true }));
  }

  const validSet = new Set<string>(allKeys);
  const seen = new Set<string>();
  const resolved: HomeLayoutItem<T>[] = [];

  for (const item of saved) {
    if (validSet.has(item.key) && !seen.has(item.key)) {
      seen.add(item.key);
      resolved.push({
        key: item.key as T,
        visible: Boolean(item.visible),
      });
    }
  }

  // 將新增的區塊依其在 allKeys 的預設相對位置插入
  for (let i = 0; i < allKeys.length; i += 1) {
    const key = allKeys[i]!;
    if (seen.has(key)) {
      continue;
    }

    // 尋找 allKeys 中位於此區塊之前、且已存在於 resolved 的最近前驅區塊
    let insertIndex = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prevKey = allKeys[j]!;
      const prevIndex = resolved.findIndex((entry) => entry.key === prevKey);
      if (prevIndex !== -1) {
        insertIndex = prevIndex + 1;
        break;
      }
    }

    resolved.splice(insertIndex, 0, { key, visible: true });
    seen.add(key);
  }

  return resolved;
}

/**
 * 解析儲存在本機 meta 的首頁版面 JSON 字串，格式不符時回傳 null。
 */
export function parseHomeLayoutJson(raw: string | undefined): HomeLayoutItem<string>[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const items: HomeLayoutItem<string>[] = [];
    for (const entry of parsed) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        'key' in entry &&
        'visible' in entry &&
        typeof entry.key === 'string' &&
        typeof entry.visible === 'boolean'
      ) {
        items.push({ key: entry.key, visible: entry.visible });
      }
    }
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}
