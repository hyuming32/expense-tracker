import { useSyncExternalStore } from 'react';
import {
  db,
  ensureSeeded,
  ExpenseDatabase,
  FAMILY_DB_NAME,
  META_KEYS,
} from '../db/database';
import { getDeviceId } from '../db/deviceId';
import { isValidHexColor, subscribeLocalMutation } from '../db/repository';
import type { Member } from '../db/types';
import {
  clearCachedDriveFileToken,
  getDriveFileAccessTokenSilently,
  requestDriveFileAccessToken,
} from '../sync/auth';
import { DriveApiError } from '../sync/driveStore';
import { toFriendlySyncError } from '../sync/syncManager';
import {
  buildFamilyInviteUrl,
  clearFamilyConfig,
  type FamilyConfig,
  getActiveLedger,
  getFamilyConfig,
  setActiveLedger,
  setFamilyConfig,
} from './familyConfig';
import {
  collectAllRecords,
  FAMILY_LEDGER_FORMAT,
  FAMILY_LEDGER_VERSION,
  type FamilyLedgerFile,
  parseFamilyLedgerFile,
} from './familyFile';
import { type FamilyDriveStore, FetchFamilyDriveStore } from './familyStore';
import { FamilyAccessLostError, syncFamilyOnce } from './familySync';
import { pickFamilyLedgerFile } from './picker';

export type FamilySyncStatus =
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'needAuth'
  | 'error'
  | 'removed';

export interface FamilySyncState {
  status: FamilySyncStatus;
  lastSyncAt: number | null;
  errorMessage: string | null;
}

const POLL_INTERVAL_MS = 60_000;
const MUTATION_DEBOUNCE_MS = 5_000;

const listeners = new Set<() => void>();
let initialized = false;
let inFlight: Promise<boolean> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeMutation: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;
let onlineHandler: (() => void) | null = null;
let offlineHandler: (() => void) | null = null;

