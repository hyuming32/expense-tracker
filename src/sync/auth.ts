import {
  GOOGLE_CLIENT_ID,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_SCOPE,
  isGoogleClientConfigured,
} from '../config';

const SYNC_ENABLED_STORAGE_KEY = 'expense_tracker_google_sync_enabled';
const TOKEN_STORAGE_KEY = 'expense_tracker_google_token';
const DRIVE_FILE_GRANTED_STORAGE_KEY = 'expense_tracker_google_drive_file_granted';
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const SILENT_TOKEN_TIMEOUT_MS = 10_000;

/**
 * 使用者取消或拒絕 Google Drive 檔案授權時拋出的錯誤。
 */
export class DriveAuthCancelledError extends Error {
  constructor(message = '未授權，無法備份到 Drive') {
    super(message);
    this.name = 'DriveAuthCancelledError';
  }
}

interface TokenRecord {
  accessToken: string;
  expiresAt: number;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

interface GoogleOAuth2 {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    include_granted_scopes?: boolean;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }) => GoogleTokenClient;
  revoke: (token: string, done?: () => void) => void;
}

interface GoogleGlobal {
  accounts?: {
    oauth2?: GoogleOAuth2;
  };
}

let memoryToken: TokenRecord | null = null;
let memoryDriveFileToken: TokenRecord | null = null;

function getGoogleOAuth2(): GoogleOAuth2 | null {
  const g = (globalThis as { google?: GoogleGlobal }).google;
  return g?.accounts?.oauth2 ?? null;
}

function saveTokenRecord(record: TokenRecord): void {
  memoryToken = record;
  if (typeof globalThis.sessionStorage !== 'undefined') {
    globalThis.sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(record));
  }
}

function loadTokenRecord(): TokenRecord | null {
  if (memoryToken) {
    return memoryToken;
  }
  if (typeof globalThis.sessionStorage === 'undefined') {
    return null;
  }
  const raw = globalThis.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'accessToken' in parsed &&
      'expiresAt' in parsed &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.expiresAt === 'number'
    ) {
      memoryToken = { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
      return memoryToken;
    }
  } catch {
    // 忽略損壞的快取
  }
  return null;
}

/**
 * 清除記憶體與 sessionStorage 中的存取權杖。
 */
export function clearCachedAccessToken(): void {
  memoryToken = null;
  if (typeof globalThis.sessionStorage !== 'undefined') {
    globalThis.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

/**
 * 取得目前尚未過期的存取權杖；若不存在或即將過期則回傳 null。
 */
export function getCachedAccessToken(): string | null {
  const record = loadTokenRecord();
  if (!record) {
    return null;
  }
  if (Date.now() >= record.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    clearCachedAccessToken();
    return null;
  }
  return record.accessToken;
}

/**
 * 檢查使用者是否已啟用 Google 同步。
 */
export function isSyncEnabled(): boolean {
  if (typeof globalThis.localStorage === 'undefined') {
    return false;
  }
  return globalThis.localStorage.getItem(SYNC_ENABLED_STORAGE_KEY) === 'true';
}

/**
 * 設定 Google 同步啟用旗標於 localStorage。
 */
export function setSyncEnabled(enabled: boolean): void {
  if (typeof globalThis.localStorage === 'undefined') {
    return;
  }
  if (enabled) {
    globalThis.localStorage.setItem(SYNC_ENABLED_STORAGE_KEY, 'true');
  } else {
    globalThis.localStorage.removeItem(SYNC_ENABLED_STORAGE_KEY);
  }
}

function requestAccessToken(prompt: 'consent' | ''): Promise<string> {
  if (!isGoogleClientConfigured()) {
    return Promise.reject(new Error('尚未設定 Google Client ID'));
  }

  const oauth2 = getGoogleOAuth2();
  if (!oauth2) {
    return Promise.reject(new Error('Google 登入元件尚未載入'));
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeoutId =
      prompt === ''
        ? globalThis.setTimeout(() => {
            if (!settled) {
              settled = true;
              reject(new Error('靜默更新授權逾時'));
            }
          }, SILENT_TOKEN_TIMEOUT_MS)
        : null;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      fn();
    };

    const client = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          finish(() =>
            reject(new Error(response.error_description || response.error || '無法取得 Google 授權')),
          );
          return;
        }
        const expiresInSec = typeof response.expires_in === 'number' ? response.expires_in : 3600;
        const record: TokenRecord = {
          accessToken: response.access_token,
          expiresAt: Date.now() + expiresInSec * 1000,
        };
        saveTokenRecord(record);
        finish(() => resolve(record.accessToken));
      },
      error_callback: (err) => {
        finish(() => reject(new Error(err.message || err.type || 'Google 授權視窗已取消或失敗')));
      },
    });

    client.requestAccessToken({ prompt });
  });
}

