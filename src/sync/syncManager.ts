import { useSyncExternalStore } from 'react';
import { isGoogleClientConfigured } from '../config';
import { db, META_KEYS } from '../db/database';
import { getDeviceId } from '../db/deviceId';
import { subscribeLocalMutation } from '../db/repository';
import {
  clearCachedAccessToken,
  getValidAccessTokenSilently,
  isSyncEnabled,
  signInWithGoogle,
  signOutGoogle,
} from './auth';
import { DriveApiError, FetchDriveStore } from './driveStore';
import { syncOnce } from './syncEngine';

const DEBOUNCE_MS = 3000;

export type SyncStatus = 'disabled' | 'syncing' | 'synced' | 'offline' | 'reauth' | 'error';

export interface SyncState {
  status: SyncStatus;
  lastSyncAt: number | null;
  errorMessage: string | null;
  configured: boolean;
}

const listeners = new Set<() => void>();
let initialized = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightSync: Promise<void> | null = null;
let pendingResync = false;

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

async function loadInitialLastSyncAt(): Promise<void> {
  const entry = await db.meta.get(META_KEYS.SYNC_LAST_SYNC_AT);
  if (entry) {
    const num = Number(entry.value);
    if (Number.isFinite(num) && num > 0) {
      setState({ lastSyncAt: num });
    }
  }
}

async function executeSync(): Promise<void> {
  if (!isGoogleClientConfigured() || !isSyncEnabled()) {
    setState({ status: 'disabled', errorMessage: null });
    return;
  }

  if (isOffline()) {
    setState({ status: 'offline', errorMessage: null });
    return;
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
    return;
  }

  try {
    const driveStore = new FetchDriveStore(getValidAccessTokenSilently);
    const result = await syncOnce({
      database: db,
      driveStore,
      deviceId: getDeviceId(),
    });
    setState({
      status: 'synced',
      lastSyncAt: result.lastSyncAt,
      errorMessage: null,
    });
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 401) {
      clearCachedAccessToken();
      setState({ status: 'reauth', errorMessage: null });
    } else if (isOffline()) {
      setState({ status: 'offline', errorMessage: null });
    } else {
      setState({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : '同步失敗',
      });
    }
  }
}

/**
 * 立即觸發一次同步（確保同一時間僅有一個同步任務在執行）。
 */
export function triggerSync(): Promise<void> {
  if (inFlightSync) {
    return inFlightSync;
  }

  inFlightSync = (async () => {
    try {
      await executeSync();
    } finally {
      inFlightSync = null;
      if (pendingResync) {
        pendingResync = false;
        void triggerSync();
      }
    }
  })();

  return inFlightSync;
}

function scheduleDebouncedSync(): void {
  if (!isGoogleClientConfigured() || !isSyncEnabled()) {
    return;
  }
  if (inFlightSync) {
    pendingResync = true;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void triggerSync();
  }, DEBOUNCE_MS);
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
      void triggerSync();
    } else {
      setState({ status: 'disabled' });
    }
  });

  subscribeLocalMutation(() => {
    scheduleDebouncedSync();
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => {
      if (isGoogleClientConfigured() && isSyncEnabled()) {
        void triggerSync();
      }
    });

    window.addEventListener('online', () => {
      if (isGoogleClientConfigured() && isSyncEnabled()) {
        void triggerSync();
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
  await triggerSync();
}

/**
 * 登出 Google 並停用自動同步。
 */
export async function logoutAndClearSync(): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingResync = false;
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
 * 將時間戳記格式化為台灣習慣的簡短時間字串（例如：下午 3:20）。
 */
export function formatSyncTimeLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-TW', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
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
