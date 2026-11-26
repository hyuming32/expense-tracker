import { useMemo, useRef, useState } from 'react';
import {
  type AmountColors,
  archiveAccount,
  archiveCategory,
  type BackupPayload,
  exportBackupData,
  importCsvPlan,
  NOTE_PRESET_MAX_LENGTH,
  parseBackupPayload,
  resetAmountColors,
  restoreBackupData,
  saveAccount,
  saveAmountColors,
  saveCategory,
  saveNotePreset,
  setAutoAddNotePresets,
  softDeleteCategory,
  softDeleteNotePreset,
  swapAccountSortOrder,
  swapCategorySortOrder,
  swapNotePresetSortOrder,
} from '../db/repository';
import type {
  Account,
  AccountType,
  Category,
  CategoryKind,
  NotePreset,
  Transaction,
} from '../db/types';
import { type CsvImportPlan, formatCurrency, getTodayDateString, planCsvImport, toCsv } from '../domain';
import { pickFileWithSystemPicker, saveFile, supportsOpenFilePicker } from '../lib/fileSave';
import { isSyncEnabled } from '../sync/auth';
import {
  formatSyncStatusText,
  formatSyncTimeLabel,
  loginAndSync,
  logoutAndClearSync,
  triggerSync,
  useSyncState,
} from '../sync/syncManager';

interface SettingsPageProps {
  accounts: readonly Account[];
  categories: readonly Category[];
  transactions: readonly Transaction[];
  amountColors: AmountColors;
  notePresets: readonly NotePreset[];
  autoAddNotePresets: boolean;
}

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: '現金',
  bank: '銀行帳戶',
  credit: '信用卡',
};

function getCompactDateStamp(): string {
  return getTodayDateString().replace(/-/g, '');
}

