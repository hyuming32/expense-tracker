import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CloudRestoreModal } from '../components/CloudRestoreModal';
import { useMoney, usePrivacy } from '../contexts/PrivacyContext';
import {
  type AmountColors,
  archiveAccount,
  archiveCategory,
  archivePlace,
  type BackupPayload,
  clearPinRecord,
  endRecurringRule,
  exportBackupData,
  importCsvPlan,
  NOTE_PRESET_MAX_LENGTH,
  parseBackupPayload,
  pauseRecurringRule,
  recordJsonBackupTimestamp,
  resetAmountColors,
  resetHomeLayout,
  restoreBackupData,
  saveAccount,
  saveAmountColors,
  saveBudgets,
  saveCategory,
  saveHomeLayout,
  saveNotePreset,
  savePinRecord,
  savePlace,
  setAutoAddNotePresets,
  setAutoSelectLastPlace,
  setSyncSchedule,
  softDeleteCategory,
  softDeleteNotePreset,
  softDeletePlace,
  softDeleteRecurringRule,
  softDeleteShortcut,
  swapAccountSortOrder,
  swapCategorySortOrder,
  swapNotePresetSortOrder,
  swapPlaceSortOrder,
  swapShortcutSortOrder,
  type SyncSchedule,
} from '../db/repository';
import type {
  Account,
  AccountType,
  Budget,
  Category,
  CategoryKind,
  NotePreset,
  Place,
  RecurringRule,
  Shortcut,
  Transaction,
} from '../db/types';
import {
  type CsvImportPlan,
  formatRecurringFrequency,
  getNextOccurrenceDate,
  getRecurringRuleStatus,
  getTodayDateString,
  HOME_SECTION_META,
  type HomeLayoutItem,
  type HomeSectionKey,
  isValidSellerId,
  PLACE_NAME_MAX_LENGTH,
  planCsvImport,
  toCsv,
} from '../domain';
import {
  useLastDriveBackupAt,
  useOutboxCount,
  usePinRecord,
  useSyncSchedule,
} from '../hooks/useExpenseData';
import { pickFileWithSystemPicker, saveFile, supportsOpenFilePicker } from '../lib/fileSave';
import { hashPin, isValidPinFormat, verifyPin } from '../lib/pinLock';
import { getStoragePersistedStatus } from '../lib/storagePersist';
import { DriveAuthCancelledError, isSyncEnabled } from '../sync/auth';
import { backupToGoogleDrive } from '../sync/driveBackup';
import {
  formatSyncStatusText,
  formatSyncTimeLabel,
  loginAndSync,
  logoutAndClearSync,
  toFriendlySyncError,
  triggerSync,
  useSyncState,
} from '../sync/syncManager';

