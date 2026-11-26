import type { Category, NotePreset } from '../db/types';

export const DEFAULT_QUICK_NOTE_LIMIT = 12;

export interface QuickNotePresetOptions {
  presets: readonly NotePreset[];
  categories: readonly Category[];
  categoryId: string | null;
  query?: string;
  limit?: number;
}

function comparePresetsByUsage(a: NotePreset, b: NotePreset): number {
  if (b.useCount !== a.useCount) {
    return b.useCount - a.useCount;
  }
  if (b.lastUsedAt !== a.lastUsedAt) {
    return b.lastUsedAt - a.lastUsedAt;
  }
  return a.sortOrder - b.sortOrder;
}

/**
 * 依目前分類與輸入文字篩選並排序常用備註快選清單：
 * 1. 先顯示符合目前分類（或其父分類）的項目，再顯示全部分類（categoryId === null）的項目
 * 2. 各自依 useCount 由大到小、lastUsedAt 由新到舊、sortOrder 由小到大排序
 * 3. 若有輸入文字，依包含關係即時篩選（不分大小寫），最多回傳 limit 筆
 */
export function selectQuickNotePresets(options: QuickNotePresetOptions): NotePreset[] {
  const { presets, categories, categoryId, query = '', limit = DEFAULT_QUICK_NOTE_LIMIT } = options;

  const selectedCategory = categoryId ? categories.find((c) => c.id === categoryId) : undefined;
  const parentCategoryId = selectedCategory?.parentId ?? null;
  const normalizedQuery = query.trim().toLowerCase();

  const categoryMatches: NotePreset[] = [];
  const globalMatches: NotePreset[] = [];

  for (const preset of presets) {
    if (preset.deleted) {
      continue;
    }
    if (normalizedQuery && !preset.text.toLowerCase().includes(normalizedQuery)) {
      continue;
    }

    if (
      categoryId !== null &&
      (preset.categoryId === categoryId ||
        (parentCategoryId !== null && preset.categoryId === parentCategoryId))
    ) {
      categoryMatches.push(preset);
    } else if (preset.categoryId === null) {
      globalMatches.push(preset);
    }
  }

  categoryMatches.sort(comparePresetsByUsage);
  globalMatches.sort(comparePresetsByUsage);

  return [...categoryMatches, ...globalMatches].slice(0, limit);
}