export function SettingsPage({
  accounts,
  categories,
  transactions,
  amountColors,
  notePresets,
  autoAddNotePresets,
}: SettingsPageProps) {
  const [catTab, setCatTab] = useState<CategoryKind>('expense');
  const [catFormOpen, setCatFormOpen] = useState(false);
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [catName, setCatName] = useState('');
  const [catIcon, setCatIcon] = useState('📦');
  const [catParentId, setCatParentId] = useState('');

  const [accFormOpen, setAccFormOpen] = useState(false);
  const [editingAccId, setEditingAccId] = useState<string | null>(null);
  const [accName, setAccName] = useState('');
  const [accType, setAccType] = useState<AccountType>('cash');
  const [accInitialBalance, setAccInitialBalance] = useState('0');

  const [presetFormOpen, setPresetFormOpen] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetText, setPresetText] = useState('');
  const [presetCategoryId, setPresetCategoryId] = useState('');

  const [pendingBackup, setPendingBackup] = useState<BackupPayload | null>(null);
  const [pendingCsvPlan, setPendingCsvPlan] = useState<CsvImportPlan | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvFileInputRef = useRef<HTMLInputElement>(null);
  const syncState = useSyncState();
  const syncEnabled = isSyncEnabled();

  const usedCategoryIds = useMemo(() => {
    const set = new Set<string>();
    for (const tx of transactions) {
      if (!tx.deleted && tx.categoryId) {
        set.add(tx.categoryId);
      }
    }
    return set;
  }, [transactions]);

  const tabCategories = useMemo(
    () => categories.filter((c) => c.kind === catTab),
    [categories, catTab],
  );

  const parentCategories = useMemo(
    () => tabCategories.filter((c) => c.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder),
    [tabCategories],
  );

  const childrenByParent = useMemo(() => {
    const map = new Map<string, Category[]>();
    for (const cat of tabCategories) {
      if (!cat.parentId) {
        continue;
      }
      const list = map.get(cat.parentId) ?? [];
      list.push(cat);
      map.set(cat.parentId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return map;
  }, [tabCategories]);

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => a.sortOrder - b.sortOrder),
    [accounts],
  );

  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const sortedNotePresets = useMemo(
    () => [...notePresets].sort((a, b) => a.sortOrder - b.sortOrder),
    [notePresets],
  );

  const selectableCategories = useMemo(() => {
    const active = categories.filter((c) => !c.archived);
    return [...active].sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === 'expense' ? -1 : 1;
      }
      return a.sortOrder - b.sortOrder;
    });
  }, [categories]);

  const editingCategoryHasChildren = editingCatId
    ? (childrenByParent.get(editingCatId)?.length ?? 0) > 0
    : false;

  function openCreateCategory() {
    setEditingCatId(null);
    setCatName('');
    setCatIcon('📦');
    setCatParentId('');
    setCatFormOpen(true);
    setErrorMessage(null);
  }

  function openEditCategory(cat: Category) {
    setEditingCatId(cat.id);
    setCatName(cat.name);
    setCatIcon(cat.icon);
    setCatParentId(cat.parentId ?? '');
    setCatFormOpen(true);
    setErrorMessage(null);
  }

  async function handleSaveCategory(e: React.FormEvent) {
    e.preventDefault();
    if (!catName.trim()) {
      setErrorMessage('請輸入分類名稱');
      return;
    }
    try {
      await saveCategory({
        id: editingCatId ?? undefined,
        name: catName,
        icon: catIcon,
        kind: catTab,
        parentId: catParentId || null,
      });
      setCatFormOpen(false);
      setStatusMessage(editingCatId ? '已更新分類' : '已新增分類');
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '儲存分類失敗');
    }
  }

  async function handleDeleteCategory(id: string) {
    try {
      await softDeleteCategory(id);
      setStatusMessage('已刪除分類');
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '無法刪除分類');
    }
  }

  function openCreateAccount() {
    setEditingAccId(null);
    setAccName('');
    setAccType('cash');
    setAccInitialBalance('0');
    setAccFormOpen(true);
    setErrorMessage(null);
  }

  function openEditAccount(acc: Account) {
    setEditingAccId(acc.id);
    setAccName(acc.name);
    setAccType(acc.type);
    setAccInitialBalance(String(acc.initialBalance));
    setAccFormOpen(true);
    setErrorMessage(null);
  }

  async function handleSaveAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!accName.trim()) {
      setErrorMessage('請輸入帳戶名稱');
      return;
    }
    const parsedBalance = Number(accInitialBalance);
    if (!Number.isFinite(parsedBalance)) {
      setErrorMessage('開帳餘額需為有效數字');
      return;
    }
    try {
      await saveAccount({
        id: editingAccId ?? undefined,
        name: accName,
        type: accType,
        initialBalance: Math.trunc(parsedBalance),
      });
      setAccFormOpen(false);
      setStatusMessage(editingAccId ? '已更新帳戶' : '已新增帳戶');
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '儲存帳戶失敗');
    }
  }

  function openCreatePreset() {
    setEditingPresetId(null);
    setPresetText('');
    setPresetCategoryId('');
    setPresetFormOpen(true);
    setErrorMessage(null);
  }

  function openEditPreset(preset: NotePreset) {
    setEditingPresetId(preset.id);
    setPresetText(preset.text);
    setPresetCategoryId(preset.categoryId ?? '');
    setPresetFormOpen(true);
    setErrorMessage(null);
  }

  async function handleSavePreset(e: React.FormEvent) {
    e.preventDefault();
    if (!presetText.trim()) {
      setErrorMessage('請輸入常用備註內容');
      return;
    }
    try {
      await saveNotePreset({
        id: editingPresetId ?? undefined,
        text: presetText,
        categoryId: presetCategoryId || null,
      });
      setPresetFormOpen(false);
      setStatusMessage(editingPresetId ? '已更新常用備註' : '已新增常用備註');
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '儲存常用備註失敗');
    }
  }

  async function handleDeletePreset(id: string) {
    try {
      await softDeleteNotePreset(id);
      setStatusMessage('已刪除常用備註');
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '刪除常用備註失敗');
    }
  }

  function formatPresetCategoryLabel(categoryId: string | null): string {
    if (!categoryId) {
      return '全部分類';
    }
    const cat = categoryMap.get(categoryId);
    if (!cat) {
      return '未知分類';
    }
    const parent = cat.parentId ? categoryMap.get(cat.parentId) : undefined;
    return parent ? `${parent.icon} ${parent.name} > ${cat.icon} ${cat.name}` : `${cat.icon} ${cat.name}`;
  }

  async function handleExportCsv() {
    try {
      const csv = toCsv(transactions, categories, accounts);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const result = await saveFile(
        blob,
        `記帳_${getCompactDateStamp()}.csv`,
        'text/csv;charset=utf-8',
      );
      if (result === 'saved') {
        setStatusMessage('已存檔');
        setErrorMessage(null);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '存檔失敗');
    }
  }

  async function handleExportJson() {
    try {
      const payload = await exportBackupData();
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const result = await saveFile(
        blob,
        `記帳備份_${getCompactDateStamp()}.json`,
        'application/json;charset=utf-8',
      );
      if (result === 'saved') {
        setStatusMessage('已存檔');
        setErrorMessage(null);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '存檔失敗');
    }
  }

  async function processBackupFile(file: File) {
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const payload = parseBackupPayload(parsed);
      setPendingBackup(payload);
      setPendingCsvPlan(null);
      setErrorMessage(null);
    } catch (err) {
      setPendingBackup(null);
      setErrorMessage(err instanceof Error ? err.message : '無法解析備份檔案');
    }
  }

  async function handleTriggerRestoreJson() {
    if (supportsOpenFilePicker()) {
      try {
        const file = await pickFileWithSystemPicker('JSON 備份檔案', 'application/json', ['.json']);
        if (file) {
          await processBackupFile(file);
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : '無法開啟備份檔案');
      }
      return;
    }
    fileInputRef.current?.click();
  }

  async function handleSelectBackupFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      return;
    }
    await processBackupFile(file);
  }

  async function handleConfirmRestore() {
    if (!pendingBackup) {
      return;
    }
    try {
      const summary = await restoreBackupData(pendingBackup);
      setPendingBackup(null);
      setStatusMessage(
        `還原完成（合併帳戶 ${summary.accounts} 筆、分類 ${summary.categories} 筆、交易 ${summary.transactions} 筆、常用備註 ${summary.notePresets} 筆）`,
      );
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '還原備份失敗');
    }
  }

  async function processCsvFile(file: File) {
    try {
      const text = await file.text();
      const plan = planCsvImport(text, { transactions, categories, accounts });
      setPendingCsvPlan(plan);
      setPendingBackup(null);
      setErrorMessage(null);
    } catch (err) {
      setPendingCsvPlan(null);
      setErrorMessage(err instanceof Error ? err.message : '無法解析 CSV 檔案');
    }
  }

  async function handleTriggerImportCsv() {
    if (supportsOpenFilePicker()) {
      try {
        const file = await pickFileWithSystemPicker('CSV 檔案', 'text/csv', ['.csv']);
        if (file) {
          await processCsvFile(file);
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : '無法開啟 CSV 檔案');
      }
      return;
    }
    csvFileInputRef.current?.click();
  }

  async function handleSelectCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      return;
    }
    await processCsvFile(file);
  }

  async function handleConfirmCsvImport() {
    if (!pendingCsvPlan || pendingCsvPlan.items.length === 0) {
      return;
    }
    try {
      const result = await importCsvPlan(pendingCsvPlan);
      setPendingCsvPlan(null);
      const extras: string[] = [];
      if (result.createdAccountsCount > 0) {
        extras.push(`新建帳戶 ${result.createdAccountsCount} 個`);
      }
      if (result.createdCategoriesCount > 0) {
        extras.push(`新建分類 ${result.createdCategoriesCount} 個`);
      }
      const extraText = extras.length > 0 ? `，${extras.join('、')}` : '';
      setStatusMessage(`匯入完成（新增 ${result.importedCount} 筆交易${extraText}）`);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '匯入 CSV 失敗');
    }
  }

  return (
    <div className="space-y-4 pb-24">
      {statusMessage && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
          {statusMessage}
        </div>
      )}
      {errorMessage && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200">
          {errorMessage}
        </div>
      )}

      {/* 外觀設定 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">外觀</h2>
          <button
            type="button"
            onClick={() => {
              void resetAmountColors().then(() => {
                setStatusMessage('已恢復預設金額顏色');
                setErrorMessage(null);
              });
            }}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            恢復預設
          </button>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/50">
            <label
              htmlFor="color-expense"
              className="text-sm font-medium text-slate-700 dark:text-slate-200"
            >
              支出顏色
            </label>
            <div className="flex items-center gap-3">
              <span
                className="text-sm font-semibold tabular-nums"
                style={{ color: amountColors.expense }}
              >
                NT$1,234
              </span>
              <input
                id="color-expense"
                type="color"
                aria-label="支出顏色"
                value={amountColors.expense.toLowerCase()}
                onChange={(e) => {
                  void saveAmountColors({ expense: e.target.value }).catch((err) => {
                    setErrorMessage(err instanceof Error ? err.message : '儲存顏色失敗');
                  });
                }}
                className="h-8 w-10 cursor-pointer rounded border border-slate-200 bg-transparent p-0.5 dark:border-slate-700"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/50">
            <label
              htmlFor="color-income"
              className="text-sm font-medium text-slate-700 dark:text-slate-200"
            >
              收入顏色
            </label>
            <div className="flex items-center gap-3">
              <span
                className="text-sm font-semibold tabular-nums"
                style={{ color: amountColors.income }}
              >
                NT$1,234
              </span>
              <input
                id="color-income"
                type="color"
                aria-label="收入顏色"
                value={amountColors.income.toLowerCase()}
                onChange={(e) => {
                  void saveAmountColors({ income: e.target.value }).catch((err) => {
                    setErrorMessage(err instanceof Error ? err.message : '儲存顏色失敗');
                  });
                }}
                className="h-8 w-10 cursor-pointer rounded border border-slate-200 bg-transparent p-0.5 dark:border-slate-700"
              />
            </div>
          </div>
        </div>
      </section>

      {/* 分類管理 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">分類管理</h2>
          <button
            type="button"
            onClick={openCreateCategory}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
          >
            ＋ 新增分類
          </button>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {(['expense', 'income'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => {
                setCatTab(kind);
                setCatFormOpen(false);
              }}
              className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                catTab === kind
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {kind === 'expense' ? '支出分類' : '收入分類'}
            </button>
          ))}
        </div>

        {catFormOpen && (
          <form
            onSubmit={handleSaveCategory}
            className="mb-3 space-y-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60"
          >
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              {editingCatId ? '編輯分類' : '新增分類'}
            </div>
            <div className="grid grid-cols-4 gap-2">
              <input
                type="text"
                aria-label="分類圖示"
                placeholder="Emoji"
                value={catIcon}
                onChange={(e) => setCatIcon(e.target.value)}
                className="col-span-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-center text-sm dark:border-slate-700 dark:bg-slate-900"
              />
              <input
                type="text"
                aria-label="分類名稱"
                placeholder="分類名稱"
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                className="col-span-3 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <select
                aria-label="上層分類"
                value={catParentId}
                disabled={editingCategoryHasChildren}
                onChange={(e) => setCatParentId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                <option value="">設為第一層分類（無上層）</option>
                {parentCategories
                  .filter((p) => p.id !== editingCatId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      上層：{p.icon} {p.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCatFormOpen(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              >
                儲存
              </button>
            </div>
          </form>
        )}

        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {parentCategories.map((parent, pIdx) => {
            const children = childrenByParent.get(parent.id) ?? [];
            const parentInUse = usedCategoryIds.has(parent.id) || children.length > 0;
            return (
              <div key={parent.id} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span>{parent.icon}</span>
                    <span
                      className={`truncate text-sm font-medium ${
                        parent.archived
                          ? 'text-slate-400 line-through'
                          : 'text-slate-900 dark:text-slate-100'
                      }`}
                    >
                      {parent.name}
                    </span>
                    {parent.archived && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800">
                        已停用
                      </span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1 text-xs">
                    <button
                      type="button"
                      disabled={pIdx === 0}
                      onClick={() => void swapCategorySortOrder(parent.id, parentCategories[pIdx - 1]!.id)}
                      aria-label={`上移 ${parent.name}`}
                      className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={pIdx === parentCategories.length - 1}
                      onClick={() => void swapCategorySortOrder(parent.id, parentCategories[pIdx + 1]!.id)}
                      aria-label={`下移 ${parent.name}`}
                      className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditCategory(parent)}
                      className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      編輯
                    </button>
                    <button
                      type="button"
                      onClick={() => void archiveCategory(parent.id, !parent.archived)}
                      className="rounded px-2 py-1 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-slate-800"
                    >
                      {parent.archived ? '啟用' : '停用'}
                    </button>
                    {!parentInUse && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteCategory(parent.id)}
                        className="rounded px-2 py-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-slate-800"
                      >
                        刪除
                      </button>
                    )}
                  </div>
                </div>

                {children.length > 0 && (
                  <div className="mt-1.5 space-y-1.5 pl-6">
                    {children.map((child, cIdx) => {
                      const childInUse = usedCategoryIds.has(child.id);
                      return (
                        <div key={child.id} className="flex items-center justify-between gap-2 text-xs">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="text-slate-400">└</span>
                            <span>{child.icon}</span>
                            <span
                              className={`truncate ${
                                child.archived
                                  ? 'text-slate-400 line-through'
                                  : 'text-slate-700 dark:text-slate-300'
                              }`}
                            >
                              {child.name}
                            </span>
                            {child.archived && (
                              <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800">
                                已停用
                              </span>
                            )}
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              disabled={cIdx === 0}
                              onClick={() => void swapCategorySortOrder(child.id, children[cIdx - 1]!.id)}
                              aria-label={`上移 ${child.name}`}
                              className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={cIdx === children.length - 1}
                              onClick={() => void swapCategorySortOrder(child.id, children[cIdx + 1]!.id)}
                              aria-label={`下移 ${child.name}`}
                              className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditCategory(child)}
                              className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                            >
                              編輯
                            </button>
                            <button
                              type="button"
                              onClick={() => void archiveCategory(child.id, !child.archived)}
                              className="rounded px-1.5 py-0.5 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-slate-800"
                            >
                              {child.archived ? '啟用' : '停用'}
                            </button>
                            {!childInUse && (
                              <button
                                type="button"
                                onClick={() => void handleDeleteCategory(child.id)}
                                className="rounded px-1.5 py-0.5 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-slate-800"
                              >
                                刪除
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 帳戶管理 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">帳戶管理</h2>
          <button
            type="button"
            onClick={openCreateAccount}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
          >
            ＋ 新增帳戶
          </button>
        </div>

        {accFormOpen && (
          <form
            onSubmit={handleSaveAccount}
            className="mb-3 space-y-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60"
          >
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              {editingAccId ? '編輯帳戶' : '新增帳戶'}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                aria-label="帳戶名稱"
                placeholder="帳戶名稱"
                value={accName}
                onChange={(e) => setAccName(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <select
                aria-label="帳戶類型"
                value={accType}
                onChange={(e) => setAccType(e.target.value as AccountType)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="cash">現金</option>
                <option value="bank">銀行帳戶</option>
                <option value="credit">信用卡</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                開帳餘額（整數）
              </label>
              <input
                type="number"
                step="1"
                aria-label="開帳餘額"
                value={accInitialBalance}
                onChange={(e) => setAccInitialBalance(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAccFormOpen(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              >
                儲存
              </button>
            </div>
          </form>
        )}

        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {sortedAccounts.map((acc, idx) => (
            <div key={acc.id} className="flex items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`truncate text-sm font-medium ${
                      acc.archived
                        ? 'text-slate-400 line-through'
                        : 'text-slate-900 dark:text-slate-100'
                    }`}
                  >
                    {acc.name}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {ACCOUNT_TYPE_LABELS[acc.type]}
                  </span>
                  {acc.archived && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800">
                      已停用
                    </span>
                  )}
                </div>
                <div className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  開帳餘額 {formatCurrency(acc.initialBalance)}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1 text-xs">
                <button
                  type="button"
                  disabled={idx === 0}
                  onClick={() => void swapAccountSortOrder(acc.id, sortedAccounts[idx - 1]!.id)}
                  aria-label={`上移 ${acc.name}`}
                  className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={idx === sortedAccounts.length - 1}
                  onClick={() => void swapAccountSortOrder(acc.id, sortedAccounts[idx + 1]!.id)}
                  aria-label={`下移 ${acc.name}`}
                  className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => openEditAccount(acc)}
                  className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  編輯
                </button>
                <button
                  type="button"
                  onClick={() => void archiveAccount(acc.id, !acc.archived)}
                  className="rounded px-2 py-1 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-slate-800"
                >
                  {acc.archived ? '啟用' : '停用'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 常用備註管理 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">常用備註</h2>
          <button
            type="button"
            onClick={openCreatePreset}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
          >
            ＋ 新增常用備註
          </button>
        </div>

        <label className="mb-3 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/50">
          <div>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
              自動加入常用備註
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              儲存支出或收入時自動記住新的備註文字
            </div>
          </div>
          <input
            type="checkbox"
            aria-label="自動加入常用備註"
            checked={autoAddNotePresets}
            onChange={(e) => {
              void setAutoAddNotePresets(e.target.checked);
            }}
            className="h-4 w-4 accent-emerald-600"
          />
        </label>

        {presetFormOpen && (
          <form
            onSubmit={handleSavePreset}
            className="mb-3 space-y-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60"
          >
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              {editingPresetId ? '編輯常用備註' : '新增常用備註'}
            </div>
            <input
              type="text"
              aria-label="常用備註文字"
              placeholder="輸入常用備註（最多 40 字）"
              maxLength={NOTE_PRESET_MAX_LENGTH}
              value={presetText}
              onChange={(e) => setPresetText(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <select
              aria-label="常用備註分類"
              value={presetCategoryId}
              onChange={(e) => setPresetCategoryId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <option value="">全部分類</option>
              {selectableCategories.map((cat) => {
                const parent = cat.parentId ? categoryMap.get(cat.parentId) : undefined;
                const kindLabel = cat.kind === 'expense' ? '支出' : '收入';
                const label = parent ? `${parent.name} > ${cat.name}` : cat.name;
                return (
                  <option key={cat.id} value={cat.id}>
                    [{kindLabel}] {cat.icon} {label}
                  </option>
                );
              })}
            </select>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPresetFormOpen(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              >
                儲存
              </button>
            </div>
          </form>
        )}

        {sortedNotePresets.length === 0 ? (
          <p className="py-2 text-xs text-slate-400 dark:text-slate-500">
            尚無常用備註，記帳時輸入備註會自動加入，或點擊右上方新增。
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {sortedNotePresets.map((preset, idx) => (
              <div key={preset.id} className="flex items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {preset.text}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {formatPresetCategoryLabel(preset.categoryId)}
                    </span>
                    <span className="tabular-nums">使用 {preset.useCount} 次</span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1 text-xs">
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() =>
                      void swapNotePresetSortOrder(preset.id, sortedNotePresets[idx - 1]!.id)
                    }
                    aria-label={`上移 ${preset.text}`}
                    className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={idx === sortedNotePresets.length - 1}
                    onClick={() =>
                      void swapNotePresetSortOrder(preset.id, sortedNotePresets[idx + 1]!.id)
                    }
                    aria-label={`下移 ${preset.text}`}
                    className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditPreset(preset)}
                    className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    編輯
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeletePreset(preset.id)}
                    className="rounded px-2 py-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-slate-800"
                  >
                    刪除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 資料 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">資料</h2>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <button
              type="button"
              onClick={() => void handleExportCsv()}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              存成 CSV（給 Excel）
            </button>
            <p className="mt-1 px-1 text-xs text-slate-500 dark:text-slate-400">
              匯出交易明細，可用 Excel 或試算表開啟
            </p>
          </div>

          <div>
            <button
              type="button"
              onClick={() => void handleExportJson()}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              存成 JSON 備份（完整還原用）
            </button>
            <p className="mt-1 px-1 text-xs text-slate-500 dark:text-slate-400">
              匯出所有帳戶、分類、交易與備註設定
            </p>
          </div>

          <div>
            <button
              type="button"
              onClick={() => void handleTriggerRestoreJson()}
              className="w-full rounded-xl border border-emerald-600 px-3 py-2.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
            >
              從 JSON 備份還原
            </button>
            <p className="mt-1 px-1 text-xs text-slate-500 dark:text-slate-400">
              以編號合併備份資料，不會清空現有紀錄
            </p>
          </div>

          <div>
            <button
              type="button"
              onClick={() => void handleTriggerImportCsv()}
              className="w-full rounded-xl border border-emerald-600 px-3 py-2.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
            >
              從 CSV 匯入
            </button>
            <p className="mt-1 px-1 text-xs text-slate-500 dark:text-slate-400">
              匯入本 App 匯出的 CSV 交易明細
            </p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={(e) => void handleSelectBackupFile(e)}
            className="hidden"
          />
          <input
            ref={csvFileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void handleSelectCsvFile(e)}
            className="hidden"
          />
        </div>

        {pendingBackup && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/50">
            <div className="text-xs font-semibold text-amber-900 dark:text-amber-200">
              確認還原備份資料
            </div>
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
              備份包含帳戶 {pendingBackup.accounts.length} 筆、分類 {pendingBackup.categories.length} 筆、交易{' '}
              {pendingBackup.transactions.length} 筆、常用備註 {pendingBackup.notePresets?.length ?? 0} 筆。將以 id 合併（同 id 取較新者），不會清空現有資料。
            </p>
            <div className="mt-2.5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingBackup(null)}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-700 hover:bg-amber-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmRestore()}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
              >
                確認還原
              </button>
            </div>
          </div>
        )}

        {pendingCsvPlan && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/50">
            <div className="text-xs font-semibold text-amber-900 dark:text-amber-200">
              CSV 匯入預覽
            </div>
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
              新增 {pendingCsvPlan.items.length} 筆、略過重複 {pendingCsvPlan.skippedDuplicates} 筆、錯誤{' '}
              {pendingCsvPlan.errors.length} 筆
            </p>

            {(pendingCsvPlan.newAccounts.length > 0 || pendingCsvPlan.newCategories.length > 0) && (
              <div className="mt-2 rounded-lg bg-white/70 p-2 text-xs text-amber-900 dark:bg-slate-900/50 dark:text-amber-200">
                <div className="font-semibold">將新建</div>
                {pendingCsvPlan.newAccounts.length > 0 && (
                  <div className="mt-1">
                    帳戶：{pendingCsvPlan.newAccounts.map((a) => a.name).join('、')}
                  </div>
                )}
                {pendingCsvPlan.newCategories.length > 0 && (
                  <div className="mt-1">
                    分類：
                    {pendingCsvPlan.newCategories
                      .map((c) => {
                        const kindLabel = c.kind === 'expense' ? '支出' : '收入';
                        return c.parentName
                          ? `[${kindLabel}] ${c.parentName} > ${c.name}`
                          : `[${kindLabel}] ${c.name}`;
                      })
                      .join('、')}
                  </div>
                )}
              </div>
            )}

            {pendingCsvPlan.errors.length > 0 && (
              <div className="mt-2 rounded-lg bg-red-50/90 p-2 text-xs text-red-700 dark:bg-red-950/60 dark:text-red-300">
                <div className="font-semibold">
                  錯誤明細{pendingCsvPlan.errors.length > 10 ? '（顯示前 10 筆）' : ''}
                </div>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {pendingCsvPlan.errors.slice(0, 10).map((err) => (
                    <li key={`${err.rowNumber}-${err.reason}`}>
                      第 {err.rowNumber} 行：{err.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-2.5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingCsvPlan(null)}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-700 hover:bg-amber-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                取消
              </button>
              <button
                type="button"
                disabled={pendingCsvPlan.items.length === 0}
                onClick={() => void handleConfirmCsvImport()}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                確認匯入
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Google 同步 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Google 同步</h2>
            {!syncState.configured ? (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                尚未設定 Google Client ID
              </p>
            ) : (
              <div className="mt-1 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                <div>目前狀態：{formatSyncStatusText(syncState)}</div>
                <div>
                  最後同步時間：
                  {syncState.lastSyncAt ? formatSyncTimeLabel(syncState.lastSyncAt) : '尚未同步'}
                </div>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {!syncState.configured ? (
              <button
                type="button"
                disabled
                className="cursor-not-allowed rounded-xl bg-slate-100 px-3.5 py-2 text-xs font-medium text-slate-400 dark:bg-slate-800 dark:text-slate-500"
              >
                登入 Google
              </button>
            ) : syncEnabled ? (
              <>
                <button
                  type="button"
                  disabled={syncState.status === 'syncing' || authBusy}
                  onClick={() => void triggerSync()}
                  className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {syncState.status === 'syncing' ? '同步中…' : '立即同步'}
                </button>
                {syncState.status === 'reauth' && (
                  <button
                    type="button"
                    disabled={authBusy}
                    onClick={() => {
                      setAuthBusy(true);
                      setErrorMessage(null);
                      void loginAndSync()
                        .catch((err) => {
                          setErrorMessage(err instanceof Error ? err.message : 'Google 登入失敗');
                        })
                        .finally(() => setAuthBusy(false));
                    }}
                    className="rounded-xl border border-amber-500 px-3 py-2 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:text-amber-300 dark:hover:bg-amber-950/40"
                  >
                    重新登入
                  </button>
                )}
                <button
                  type="button"
                  disabled={authBusy}
                  onClick={() => {
                    setAuthBusy(true);
                    void logoutAndClearSync().finally(() => setAuthBusy(false));
                  }}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  登出
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={authBusy}
                onClick={() => {
                  setAuthBusy(true);
                  setErrorMessage(null);
                  void loginAndSync()
                    .catch((err) => {
                      setErrorMessage(err instanceof Error ? err.message : 'Google 登入失敗');
                    })
                    .finally(() => setAuthBusy(false));
                }}
                className="rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {authBusy ? '登入中…' : '登入 Google'}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
