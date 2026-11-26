import type { Place, Transaction } from '../db/types';

export const DEFAULT_QUICK_PLACE_LIMIT = 10;
export const PLACE_NAME_MAX_LENGTH = 30;
export const SELLER_ID_PATTERN = /^\d{8}$/;

export interface QuickPlaceOptions {
  places: readonly Place[];
  query?: string;
  limit?: number;
}

/**
 * 驗證賣方統一編號是否為 8 位數字。
 */
export function isValidSellerId(value: string): boolean {
  return SELLER_ID_PATTERN.test(value.trim());
}

/**
 * 去除地點名稱前後空白並限制最多 30 字。
 */
export function normalizePlaceName(name: string): string {
  return name.trim().slice(0, PLACE_NAME_MAX_LENGTH);
}

/**
 * 地點快選排序：useCount 由大到小，再依 lastUsedAt 由新到舊，最後依 sortOrder 由小到大。
 */
export function comparePlacesByUsage(a: Place, b: Place): number {
  if (b.useCount !== a.useCount) {
    return b.useCount - a.useCount;
  }
  if (b.lastUsedAt !== a.lastUsedAt) {
    return b.lastUsedAt - a.lastUsedAt;
  }
  return a.sortOrder - b.sortOrder;
}

/**
 * 依使用習慣與搜尋關鍵字篩選並排序快選地點清單（最多回傳 limit 筆，預設 10 筆）。
 */
export function selectQuickPlaces(options: QuickPlaceOptions): Place[] {
  const { places, query = '', limit = DEFAULT_QUICK_PLACE_LIMIT } = options;
  const normalizedQuery = query.trim().toLowerCase();

  const filtered = places.filter((place) => {
    if (place.deleted || place.archived) {
      return false;
    }
    if (normalizedQuery && !place.name.toLowerCase().includes(normalizedQuery)) {
      return false;
    }
    return true;
  });

  filtered.sort(comparePlacesByUsage);
  return filtered.slice(0, limit);
}

/**
 * 依賣方統一編號尋找未刪除且未停用的對應地點。
 */
export function findPlaceBySellerId(places: readonly Place[], sellerId: string): Place | undefined {
  const normalized = sellerId.trim();
  if (!isValidSellerId(normalized)) {
    return undefined;
  }
  return places.find(
    (place) => !place.deleted && !place.archived && (place.sellerIds ?? []).includes(normalized),
  );
}

/**
 * 比較兩筆交易的日期與時間（日期由新到舊；同日依時間由晚到早，無時間排最後，再依 updatedAt 由新到舊）。
 */
export function compareTransactionsByDateTimeDesc(a: Transaction, b: Transaction): number {
  const dateCmp = b.date.localeCompare(a.date);
  if (dateCmp !== 0) {
    return dateCmp;
  }

  const timeA = a.time?.trim() || '';
  const timeB = b.time?.trim() || '';
  if (timeA && timeB) {
    const timeCmp = timeB.localeCompare(timeA);
    if (timeCmp !== 0) {
      return timeCmp;
    }
  } else if (timeA && !timeB) {
    return -1;
  } else if (!timeA && timeB) {
    return 1;
  }

  return b.updatedAt - a.updatedAt;
}