interface SettingsPageProps {
  accounts: readonly Account[];
  categories: readonly Category[];
  places: readonly Place[];
  budgets: readonly Budget[];
  autoSelectLastPlace: boolean;
  homeLayout: readonly HomeLayoutItem<HomeSectionKey>[];
  transactions: readonly Transaction[];
  amountColors: AmountColors;
  notePresets: readonly NotePreset[];
  autoAddNotePresets: boolean;
  recurringRules: readonly RecurringRule[];
  shortcuts: readonly Shortcut[];
  onOpenCreateRecurring: () => void;
  onEditRecurring: (rule: RecurringRule) => void;
  onOpenCreateShortcut: () => void;
  onEditShortcut: (shortcut: Shortcut) => void;
  onReplayOnboarding: () => void;
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
  places,
  budgets,
  autoSelectLastPlace,
  homeLayout,
  transactions,
  amountColors,
  notePresets,
  autoAddNotePresets,
  recurringRules,
  shortcuts,
  onOpenCreateRecurring,
  onEditRecurring,
  onOpenCreateShortcut,
  onEditShortcut,
  onReplayOnboarding,
}: SettingsPageProps) {
  const formatMoney = useMoney();
  const { defaultHideAmounts, setDefaultHideAmounts } = usePrivacy();
  const pinRecord = usePinRecord();
  const [searchParams] = useSearchParams();
  const [pinMode, setPinMode] = useState<'idle' | 'enable' | 'change' | 'disable'>('idle');
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);

  function resetPinForm() {
    setPinMode('idle');
    setOldPin('');
    setNewPin('');
    setConfirmPin('');
    setPinError(null);
  }

  async function handleToggleHomeSection(key: HomeSectionKey) {
    const next = homeLayout.map((item) =>
      item.key === key ? { ...item, visible: !item.visible } : item,
    );
    await saveHomeLayout(next);
  }

  async function handleMoveHomeSection(index: number, delta: -1 | 1) {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= homeLayout.length) {
      return;
    }
    const next = [...homeLayout];
    const current = next[index]!;
    next[index] = next[targetIndex]!;
    next[targetIndex] = current;
    await saveHomeLayout(next);
  }

  async function handleResetHomeLayout() {
    await resetHomeLayout();
    setStatusMessage('已恢復首頁預設顯示與順序');
  }

  async function handleSubmitPinForm(e: FormEvent) {
    e.preventDefault();
    if (pinBusy) {
      return;
    }
    setPinError(null);
    setPinBusy(true);
    try {
      if (pinMode === 'change' || pinMode === 'disable') {
        if (!pinRecord) {
          setPinError('尚未設定密碼鎖');
          return;
        }
        if (!isValidPinFormat(oldPin)) {
          setPinError('請輸入 4 位數字舊密碼');
          return;
        }
        const verified = await verifyPin(oldPin, pinRecord);
        if (!verified) {
          setPinError('舊密碼錯誤');
          return;
        }
        if (pinMode === 'disable') {
          await clearPinRecord();
          resetPinForm();
          setStatusMessage('已關閉密碼鎖');
          return;
        }
      }

      if (pinMode === 'enable' || pinMode === 'change') {
        if (!isValidPinFormat(newPin)) {
          setPinError('新密碼必須為 4 位數字');
          return;
        }
        if (newPin !== confirmPin) {
          setPinError('兩次輸入的密碼不一致');
          return;
        }
        const record = await hashPin(newPin);
        await savePinRecord(record);
        resetPinForm();
        setStatusMessage(pinMode === 'enable' ? '已開啟密碼鎖' : '已更新密碼鎖');
      }
    } finally {
      setPinBusy(false);
    }
  }
  const budgetSectionRef = useRef<HTMLElement | null>(null);
  const [totalBudgetInput, setTotalBudgetInput] = useState('');
  const [categoryBudgetInputs, setCategoryBudgetInputs] = useState<Record<string, string>>({});
  const [budgetSaving, setBudgetSaving] = useState(false);
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

  const [placeFormOpen, setPlaceFormOpen] = useState(false);
  const [editingPlaceId, setEditingPlaceId] = useState<string | null>(null);
  const [placeName, setPlaceName] = useState('');
  const [placeIcon, setPlaceIcon] = useState('📍');
  const [placeSellerIds, setPlaceSellerIds] = useState<string[]>([]);
  const [newSellerIdInput, setNewSellerIdInput] = useState('');

  const [pendingBackup, setPendingBackup] = useState<BackupPayload | null>(null);
  const [cloudRestoreOpen, setCloudRestoreOpen] = useState(false);
  const [pendingCsvPlan, setPendingCsvPlan] = useState<CsvImportPlan | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [driveBackupBusy, setDriveBackupBusy] = useState(false);
  const [persistedStatus, setPersistedStatus] = useState<boolean | null>(null);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );

  useEffect(() => {
    void getStoragePersistedStatus().then((status) => {
      setPersistedStatus(status);
    });
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvFileInputRef = useRef<HTMLInputElement>(null);
  const syncState = useSyncState();
  const syncEnabled = isSyncEnabled();
  const syncSchedule = useSyncSchedule();
  const outboxCount = useOutboxCount();
  const lastDriveBackupAt = useLastDriveBackupAt();

  const expenseRootCategories = useMemo(
    () =>
      categories
        .filter((c) => !c.deleted && !c.archived && c.kind === 'expense' && c.parentId === null)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [categories],
  );

  useEffect(() => {
    const total = budgets.find((b) => !b.deleted && b.categoryId === null);
    setTotalBudgetInput(total && total.amount > 0 ? String(total.amount) : '');
    const nextMap: Record<string, string> = {};
    for (const b of budgets) {
      if (!b.deleted && b.categoryId !== null && b.amount > 0) {
        nextMap[b.categoryId] = String(b.amount);
      }
    }
    setCategoryBudgetInputs(nextMap);
  }, [budgets]);

  useEffect(() => {
    if (searchParams.get('section') === 'budget' && budgetSectionRef.current) {
      budgetSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [searchParams]);

  async function handleSaveBudgets() {
    setBudgetSaving(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const parseAmount = (raw: string, label: string): number | null => {
        const trimmed = raw.trim();
        if (trimmed === '') {
          return null;
        }
        const num = Number(trimmed);
        if (!Number.isInteger(num) || num < 0) {
          throw new Error(`${label}需為非負整數`);
        }
        return num;
      };

      const inputs = [
        { categoryId: null, amount: parseAmount(totalBudgetInput, '每月總預算') },
        ...expenseRootCategories.map((cat) => ({
          categoryId: cat.id,
          amount: parseAmount(categoryBudgetInputs[cat.id] ?? '', `${cat.name}預算`),
        })),
      ];

      await saveBudgets(inputs);
      setStatusMessage('已儲存每月預算');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '儲存每月預算失敗');
    } finally {
      setBudgetSaving(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const usedCategoryIds = useMemo(() => {
    const set = new Set<string>();
    for (const tx of transactions) {
      if (!tx.deleted && tx.categoryId) {
        set.add(tx.categoryId);
      }
    }
    return set;
  }, [transactions]);

  const usedPlaceIds = useMemo(() => {
    const set = new Set<string>();
    for (const tx of transactions) {
      if (!tx.deleted && tx.placeId) {
        set.add(tx.placeId);
      }
    }
    return set;
  }, [transactions]);

  const sortedPlaces = useMemo(
    () => [...places].sort((a, b) => a.sortOrder - b.sortOrder),
    [places],
  );

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

  function openCreatePlace() {
    setEditingPlaceId(null);
    setPlaceName('');
    setPlaceIcon('📍');
    setPlaceSellerIds([]);
    setNewSellerIdInput('');
    setPlaceFormOpen(true);
    setErrorMessage(null);
  }

  function openEditPlace(place: Place) {
    setEditingPlaceId(place.id);
    setPlaceName(place.name);
    setPlaceIcon(place.icon);
    setPlaceSellerIds(place.sellerIds ?? []);
    setNewSellerIdInput('');
    setPlaceFormOpen(true);
    setErrorMessage(null);
  }

  function handleAddSellerIdToForm() {
    const trimmed = newSellerIdInput.trim();
    if (!isValidSellerId(trimmed)) {
      setErrorMessage('統一編號需為 8 位數字');
      return;
    }
    if (placeSellerIds.includes(trimmed)) {
      setNewSellerIdInput('');
      return;
    }
    const conflict = places.find(
      (p) => !p.deleted && p.id !== editingPlaceId && (p.sellerIds ?? []).includes(trimmed),
    );
    if (conflict) {
      setErrorMessage(`統一編號 ${trimmed} 已綁定至「${conflict.name}」`);
      return;
    }
    setPlaceSellerIds((prev) => [...prev, trimmed]);
    setNewSellerIdInput('');
    setErrorMessage(null);
  }

  async function handleSavePlace(e: React.FormEvent) {
    e.preventDefault();
    if (!placeName.trim()) {
      setErrorMessage('請輸入地點名稱');
      return;
    }
    try {
      await savePlace({
        id: editingPlaceId ?? undefined,
        name: placeName,
        icon: placeIcon,
        sellerIds: placeSellerIds,
      });
      setPlaceFormOpen(false);
      setStatusMessage(editingPlaceId ? '已更新地點' : '已新增地點');
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '儲存地點失敗');
    }
  }

  async function handleDeletePlace(id: string) {
    try {
      await softDeletePlace(id);
      setStatusMessage('已刪除地點');
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '無法刪除地點');
    }
  }

  async function handleExportCsv() {
    try {
      const csv = toCsv(transactions, categories, accounts, places);
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
        await recordJsonBackupTimestamp();
        setStatusMessage('已存檔');
        setErrorMessage(null);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '存檔失敗');
    }
  }

  async function handleBackupToDrive() {
    if (!isOnline || driveBackupBusy) {
      return;
    }
    setDriveBackupBusy(true);
    setErrorMessage(null);
    try {
      const result = await backupToGoogleDrive();
      setStatusMessage(`已備份：${result.fileName}（Drive › 記帳備份）`);
    } catch (err) {
      if (err instanceof DriveAuthCancelledError) {
        setErrorMessage('未授權，無法備份到 Drive');
      } else if (
        err instanceof Error &&
        (err.message === '尚未設定 Google Client ID' || err.message === 'Google 登入元件尚未載入')
      ) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage(`備份失敗：${toFriendlySyncError(err)}`);
      }
    } finally {
      setDriveBackupBusy(false);
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
      const plan = planCsvImport(text, { transactions, categories, accounts, places });
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
      if (result.createdPlacesCount > 0) {
        extras.push(`新建地點 ${result.createdPlacesCount} 個`);
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

      {/* 載具與會員卡入口 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <Link
          to="/cards"
          className="flex items-center justify-between text-sm font-semibold text-slate-900 hover:text-emerald-600 dark:text-slate-100 dark:hover:text-emerald-400"
        >
          <span>💳 載具與會員卡</span>
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">管理 →</span>
        </Link>
      </section>

      {/* 發票兌獎入口 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <Link
          to="/lottery"
          className="flex items-center justify-between text-sm font-semibold text-slate-900 hover:text-emerald-600 dark:text-slate-100 dark:hover:text-emerald-400"
        >
          <span>🎟️ 發票兌獎（手動輸入／截圖辨識）</span>
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">開啟 →</span>
        </Link>
      </section>

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

      {/* 首頁顯示 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">首頁顯示</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              自訂首頁要顯示的區塊與排列順序（僅儲存於本機）
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleResetHomeLayout()}
            className="shrink-0 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            恢復預設
          </button>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {homeLayout.map((item, idx) => {
            const meta = HOME_SECTION_META[item.key];
            return (
              <div
                key={item.key}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={item.visible}
                    onChange={() => void handleToggleHomeSection(item.key)}
                    aria-label={`顯示 ${meta.label}`}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                      {meta.label}
                    </div>
                    {meta.hideWarning && (
                      <div className="text-[11px] text-amber-600 dark:text-amber-400">
                        {meta.hideWarning}
                      </div>
                    )}
                  </div>
                </label>

                <div className="flex shrink-0 items-center gap-1 text-xs">
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => void handleMoveHomeSection(idx, -1)}
                    aria-label={`上移 ${meta.label}`}
                    className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={idx === homeLayout.length - 1}
                    onClick={() => void handleMoveHomeSection(idx, 1)}
                    aria-label={`下移 ${meta.label}`}
                    className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                  >
                    ↓
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 隱私 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">隱私</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            僅儲存於這台裝置，不會同步到雲端或放進 JSON 備份
          </p>
        </div>

        <div className="space-y-3">
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/50">
            <div>
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                預設隱藏金額
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                開啟 App 時自動隱藏所有顯示金額（可於首頁右上角暫時切換）
              </div>
            </div>
            <input
              type="checkbox"
              aria-label="預設隱藏金額"
              checked={defaultHideAmounts}
              onChange={(e) => {
                void setDefaultHideAmounts(e.target.checked);
              }}
              className="h-4 w-4 accent-emerald-600"
            />
          </label>

          <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  4 位數密碼鎖
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {pinRecord
                    ? '已開啟（開啟 App 或背景超過 60 秒回來時需輸入密碼）'
                    : '未開啟'}
                </div>
              </div>

              {pinMode === 'idle' && (
                <div className="flex items-center gap-2">
                  {!pinRecord ? (
                    <button
                      type="button"
                      onClick={() => {
                        resetPinForm();
                        setPinMode('enable');
                      }}
                      className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                    >
                      開啟密碼鎖
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          resetPinForm();
                          setPinMode('change');
                        }}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        修改密碼
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          resetPinForm();
                          setPinMode('disable');
                        }}
                        className="rounded-xl border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        關閉密碼鎖
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {pinMode !== 'idle' && (
              <form onSubmit={(e) => void handleSubmitPinForm(e)} className="mt-3 space-y-2.5 border-t border-slate-200 pt-3 dark:border-slate-700">
                {(pinMode === 'change' || pinMode === 'disable') && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                      輸入舊密碼（4 位數字）
                    </label>
                    <input
                      type="password"
                      inputMode="numeric"
                      maxLength={4}
                      value={oldPin}
                      onChange={(e) => setOldPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      placeholder="••••"
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm tracking-widest dark:border-slate-700 dark:bg-slate-900"
                    />
                  </div>
                )}

                {(pinMode === 'enable' || pinMode === 'change') && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                        輸入新密碼（4 位數字）
                      </label>
                      <input
                        type="password"
                        inputMode="numeric"
                        maxLength={4}
                        value={newPin}
                        onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="••••"
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm tracking-widest dark:border-slate-700 dark:bg-slate-900"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                        再次確認新密碼
                      </label>
                      <input
                        type="password"
                        inputMode="numeric"
                        maxLength={4}
                        value={confirmPin}
                        onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="••••"
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm tracking-widest dark:border-slate-700 dark:bg-slate-900"
                      />
                    </div>
                  </div>
                )}

                {pinError && (
                  <p className="text-xs font-medium text-red-600 dark:text-red-400">{pinError}</p>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={resetPinForm}
                    className="rounded-xl px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-700"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={pinBusy}
                    className={`rounded-xl px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
                      pinMode === 'disable'
                        ? 'bg-red-600 hover:bg-red-700'
                        : 'bg-emerald-600 hover:bg-emerald-700'
                    }`}
                  >
                    {pinBusy ? '處理中…' : pinMode === 'disable' ? '確認關閉' : '儲存密碼'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </section>

      {/* 每月預算設定 */}
      <section
        id="budget-section"
        ref={budgetSectionRef}
        className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">每月預算</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              空白或輸入 0 代表不設預算，子分類支出會併入主分類計算
            </p>
          </div>
          <button
            type="button"
            disabled={budgetSaving}
            onClick={() => void handleSaveBudgets()}
            className="shrink-0 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {budgetSaving ? '儲存中…' : '儲存預算'}
          </button>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/60">
            <label
              htmlFor="budget-total-input"
              className="text-sm font-semibold text-slate-900 dark:text-slate-100"
            >
              每月總預算
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-400">NT$</span>
              <input
                id="budget-total-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={totalBudgetInput}
                onChange={(e) => setTotalBudgetInput(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="不設"
                className="w-28 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-right text-sm tabular-nums text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div className="space-y-2">
            {expenseRootCategories.map((cat) => (
              <div
                key={cat.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/40"
              >
                <label
                  htmlFor={`budget-cat-${cat.id}`}
                  className="flex min-w-0 items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
                >
                  <span className="shrink-0">{cat.icon}</span>
                  <span className="truncate">{cat.name}</span>
                </label>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-400">NT$</span>
                  <input
                    id={`budget-cat-${cat.id}`}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={categoryBudgetInputs[cat.id] ?? ''}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^\d]/g, '');
                      setCategoryBudgetInputs((prev) => ({ ...prev, [cat.id]: val }));
                    }}
                    placeholder="不設"
                    className="w-28 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-right text-sm tabular-nums text-slate-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 週期性收支 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">週期性收支</h2>
          <button
            type="button"
            onClick={onOpenCreateRecurring}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
          >
            ＋ 新增規則
          </button>
        </div>

        {recurringRules.length === 0 ? (
          <div className="py-4 text-center text-xs text-slate-500 dark:text-slate-400">
            尚未設定週期性收支（例如房租、訂閱、薪水）
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {recurringRules.map((rule) => {
              const today = getTodayDateString();
              const status = getRecurringRuleStatus(rule, today);
              const nextDate = getNextOccurrenceDate(rule, today);
              const category = rule.categoryId ? categoryMap.get(rule.categoryId) : undefined;
              const displayName =
                rule.note ||
                (rule.kind === 'transfer' ? '定期轉帳' : (category?.name ?? '週期收支'));

              const statusLabel =
                status === 'active' ? '啟用' : status === 'paused' ? '暫停' : '已結束';
              const statusBadgeClass =
                status === 'active'
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                  : status === 'paused'
                    ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';

              return (
                <div key={rule.id} className="space-y-2 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                          {displayName}
                        </span>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeClass}`}>
                          {statusLabel}
                        </span>
                        {!rule.autoPost && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                            待確認
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {formatRecurringFrequency(rule)} · 下次：{nextDate ?? '—'}
                      </div>
                    </div>

                    <span
                      className="shrink-0 text-sm font-semibold tabular-nums"
                      style={
                        rule.kind === 'expense'
                          ? { color: amountColors.expense }
                          : rule.kind === 'income'
                            ? { color: amountColors.income }
                            : undefined
                      }
                    >
                      {formatMoney(rule.amount)}
                    </span>
                  </div>

                  <div className="flex flex-wrap justify-end gap-1.5 text-xs">
                    <button
                      type="button"
                      onClick={() => onEditRecurring(rule)}
                      className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      編輯
                    </button>
                    {status !== 'ended' && (
                      <button
                        type="button"
                        onClick={() => void pauseRecurringRule(rule.id, !rule.paused)}
                        className="rounded px-2 py-1 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-slate-800"
                      >
                        {rule.paused ? '恢復' : '暫停'}
                      </button>
                    )}
                    {status !== 'ended' && (
                      <button
                        type="button"
                        onClick={() => void endRecurringRule(rule.id, today)}
                        className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        結束
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void softDeleteRecurringRule(rule.id)}
                      className="rounded px-2 py-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-slate-800"
                    >
                      刪除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
                  開帳餘額 {formatMoney(acc.initialBalance)}
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

      {/* 地點管理 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">地點管理</h2>
          <button
            type="button"
            onClick={openCreatePlace}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
          >
            ＋ 新增地點
          </button>
        </div>

        <label className="mb-3 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/50">
          <div>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
              新增記帳時自動帶入上次的地點
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              開啟後，每次開新記帳面板會自動選取上次使用的地點
            </div>
          </div>
          <input
            type="checkbox"
            aria-label="新增記帳時自動帶入上次的地點"
            checked={autoSelectLastPlace}
            onChange={(e) => {
              void setAutoSelectLastPlace(e.target.checked);
            }}
            className="h-4 w-4 accent-emerald-600"
          />
        </label>

        {placeFormOpen && (
          <form
            onSubmit={handleSavePlace}
            className="mb-3 space-y-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60"
          >
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              {editingPlaceId ? '編輯地點' : '新增地點'}
            </div>
            <div className="grid grid-cols-4 gap-2">
              <input
                type="text"
                aria-label="地點圖示"
                placeholder="Emoji"
                value={placeIcon}
                onChange={(e) => setPlaceIcon(e.target.value)}
                className="col-span-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-center text-sm dark:border-slate-700 dark:bg-slate-900"
              />
              <input
                type="text"
                aria-label="地點名稱"
                placeholder="地點名稱（最多 30 字）"
                maxLength={PLACE_NAME_MAX_LENGTH}
                value={placeName}
                onChange={(e) => setPlaceName(e.target.value)}
                className="col-span-3 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="space-y-1.5">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                綁定發票賣方統編（8 位數字，掃描發票時自動選取）
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="新增綁定統編"
                  placeholder="輸入 8 位數統編（例如 12345678）"
                  maxLength={8}
                  value={newSellerIdInput}
                  onChange={(e) => setNewSellerIdInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddSellerIdToForm();
                    }
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs tabular-nums dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={handleAddSellerIdToForm}
                  className="shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  加入統編
                </button>
              </div>
              {placeSellerIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {placeSellerIds.map((sid) => (
                    <span
                      key={sid}
                      className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs tabular-nums text-slate-700 border border-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    >
                      <span>{sid}</span>
                      <button
                        type="button"
                        aria-label={`移除統編 ${sid}`}
                        onClick={() =>
                          setPlaceSellerIds((prev) => prev.filter((item) => item !== sid))
                        }
                        className="text-slate-400 hover:text-red-500"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPlaceFormOpen(false)}
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

        {sortedPlaces.length === 0 ? (
          <p className="py-2 text-xs text-slate-400 dark:text-slate-500">
            尚無地點，可在記帳時快選列新增，或點擊右上方新增。
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {sortedPlaces.map((place, idx) => {
              const inUse = usedPlaceIds.has(place.id);
              const sellerIds = place.sellerIds ?? [];
              return (
                <div key={place.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span>{place.icon}</span>
                      <span
                        className={`truncate text-sm font-medium ${
                          place.archived
                            ? 'text-slate-400 line-through'
                            : 'text-slate-900 dark:text-slate-100'
                        }`}
                      >
                        {place.name}
                      </span>
                      {place.archived && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800">
                          已停用
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="tabular-nums">使用 {place.useCount} 次</span>
                      {sellerIds.length > 0 && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          統編：{sellerIds.join('、')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1 text-xs">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => void swapPlaceSortOrder(place.id, sortedPlaces[idx - 1]!.id)}
                      aria-label={`上移 ${place.name}`}
                      className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={idx === sortedPlaces.length - 1}
                      onClick={() => void swapPlaceSortOrder(place.id, sortedPlaces[idx + 1]!.id)}
                      aria-label={`下移 ${place.name}`}
                      className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditPlace(place)}
                      className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      編輯
                    </button>
                    <button
                      type="button"
                      onClick={() => void archivePlace(place.id, !place.archived)}
                      className="rounded px-2 py-1 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-slate-800"
                    >
                      {place.archived ? '啟用' : '停用'}
                    </button>
                    {!inUse && (
                      <button
                        type="button"
                        onClick={() => void handleDeletePlace(place.id)}
                        className="rounded px-2 py-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-slate-800"
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

      {/* 首頁捷徑管理 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">首頁捷徑</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              首頁「＋」上方最多顯示前 8 個捷徑
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenCreateShortcut}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
          >
            ＋ 新增捷徑
          </button>
        </div>

        {shortcuts.length === 0 ? (
          <p className="py-2 text-xs text-slate-400 dark:text-slate-500">
            尚無首頁捷徑，點擊右上方新增或於記帳後點「存成捷徑」。
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {shortcuts.map((shortcut, idx) => {
              const cat = shortcut.categoryId ? categoryMap.get(shortcut.categoryId) : undefined;
              const acc = accounts.find((a) => a.id === shortcut.accountId);
              const toAcc = shortcut.toAccountId
                ? accounts.find((a) => a.id === shortcut.toAccountId)
                : undefined;
              const detailText =
                shortcut.kind === 'transfer'
                  ? `${acc?.name ?? '帳戶'} → ${toAcc?.name ?? '帳戶'}`
                  : `${cat?.name ?? '分類'} · ${acc?.name ?? '帳戶'}`;

              return (
                <div key={shortcut.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      <span>{shortcut.icon}</span>
                      <span className="truncate">{shortcut.label}</span>
                      <span
                        className="shrink-0 text-xs font-semibold tabular-nums"
                        style={
                          shortcut.amount !== null
                            ? shortcut.kind === 'expense'
                              ? { color: amountColors.expense }
                              : shortcut.kind === 'income'
                                ? { color: amountColors.income }
                                : undefined
                            : undefined
                        }
                      >
                        {shortcut.amount !== null ? formatMoney(shortcut.amount) : '每次輸入'}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                      {detailText}
                      {shortcut.note ? ` · ${shortcut.note}` : ''}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1 text-xs">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => void swapShortcutSortOrder(shortcut.id, shortcuts[idx - 1]!.id)}
                      aria-label={`上移 ${shortcut.label}`}
                      className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={idx === shortcuts.length - 1}
                      onClick={() => void swapShortcutSortOrder(shortcut.id, shortcuts[idx + 1]!.id)}
                      aria-label={`下移 ${shortcut.label}`}
                      className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditShortcut(shortcut)}
                      className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      編輯
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void softDeleteShortcut(shortcut.id);
                        setStatusMessage('已刪除捷徑');
                      }}
                      className="rounded px-2 py-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-slate-800"
                    >
                      刪除
                    </button>
                  </div>
                </div>
              );
            })}
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

          <div className="sm:col-span-2">
            <button
              type="button"
              disabled={!isOnline || driveBackupBusy}
              onClick={() => void handleBackupToDrive()}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {driveBackupBusy ? '備份中…' : '備份到 Google Drive'}
            </button>
            <p className="mt-1 px-1 text-xs text-slate-500 dark:text-slate-400">
              {!isOnline ? (
                <span className="text-amber-600 dark:text-amber-400">需要網路</span>
              ) : (
                <>
                  上次 Drive 備份：
                  {lastDriveBackupAt ? formatSyncTimeLabel(lastDriveBackupAt) : '尚未備份'}
                  （存於 Drive「記帳備份」資料夾，保留最近 10 份）
                </>
              )}
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

        <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          瀏覽器永久保存：
          {persistedStatus === true
            ? '已開啟'
            : '未開啟（iPhone 建議加到主畫面）'}
        </p>

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

            {(pendingCsvPlan.newAccounts.length > 0 ||
              pendingCsvPlan.newCategories.length > 0 ||
              pendingCsvPlan.newPlaces.length > 0) && (
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
                {pendingCsvPlan.newPlaces.length > 0 && (
                  <div className="mt-1">地點：{pendingCsvPlan.newPlaces.join('、')}</div>
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
                  上次成功同步：
                  {syncState.lastSyncAt ? formatSyncTimeLabel(syncState.lastSyncAt) : '尚未同步'}
                </div>
                {syncState.status === 'offline' && (
                  <div>未同步筆數：{outboxCount} 筆</div>
                )}
                {syncState.status === 'error' && (
                  <div className="font-medium text-red-600 dark:text-red-400">
                    失敗原因：{syncState.errorMessage ?? '未知錯誤'}
                  </div>
                )}
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
                  className={
                    syncState.status === 'error'
                      ? 'rounded-xl bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50'
                      : 'rounded-xl bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50'
                  }
                >
                  {syncState.status === 'syncing'
                    ? '同步中…'
                    : syncState.status === 'error'
                      ? '重試'
                      : '立即同步'}
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

        {syncState.configured && syncEnabled && (
          <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="sync-schedule-select"
                className="text-xs font-medium text-slate-700 dark:text-slate-200"
              >
                定時同步
              </label>
              <select
                id="sync-schedule-select"
                value={syncSchedule}
                onChange={(e) => void setSyncSchedule(e.target.value as SyncSchedule)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="daily">每天（建議）</option>
                <option value="weekly">每週</option>
                <option value="none">不定時（僅開啟與離開時）</option>
              </select>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              {syncSchedule === 'daily'
                ? '打開與離開 App 時都會同步；另外每天自動同步一次。'
                : syncSchedule === 'weekly'
                  ? '打開與離開 App 時都會同步；另外每週自動同步一次。'
                  : '打開與離開 App 時都會同步；不另行定時同步。'}
            </p>
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                想從 Google 雲端「記帳備份」資料夾還原較早的備份？
              </div>
              <button
                type="button"
                disabled={!isOnline || authBusy}
                onClick={() => setCloudRestoreOpen(true)}
                className="shrink-0 rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                從 Google 雲端備份還原
              </button>
            </div>
          </div>
        )}
      </section>

      <CloudRestoreModal
        mode={cloudRestoreOpen ? { kind: 'manual-backups' } : null}
        onClose={() => setCloudRestoreOpen(false)}
      />

      {/* 關於 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">關於</h2>
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            想再看一次基本操作與加入主畫面說明？
          </div>
          <button
            type="button"
            onClick={onReplayOnboarding}
            className="shrink-0 rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            重看新手導覽
          </button>
        </div>
      </section>
    </div>
  );
}
