import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DRIVE_FILE_TOKEN_STORAGE_KEY = 'expense_tracker_google_drive_file_token';
const MAIN_TOKEN_STORAGE_KEY = 'expense_tracker_google_token';

function installMemoryStorage(name: 'sessionStorage' | 'localStorage'): Storage {
  const map = new Map<string, string>();
  const storage = {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  } satisfies Storage;

  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: storage,
  });
  return storage;
}

describe('auth 權杖快取與靜默取得邏輯', () => {
  let initTokenClientMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    installMemoryStorage('sessionStorage');
    installMemoryStorage('localStorage');
    initTokenClientMock = vi.fn();
    Object.defineProperty(globalThis, 'google', {
      configurable: true,
      value: {
        accounts: {
          oauth2: {
            initTokenClient: initTokenClientMock,
            revoke: vi.fn((_token: string, done?: () => void) => done?.()),
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drive.file 權杖寫入 sessionStorage 後，重新載入模組仍可從快取與 silently 取得', async () => {
    const authFirstLoad = await import('./auth');

    initTokenClientMock.mockImplementationOnce(
      (config: { callback: (resp: { access_token?: string; expires_in?: number }) => void }) => ({
        requestAccessToken: () => {
          config.callback({ access_token: 'drive-file-token-123', expires_in: 3600 });
        },
      }),
    );

    const requested = await authFirstLoad.requestDriveFileAccessToken();
    expect(requested).toBe('drive-file-token-123');
    expect(globalThis.sessionStorage.getItem(DRIVE_FILE_TOKEN_STORAGE_KEY)).toContain(
      'drive-file-token-123',
    );

    // 模擬頁面重新載入（清除模組記憶體變數）
    vi.resetModules();
    initTokenClientMock.mockClear();

    const authReloaded = await import('./auth');
    expect(authReloaded.getCachedDriveFileAccessToken()).toBe('drive-file-token-123');
    await expect(authReloaded.getDriveFileAccessTokenSilently()).resolves.toBe(
      'drive-file-token-123',
    );
    expect(initTokenClientMock).not.toHaveBeenCalled();

    authReloaded.clearCachedDriveFileToken();
    expect(authReloaded.getCachedDriveFileAccessToken()).toBeNull();
    expect(globalThis.sessionStorage.getItem(DRIVE_FILE_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('drive.file 權杖過期時，getDriveFileAccessTokenSilently 直接拋錯且不呼叫 initTokenClient', async () => {
    globalThis.sessionStorage.setItem(
      DRIVE_FILE_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'expired-drive-file-token',
        expiresAt: Date.now() - 1000,
      }),
    );

    const auth = await import('./auth');
    expect(auth.getCachedDriveFileAccessToken()).toBeNull();
    await expect(auth.getDriveFileAccessTokenSilently()).rejects.toThrow();
    expect(initTokenClientMock).not.toHaveBeenCalled();
  });

  it('drive.file 權杖在緩衝時間（60 秒）內視為已過期且不呼叫 initTokenClient', async () => {
    globalThis.sessionStorage.setItem(
      DRIVE_FILE_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'almost-expired-token',
        expiresAt: Date.now() + 30_000,
      }),
    );

    const auth = await import('./auth');
    expect(auth.getCachedDriveFileAccessToken()).toBeNull();
    await expect(auth.getDriveFileAccessTokenSilently()).rejects.toThrow();
    expect(initTokenClientMock).not.toHaveBeenCalled();
  });

  it('主權杖 getValidAccessTokenSilently 只讀快取，沒有或過期時拋錯且不呼叫 initTokenClient', async () => {
    const authEmpty = await import('./auth');
    await expect(authEmpty.getValidAccessTokenSilently()).rejects.toThrow();
    expect(initTokenClientMock).not.toHaveBeenCalled();

    vi.resetModules();
    globalThis.sessionStorage.setItem(
      MAIN_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'valid-main-token',
        expiresAt: Date.now() + 600_000,
      }),
    );
    const authValid = await import('./auth');
    await expect(authValid.getValidAccessTokenSilently()).resolves.toBe('valid-main-token');
    expect(initTokenClientMock).not.toHaveBeenCalled();
  });
});
