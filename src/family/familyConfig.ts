export type ActiveLedger = 'personal' | 'family';

export type FamilyMemberRole = 'owner' | 'member';
export type FamilyMemberStatus = 'active' | 'removed';

export interface FamilyConfig {
  fileId: string;
  ledgerName: string;
  memberId: string;
  email: string;
  role: FamilyMemberRole;
  status: FamilyMemberStatus;
  joinedAt: number;
}

const FAMILY_CONFIG_STORAGE_KEY = 'expense_tracker_family_config';
const ACTIVE_LEDGER_STORAGE_KEY = 'expense_tracker_active_ledger';

function getLocalStorage(): Storage | null {
  if (typeof globalThis.localStorage === 'undefined') {
    return null;
  }
  return globalThis.localStorage;
}

function isValidFamilyConfig(raw: unknown): raw is FamilyConfig {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.fileId === 'string' &&
    obj.fileId.length > 0 &&
    typeof obj.ledgerName === 'string' &&
    typeof obj.memberId === 'string' &&
    obj.memberId.length > 0 &&
    typeof obj.email === 'string' &&
    (obj.role === 'owner' || obj.role === 'member') &&
    (obj.status === 'active' || obj.status === 'removed') &&
    typeof obj.joinedAt === 'number' &&
    Number.isFinite(obj.joinedAt)
  );
}

/**
 * 讀取目前裝置保存的家庭帳本設定；未加入或資料損壞時回傳 null。
 */
export function getFamilyConfig(): FamilyConfig | null {
  const storage = getLocalStorage();
  if (!storage) {
    return null;
  }
  const raw = storage.getItem(FAMILY_CONFIG_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidFamilyConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 將家庭帳本設定寫入 localStorage。
 */
export function setFamilyConfig(config: FamilyConfig): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  storage.setItem(FAMILY_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

/**
 * 清除 localStorage 中的家庭帳本設定。
 */
export function clearFamilyConfig(): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  storage.removeItem(FAMILY_CONFIG_STORAGE_KEY);
}

/**
 * 取得目前作用中的帳本模式；沒有家庭帳本設定時一律回傳 'personal'。
 */
export function getActiveLedger(): ActiveLedger {
  const storage = getLocalStorage();
  if (!storage) {
    return 'personal';
  }
  if (!getFamilyConfig()) {
    return 'personal';
  }
  return storage.getItem(ACTIVE_LEDGER_STORAGE_KEY) === 'family' ? 'family' : 'personal';
}

/**
 * 設定作用中的帳本模式（僅寫入 localStorage，呼叫端需自行重新載入頁面）。
 */
export function setActiveLedger(ledger: ActiveLedger): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  storage.setItem(ACTIVE_LEDGER_STORAGE_KEY, ledger);
}

/**
 * 檢查家庭帳本目前是否為唯讀狀態（例如已被建立者移除）。
 */
export function isFamilyReadOnly(): boolean {
  const config = getFamilyConfig();
  return config?.status === 'removed';
}