/**
 * 互動式登入 Google（顯示授權同意畫面），成功後啟用同步。
 */
export async function signInWithGoogle(): Promise<string> {
  const token = await requestAccessToken('consent');
  setSyncEnabled(true);
  return token;
}

/**
 * 靜默取得有效的存取權杖；若記憶體／sessionStorage 過期則嘗試以 prompt: '' 更新。
 */
export async function getValidAccessTokenSilently(): Promise<string> {
  const cached = getCachedAccessToken();
  if (cached) {
    return cached;
  }
  return requestAccessToken('');
}

/**
 * 登出 Google：撤銷目前權杖並清除所有同步與授權狀態。
 */
export async function signOutGoogle(): Promise<void> {
  const token = loadTokenRecord()?.accessToken ?? null;
  const oauth2 = getGoogleOAuth2();
  clearCachedAccessToken();
  setSyncEnabled(false);

  if (token && oauth2) {
    await new Promise<void>((resolve) => {
      oauth2.revoke(token, () => resolve());
    });
  }
}

function isDriveFileGranted(): boolean {
  if (typeof globalThis.localStorage === 'undefined') {
    return false;
  }
  return globalThis.localStorage.getItem(DRIVE_FILE_GRANTED_STORAGE_KEY) === 'true';
}

function setDriveFileGranted(granted: boolean): void {
  if (typeof globalThis.localStorage === 'undefined') {
    return;
  }
  if (granted) {
    globalThis.localStorage.setItem(DRIVE_FILE_GRANTED_STORAGE_KEY, 'true');
  } else {
    globalThis.localStorage.removeItem(DRIVE_FILE_GRANTED_STORAGE_KEY);
  }
}

function requestDriveFileTokenWithPrompt(
  oauth2: GoogleOAuth2,
  prompt: 'consent' | '',
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeoutId =
      prompt === ''
        ? globalThis.setTimeout(() => {
            if (!settled) {
              settled = true;
              reject(new Error('靜默更新授權逾時'));
            }
          }, SILENT_TOKEN_TIMEOUT_MS)
        : null;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      fn();
    };

    const client = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_DRIVE_FILE_SCOPE,
      include_granted_scopes: true,
      callback: (response) => {
        if (response.error === 'access_denied') {
          finish(() => reject(new DriveAuthCancelledError('未授權，無法備份到 Drive')));
          return;
        }
        if (response.error || !response.access_token) {
          finish(() =>
            reject(new Error(response.error_description || response.error || '無法取得 Google 授權')),
          );
          return;
        }
        const expiresInSec = typeof response.expires_in === 'number' ? response.expires_in : 3600;
        memoryDriveFileToken = {
          accessToken: response.access_token,
          expiresAt: Date.now() + expiresInSec * 1000,
        };
        setDriveFileGranted(true);
        finish(() => resolve(memoryDriveFileToken!.accessToken));
      },
      error_callback: (err) => {
        if (err.type === 'popup_closed') {
          finish(() => reject(new DriveAuthCancelledError('未授權，無法備份到 Drive')));
          return;
        }
        finish(() => reject(new Error(err.message || err.type || 'Google 授權視窗已取消或失敗')));
      },
    });

    client.requestAccessToken({ prompt });
  });
}

/**
 * 漸進式授權取得 Google Drive 可見檔案（drive.file）存取權杖。
 * 僅於使用者點擊「備份到 Google Drive」時呼叫；首次顯示同意畫面，之後優先靜默取得。
 */
export async function requestDriveFileAccessToken(): Promise<string> {
  if (!isGoogleClientConfigured()) {
    throw new Error('尚未設定 Google Client ID');
  }

  const oauth2 = getGoogleOAuth2();
  if (!oauth2) {
    throw new Error('Google 登入元件尚未載入');
  }

  if (
    memoryDriveFileToken &&
    Date.now() < memoryDriveFileToken.expiresAt - TOKEN_EXPIRY_BUFFER_MS
  ) {
    return memoryDriveFileToken.accessToken;
  }

  if (!isDriveFileGranted()) {
    return requestDriveFileTokenWithPrompt(oauth2, 'consent');
  }

  try {
    return await requestDriveFileTokenWithPrompt(oauth2, '');
  } catch (err) {
    if (err instanceof DriveAuthCancelledError) {
      throw err;
    }
    return requestDriveFileTokenWithPrompt(oauth2, 'consent');
  }
}
