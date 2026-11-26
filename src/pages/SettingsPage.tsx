import { useMemo, useRef, useState } from 'react';
import {
  archiveAccount,
  archiveCategory,
  type BackupPayload,
  exportBackupData,
  parseBackupPayload,
  restoreBackupData,
  saveAccount,
  saveCategory,
  softDeleteCategory,
  swapAccountSortOrder,
  swapCategorySortOrder,
} from '../db/repository';
import type { Account, AccountType, Category, CategoryKind, Transaction } from '../db/types';
import { formatCurrency, getTodayDateString, toCsv } from '../domain';
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
}

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: '現金',
  bank: '銀行帳戶',
  credit: '信用卡',
};

function getCompactDateStamp(): string {
  return getTodayDateString().replace(/-/g, '');
}

function downloadBlob(content: string, mimeType: string, filename: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function SettingsPage({ accounts, categories, transactions }: SettingsPageProps) {
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

  const [pendingBackup, setPendingBackup] = useState<BackupPayload | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  function handleExportCsv() {
    const csv = toCsv(transactions, categories, accounts);
    downloadBlob(csv, 'text/csv;charset=utf-8;', `記帳_${getCompactDateStamp()}.csv`);
    setStatusMessage('已匯出 CSV 檔案');
    setErrorMessage(null);
  }

  async function handleExportJson() {
    const payload = await exportBackupData();
    const json = JSON.stringify(payload, null, 2);
    downloadBlob(json, 'application/json;charset=utf-8;', `記帳備份_${getCompactDateStamp()}.json`);
    setStatusMessage('已匯出 JSON 備份');
    setErrorMessage(null);
  }

  async function handleSelectBackupFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const payload = parseBackupPayload(parsed);
      setPendingBackup(payload);
      setErrorMessage(null);
    } catch (err) {
      setPendingBackup(null);
      setErrorMessage(err instanceof Error ? err.message : '無法解析備份檔案');
    }
  }

  async function handleConfirmRestore() {
    if (!pendingBackup) {
      return;
    }
    try {
      const summary = await restoreBackupData(pendingBackup);
      setPendingBackup(null);
      setStatusMessage(
        `還原完成（合併帳戶 ${summary.accounts} 筆、分類 ${summary.categories} 筆、交易 ${summary.transactions} 筆）`,
      );
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '還原備份失敗');
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

      {/* 資料匯出與備份 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
          資料匯出與備份
        </h2>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button
            type="button"
            onClick={handleExportCsv}
            className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            匯出 CSV
          </button>
          <button
            type="button"
            onClick={() => void handleExportJson()}
            className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            匯出 JSON 備份
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-xl border border-emerald-600 px-3 py-2.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
          >
            還原 JSON 備份
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={(e) => void handleSelectBackupFile(e)}
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
              {pendingBackup.transactions.length} 筆。將以 id 合併（同 id 取較新者），不會清空現有資料。
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
