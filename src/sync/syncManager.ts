import { useSyncExternalStore } from 'react';
import { isGoogleClientConfigured } from '../config';
import { db, META_KEYS } from '../db/database';
import { getDeviceId } from '../db/deviceId';
import { getSyncSchedule, processRecurringRules } from '../db/repository';
import {
  clearCachedAccessToken,
  getValidAccessTokenSilently,
  isSyncEnabled,
  signInWithGoogle,
  signOutGoogle,
} from './auth';
import { DriveApiError, FetchDriveStore } from './driveStore';
import { syncOnce } from './syncEngine';
import { createSyncScheduler } from './syncScheduler';

export type SyncStatus = 'disabled' | 'syncing' | 'synced' | 'offline' | 'reauth' | 'error';

export interface SyncState {
  status: SyncStatus;
  lastSyncAt: number | null;
  errorMessage: string | null;
  configured: boolean;
}

const listeners = new Set<() => void>();
let initialized = false;

let state: SyncState = {
  status: isSyncEnabled() && isGoogleClientConfigured() ? 'synced' : 'disabled',
  lastSyncAt: null,
  errorMessage: null,
  configured: isGoogleClientConfigured(),
};

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(patch: Partial<SyncState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SyncState {
  return state;
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * 將同步錯誤轉換為使用者易懂的繁體中文說明。
 */
export function toFriendlySyncError(err: unknown): string {
  if (err instanceof DriveApiError) {
    if (err.status === 403) {
      return 'Google Drive 拒絕存取';
    }
    if (err.status === 429 || (err.status >= 500 && err.status < 600)) {
      return 'Google 伺服器暫時忙碌，請稍後重試';
    }
    console.error('[sync] Drive API 同步錯誤：', err);
    return '未知錯誤';
  }

  if (
    err instanceof TypeError ||
    (err instanceof Error && /network|failed to fetch|load failed/i.test(err.message))
  ) {
    return '網路連線失敗';
  }

  console.error('[sync] 同步發生未知錯誤：', err);
  return '未知錯誤';
}

async function loadInitialLastSyncAt(): Promise<void> {
  const entry = await db.meta.get(META_KEYS.SYNC_LAST_SYNC_AT);
  if (entry) {
    const num = Number(entry.value);
    if (Number.isFinite(num) && num > 0) {
      setState({ lastSyncAt: num });
    }
  }
}

async function executeSync(): Promise<boolean> {
  if (!isGoogleClientConfigured() || !isSyncEnabled()) {
    setState({ status: 'disabled', errorMessage: null });
    return true;
  }

  if (isOffline()) {
    setState({ status: 'offline', errorMessage: null });
    return false;
  }

  setState({ status: 'syncing', errorMessage: null });

  try {
    await getValidAccessTokenSilently();
  } catch {
    if (isOffline()) {
      setState({ status: 'offline', errorMessage: null });
    } else {
      setState({ status: 'reauth', errorMessage: null });
    }
    return false;
  }

  try {
    const driveStore = new FetchDriveStore(getValidAccessTokenSilently);
    const result = await syncOnce({
      database: db,
      driveStore,
      deviceId: getDeviceId(),
    });
    await processRecurringRules();
    setState({
      status: 'synced',
      lastSyncAt: result.lastSyncAt,
      errorMessage: null,
    });
    return true;
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 401) {
      clearCachedAccessToken();
      setState({ status: 'reauth', errorMessage: null });
    } else if (isOffline()) {
      setState({ status: 'offline', errorMessage: null });
    } else {
      setState({
        status: 'error',
        errorMessage: toFriendlySyncError(err),
      });
    }
    return false;
  }
}

const scheduler = createSyncScheduler({
  getSchedule: () => getSyncSchedule(db),
  getOutboxCount: () => db.outbox.count(),
  getLastSyncAt: () => state.lastSyncAt,
  runSync: executeSync,
  isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
});

/**
 * 立即觸發一次同步（確保同一時間僅有一個同步任務在執行）。
 */
export async function triggerSync(): Promise<void> {
  await scheduler.triggerManual();
}

/**
 * 初始化同步排程監聽器（應用程式啟動時呼叫一次）。
 */
export function startSyncManager(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  void loadInitialLastSyncAt().then(() => {
    if (isGoogleClientConfigured() && isSyncEnabled()) {
      void scheduler.start();
    } else {
      setState({ status: 'disabled' });
    }
  });

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (isGoogleClientConfigured() && isSyncEnabled()) {
        void scheduler.onVisibilityChange(document.visibilityState !== 'hidden');
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (isGoogleClientConfigured() && isSyncEnabled()) {
        void scheduler.onPageHide();
      }
    });

    window.addEventListener('online', () => {
      if (isGoogleClientConfigured() && isSyncEnabled()) {
        void scheduler.onOnline();
      }
    });

    window.addEventListener('offline', () => {
      if (isGoogleClientConfigured() && isSyncEnabled()) {
        setState({ status: 'offline', errorMessage: null });
      }
    });
  }
}

/**
 * 執行 Google 登入並立即進行首次同步。
 */
export async function loginAndSync(): Promise<void> {
  await signInWithGoogle();
  await scheduler.start();
}

/**
 * 登出 Google 並停用自動同步。
 */
export async function logoutAndClearSync(): Promise<void> {
  scheduler.stop();
  await signOutGoogle();
  setState({ status: 'disabled', errorMessage: null });
}

/**
 * 訂閱目前同步狀態的 React Hook。
 */
export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 將時間戳記格式化為台灣習慣的簡短時間字串（例如：今天 下午 3:20）。
 */
export function formatSyncTimeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const datePrefix = isSameDay ? '今天 ' : `${date.getMonth() + 1}/${date.getDate()} `;
  const timeText = new Intl.DateTimeFormat('zh-TW', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);

  return `${datePrefix}${timeText}`;
}

/**
 * 取得顯示於首頁與設定頁的同步狀態文字。
 */
export function formatSyncStatusText(syncState: SyncState): string {
  switch (syncState.status) {
    case 'disabled':
      return '尚未啟用同步';
    case 'syncing':
      return '同步中…';
    case 'offline':
      return '離線，恢復網路後自動同步';
    case 'reauth':
      return '需要重新登入';
    case 'synced':
      return syncState.lastSyncAt
        ? `已同步 · ${formatSyncTimeLabel(syncState.lastSyncAt)}`
        : '已同步';
    case 'error':
      return syncState.errorMessage ? `同步失敗：${syncState.errorMessage}` : '同步失敗';
  }
}