let state: FamilySyncState = {
  status: getFamilyConfig()?.status === 'removed' ? 'removed' : 'idle',
  lastSyncAt: null,
  errorMessage: null,
};

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(patch: Partial<FamilySyncState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): FamilySyncState {
  return state;
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function clearTimers(): void {
  if (pollTimer !== null) {
    globalThis.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (debounceTimer !== null) {
    globalThis.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function startPolling(): void {
  if (pollTimer !== null || !isDocumentVisible()) {
    return;
  }
  pollTimer = globalThis.setInterval(() => {
    if (isDocumentVisible()) {
      void triggerFamilySync({ interactive: false });
    }
  }, POLL_INTERVAL_MS);
}

function openFamilyDatabase(): { database: ExpenseDatabase; shouldClose: boolean } {
  if (db.name === FAMILY_DB_NAME) {
    return { database: db, shouldClose: false };
  }
  return { database: new ExpenseDatabase(FAMILY_DB_NAME), shouldClose: true };
}

function createInteractiveStore(): FamilyDriveStore {
  let cachedToken: string | null = null;
  return new FetchFamilyDriveStore(async () => {
    if (!cachedToken) {
      cachedToken = await requestDriveFileAccessToken();
    }
    return cachedToken;
  });
}

async function loadInitialFamilyLastSyncAt(): Promise<void> {
  if (db.name !== FAMILY_DB_NAME) {
    return;
  }
  const entry = await db.meta.get(META_KEYS.FAMILY_LAST_SYNC_AT);
  if (entry) {
    const num = Number(entry.value);
    if (Number.isFinite(num) && num > 0) {
      setState({ lastSyncAt: num });
    }
  }
}

async function executeFamilySync(interactive: boolean): Promise<boolean> {
  const config = getFamilyConfig();
  if (getActiveLedger() !== 'family' || !config) {
    return false;
  }

  if (config.status === 'removed') {
    setState({ status: 'removed', errorMessage: null });
    stopFamilySync();
    return false;
  }

  if (isOffline()) {
    setState({ status: 'offline', errorMessage: null });
    return false;
  }

  setState({ status: 'syncing', errorMessage: null });

  let token: string;
  try {
    token = interactive
      ? await requestDriveFileAccessToken()
      : await getDriveFileAccessTokenSilently();
  } catch (err) {
    if (isOffline()) {
      setState({ status: 'offline', errorMessage: null });
    } else {
      setState({
        status: 'needAuth',
        errorMessage: err instanceof Error ? err.message : null,
      });
    }
    return false;
  }

  try {
    const store = new FetchFamilyDriveStore(async () => token);
    await syncFamilyOnce({
      database: db,
      store,
      fileId: config.fileId,
    });
    const entry = await db.meta.get(META_KEYS.FAMILY_LAST_SYNC_AT);
    const parsedTime = entry ? Number(entry.value) : Date.now();
    setState({
      status: 'synced',
      lastSyncAt: Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : Date.now(),
      errorMessage: null,
    });
    return true;
  } catch (err) {
    if (err instanceof FamilyAccessLostError) {
      setFamilyConfig({ ...config, status: 'removed' });
      setState({ status: 'removed', errorMessage: err.message });
      stopFamilySync();
      return false;
    }
    if (err instanceof DriveApiError && err.status === 401) {
      clearCachedDriveFileToken();
      setState({ status: 'needAuth', errorMessage: null });
      return false;
    }
    if (isOffline()) {
      setState({ status: 'offline', errorMessage: null });
      return false;
    }
    setState({
      status: 'error',
      errorMessage: toFriendlySyncError(err),
    });
    return false;
  }
}

/**
 * 取得目前家庭帳本同步狀態快照。
 */
export function getFamilySyncState(): FamilySyncState {
  return getSnapshot();
}

/**
 * 訂閱家庭帳本同步狀態的 React Hook。
 */
export function useFamilySyncState(): FamilySyncState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 立即觸發一次家庭帳本同步（確保同一時間僅有一個同步任務在執行）。
 */
export function triggerFamilySync(options?: { interactive?: boolean }): Promise<boolean> {
  if (debounceTimer !== null) {
    globalThis.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (inFlight !== null) {
    return inFlight;
  }
  const interactive = options?.interactive ?? false;
  inFlight = executeFamilySync(interactive).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * 停止家庭帳本背景同步排程與監聽器。
 */
export function stopFamilySync(): void {
  initialized = false;
  clearTimers();
  if (unsubscribeMutation) {
    unsubscribeMutation();
    unsubscribeMutation = null;
  }
  if (typeof document !== 'undefined' && visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  if (typeof window !== 'undefined') {
    if (onlineHandler) {
      window.removeEventListener('online', onlineHandler);
      onlineHandler = null;
    }
    if (offlineHandler) {
      window.removeEventListener('offline', offlineHandler);
      offlineHandler = null;
    }
  }
}

function scheduleDebouncedSync(): void {
  if (!initialized) {
    return;
  }
  if (debounceTimer !== null) {
    globalThis.clearTimeout(debounceTimer);
  }
  debounceTimer = globalThis.setTimeout(() => {
    debounceTimer = null;
    void triggerFamilySync({ interactive: false });
  }, MUTATION_DEBOUNCE_MS);
}

/**
 * 啟動家庭帳本同步排程（僅於家庭模式且狀態為 active 時啟動）。
 */
export function startFamilySync(): void {
  const config = getFamilyConfig();
  if (getActiveLedger() !== 'family' || !config) {
    return;
  }
  if (config.status === 'removed') {
    setState({ status: 'removed', errorMessage: null });
    return;
  }
  if (initialized) {
    return;
  }
  initialized = true;

  void loadInitialFamilyLastSyncAt().then(() => {
    if (!initialized) {
      return;
    }
    void triggerFamilySync({ interactive: false });
    startPolling();
  });

  unsubscribeMutation = subscribeLocalMutation(() => {
    scheduleDebouncedSync();
  });

  if (typeof document !== 'undefined') {
    visibilityHandler = () => {
      if (!initialized) {
        return;
      }
      if (document.visibilityState === 'visible') {
        startPolling();
        void triggerFamilySync({ interactive: false });
      } else if (document.visibilityState === 'hidden') {
        if (pollTimer !== null) {
          globalThis.clearInterval(pollTimer);
          pollTimer = null;
        }
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }

  if (typeof window !== 'undefined') {
    onlineHandler = () => {
      if (initialized) {
        void triggerFamilySync({ interactive: false });
      }
    };
    offlineHandler = () => {
      if (initialized) {
        setState({ status: 'offline', errorMessage: null });
      }
    };
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
  }
}

export interface CreateFamilyLedgerInput {
  ledgerName: string;
  myName: string;
  color: string;
}

export interface FamilyManagerDeps {
  store?: FamilyDriveStore;
  database?: ExpenseDatabase;
  pickFile?: (
    accessToken: string,
    options?: { fileId?: string },
  ) => Promise<{ id: string; name: string }>;
}

/**
 * 建立新的家庭帳本共用檔案於 Google Drive 並寫入本機家庭設定（不負責重新載入頁面）。
 */
export async function createFamilyLedger(
  input: CreateFamilyLedgerInput,
  deps?: FamilyManagerDeps,
): Promise<FamilyConfig> {
  const ledgerName = input.ledgerName.trim();
  const myName = input.myName.trim();
  const color = input.color.trim();

  if (!ledgerName) {
    throw new Error('請輸入家庭帳本名稱');
  }
  if (!myName) {
    throw new Error('請輸入您的顯示名稱');
  }
  if (!isValidHexColor(color)) {
    throw new Error('代表色格式不正確，請使用 #RRGGBB 格式');
  }

  const store = deps?.store ?? createInteractiveStore();
  const about = await store.about();
  const now = Date.now();
  const deviceId = getDeviceId();

  const opened = deps?.database
    ? { database: deps.database, shouldClose: false }
    : openFamilyDatabase();

  try {
    await ensureSeeded(opened.database);

    const ownerMember: Member = {
      id: about.permissionId,
      name: myName,
      color,
      email: about.emailAddress,
      role: 'owner',
      removed: false,
      updatedAt: now,
      deviceId,
      deleted: false,
    };

    await opened.database.members.put(ownerMember);

    const records = await collectAllRecords(opened.database);
    const filePayload: FamilyLedgerFile = {
      format: FAMILY_LEDGER_FORMAT,
      version: FAMILY_LEDGER_VERSION,
      ledgerName,
      updatedAt: now,
      records,
    };

    const created = await store.create(
      `${ledgerName}.fun2young.json`,
      JSON.stringify(filePayload),
    );

    const config: FamilyConfig = {
      fileId: created.id,
      ledgerName,
      memberId: about.permissionId,
      email: about.emailAddress,
      role: 'owner',
      status: 'active',
      joinedAt: now,
    };
    setFamilyConfig(config);
    return config;
  } finally {
    if (opened.shouldClose) {
      opened.database.close();
    }
  }
}

export interface JoinFamilyLedgerInput {
  myName: string;
  color: string;
  fileId?: string;
}

/**
 * 加入他人建立的家庭帳本：
 * 若有指定 fileId 會先嘗試直接下載；無權限（403/404）或未指定且找不到唯一受邀檔案時，再透過 Picker 選取。
 */
export async function joinFamilyLedger(
  input: JoinFamilyLedgerInput,
  deps?: FamilyManagerDeps,
): Promise<FamilyConfig> {
  const myName = input.myName.trim();
  const color = input.color.trim();
  const requestedFileId = input.fileId?.trim() || undefined;

  if (!myName) {
    throw new Error('請輸入您的顯示名稱');
  }
  if (!isValidHexColor(color)) {
    throw new Error('代表色格式不正確，請使用 #RRGGBB 格式');
  }

  let token: string | null = null;
  let store: FamilyDriveStore;
  if (deps?.store) {
    store = deps.store;
  } else {
    token = await requestDriveFileAccessToken();
    const fixedToken = token;
    store = new FetchFamilyDriveStore(async () => fixedToken);
  }

  const pickWithFileId = async (targetFileId?: string): Promise<{ id: string; name: string }> => {
    if (deps?.pickFile) {
      return deps.pickFile(token ?? '', targetFileId ? { fileId: targetFileId } : undefined);
    }
    if (!token) {
      token = await requestDriveFileAccessToken();
    }
    return pickFamilyLedgerFile(token, targetFileId ? { fileId: targetFileId } : undefined);
  };

  const about = await store.about();

  let fileId: string;
  let rawContent: string;

  if (requestedFileId) {
    try {
      rawContent = await store.download(requestedFileId);
      fileId = requestedFileId;
    } catch (err) {
      if (err instanceof DriveApiError && (err.status === 403 || err.status === 404)) {
        const picked = await pickWithFileId(requestedFileId);
        fileId = picked.id;
        rawContent = await store.download(fileId);
      } else {
        throw err;
      }
    }
  } else {
    const appFiles = await store.findAppFiles();
    const sharedFiles = appFiles.filter((f) => !f.ownedByMe);
    if (sharedFiles.length === 1) {
      fileId = sharedFiles[0]!.id;
    } else {
      const picked = await pickWithFileId();
      fileId = picked.id;
    }
    rawContent = await store.download(fileId);
  }

  const parsed = parseFamilyLedgerFile(rawContent);

  const now = Date.now();
  const deviceId = getDeviceId();
  const existingRemoteMember = parsed.records.members.find((m) => m.id === about.permissionId);
  const role: Member['role'] =
    existingRemoteMember?.role === 'owner' && !existingRemoteMember.removed ? 'owner' : 'member';

  const opened = deps?.database
    ? { database: deps.database, shouldClose: false }
    : openFamilyDatabase();

  try {
    await ensureSeeded(opened.database);

    const myMember: Member = {
      id: about.permissionId,
      name: myName,
      color,
      email: about.emailAddress,
      role,
      removed: false,
      updatedAt: now,
      deviceId,
      deleted: false,
    };
    await opened.database.members.put(myMember);

    await syncFamilyOnce({
      database: opened.database,
      store,
      fileId,
    });

    const config: FamilyConfig = {
      fileId,
      ledgerName: parsed.ledgerName,
      memberId: about.permissionId,
      email: about.emailAddress,
      role,
      status: 'active',
      joinedAt: now,
    };
    setFamilyConfig(config);
    return config;
  } finally {
    if (opened.shouldClose) {
      opened.database.close();
    }
  }
}

function requireActiveOwnerConfig(): FamilyConfig {
  const config = getFamilyConfig();
  if (!config || config.status !== 'active' || config.role !== 'owner') {
    throw new Error('只有家庭帳本建立者可以執行此操作');
  }
  return config;
}

/**
 * 邀請成員加入家庭帳本（僅建立者可操作，授權該 Email 可讀寫共用檔案，並於通知信附上邀請連結）。
 */
export async function inviteMember(
  email: string,
  deps?: FamilyManagerDeps & { joinUrl?: string },
): Promise<void> {
  const config = requireActiveOwnerConfig();
  const trimmedEmail = email.trim();
  if (!trimmedEmail || !trimmedEmail.includes('@')) {
    throw new Error('請輸入有效的 Email 地址');
  }

  const joinUrl =
    deps?.joinUrl ??
    (typeof window !== 'undefined' && window.location?.origin
      ? buildFamilyInviteUrl(config.fileId)
      : undefined);

  const store = deps?.store ?? createInteractiveStore();
  await store.share(config.fileId, trimmedEmail, joinUrl);
}

/**
 * 移除家庭帳本成員（僅建立者可操作：取消雲端共用權限、標記 removed=true 並同步）。
 */
export async function removeMember(memberId: string, deps?: FamilyManagerDeps): Promise<void> {
  const config = requireActiveOwnerConfig();
  const trimmedId = memberId.trim();
  if (!trimmedId) {
    throw new Error('請指定要移除的成員');
  }
  if (trimmedId === config.memberId) {
    throw new Error('無法移除自己');
  }

  const store = deps?.store ?? createInteractiveStore();
  try {
    await store.unshare(config.fileId, trimmedId);
  } catch (err) {
    // 若雲端權限已不存在仍繼續將成員標記為已移除並同步
    if (!(err instanceof DriveApiError && err.status === 404)) {
      throw err;
    }
  }

  const opened = deps?.database
    ? { database: deps.database, shouldClose: false }
    : openFamilyDatabase();

  try {
    // 先同步以取得最新的成員紀錄（避免建立者尚未拉取該成員就執行移除）
    await syncFamilyOnce({
      database: opened.database,
      store,
      fileId: config.fileId,
    });

    const existing = await opened.database.members.get(trimmedId);
    if (existing) {
      const nextUpdatedAt = Math.max(Date.now(), existing.updatedAt + 1);
      await opened.database.members.put({
        ...existing,
        removed: true,
        updatedAt: nextUpdatedAt,
        deviceId: getDeviceId(),
      });
      await syncFamilyOnce({
        database: opened.database,
        store,
        fileId: config.fileId,
      });
    }
  } finally {
    if (opened.shouldClose) {
      opened.database.close();
    }
  }
}

/**
 * 更新目前使用者的家庭成員名稱與代表色。
 */
export async function updateMyProfile(
  input: { name: string; color: string },
  deps?: FamilyManagerDeps,
): Promise<Member> {
  const config = getFamilyConfig();
  if (!config || config.status !== 'active') {
    throw new Error('目前未啟用家庭帳本或權限已移除');
  }

  const name = input.name.trim();
  const color = input.color.trim();
  if (!name) {
    throw new Error('請輸入顯示名稱');
  }
  if (!isValidHexColor(color)) {
    throw new Error('代表色格式不正確，請使用 #RRGGBB 格式');
  }

  const opened = deps?.database
    ? { database: deps.database, shouldClose: false }
    : openFamilyDatabase();

  try {
    const now = Date.now();
    const deviceId = getDeviceId();
    const existing = await opened.database.members.get(config.memberId);

    const updated: Member = {
      id: config.memberId,
      name,
      color,
      email: existing?.email ?? config.email,
      role: existing?.role ?? config.role,
      removed: existing?.removed ?? false,
      updatedAt: now,
      deviceId,
      deleted: false,
    };

    await opened.database.transaction('rw', opened.database.members, opened.database.outbox, async () => {
      await opened.database.members.put(updated);
      await opened.database.outbox.put({
        key: `members:${updated.id}`,
        table: 'members',
        recordId: updated.id,
        updatedAt: now,
      });
    });

    if (opened.database === db) {
      scheduleDebouncedSync();
    }

    return updated;
  } finally {
    if (opened.shouldClose) {
      opened.database.close();
    }
  }
}

/**
 * 退出或捨棄家庭帳本：停止同步、切回個人帳本、清除家庭設定並刪除本機家庭資料庫（呼叫端需自行重新載入頁面）。
 */
export async function discardFamilyLedger(deps?: { database?: ExpenseDatabase }): Promise<void> {
  stopFamilySync();
  setActiveLedger('personal');
  clearFamilyConfig();

  if (deps?.database) {
    await deps.database.delete();
    return;
  }

  if (db.name === FAMILY_DB_NAME) {
    await db.delete();
  } else {
    const familyDb = new ExpenseDatabase(FAMILY_DB_NAME);
    await familyDb.delete();
  }
}

/**
 * 讀取家庭帳本中所有未軟刪除的成員清單。
 */
export async function getMembers(database: ExpenseDatabase = db): Promise<Member[]> {
  const rows = await database.members.toArray();
  return rows.filter((m) => !m.deleted);
}
