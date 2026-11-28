import {
  GOOGLE_CLOUD_PROJECT_NUMBER,
  GOOGLE_PICKER_API_KEY,
  isPickerConfigured,
} from '../config';
import { DriveAuthCancelledError } from '../sync/auth';

const GAPI_SCRIPT_URL = 'https://apis.google.com/js/api.js';

interface PickerDoc {
  id?: string;
  name?: string;
}

interface PickerCallbackData {
  action: string;
  docs?: PickerDoc[];
}

interface PickerInstance {
  setVisible: (visible: boolean) => void;
}

interface DocsViewInstance {
  setIncludeFolders: (include: boolean) => DocsViewInstance;
  setMimeTypes: (mimeTypes: string) => DocsViewInstance;
  setOwnedByMe: (ownedByMe: boolean) => DocsViewInstance;
  setFileIds: (fileIds: string) => DocsViewInstance;
  setQuery: (query: string) => DocsViewInstance;
}

interface PickerBuilderInstance {
  addView: (view: DocsViewInstance) => PickerBuilderInstance;
  setTitle: (title: string) => PickerBuilderInstance;
  setSize: (width: number, height: number) => PickerBuilderInstance;
  setOAuthToken: (token: string) => PickerBuilderInstance;
  setDeveloperKey: (key: string) => PickerBuilderInstance;
  setAppId: (appId: string) => PickerBuilderInstance;
  setCallback: (cb: (data: PickerCallbackData) => void) => PickerBuilderInstance;
  build: () => PickerInstance;
}

interface GapiGlobal {
  load: (
    api: string,
    options: {
      callback: () => void;
      onerror?: (err: unknown) => void;
    },
  ) => void;
}

interface GooglePickerGlobal {
  picker?: {
    Action: {
      PICKED: string;
      CANCEL: string;
    };
    DocsView: new () => DocsViewInstance;
    PickerBuilder: new () => PickerBuilderInstance;
  };
}

let gapiLoadPromise: Promise<void> | null = null;

function loadGapiScript(): Promise<void> {
  if (typeof globalThis.document === 'undefined') {
    return Promise.reject(new Error('目前環境不支援 Google Picker'));
  }
  const existingGapi = (globalThis as { gapi?: GapiGlobal }).gapi;
  if (existingGapi) {
    return Promise.resolve();
  }
  if (gapiLoadPromise) {
    return gapiLoadPromise;
  }

  gapiLoadPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${GAPI_SCRIPT_URL}"]`,
    );
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener(
        'error',
        () => {
          gapiLoadPromise = null;
          reject(new Error('載入 Google Picker 元件失敗'));
        },
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.src = GAPI_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gapiLoadPromise = null;
      reject(new Error('載入 Google Picker 元件失敗'));
    };
    document.head.appendChild(script);
  });

  return gapiLoadPromise;
}

async function ensureGooglePickerLoaded(): Promise<NonNullable<GooglePickerGlobal['picker']>> {
  await loadGapiScript();

  const gapi = (globalThis as { gapi?: GapiGlobal }).gapi;
  if (!gapi) {
    throw new Error('Google Picker 元件尚未就緒');
  }

  const existingPicker = (globalThis as { google?: GooglePickerGlobal }).google?.picker;
  if (!existingPicker) {
    await new Promise<void>((resolve, reject) => {
      gapi.load('picker', {
        callback: () => resolve(),
        onerror: () => reject(new Error('載入 Google Picker 模組失敗')),
      });
    });
  }

  const pickerApi = (globalThis as { google?: GooglePickerGlobal }).google?.picker;
  if (!pickerApi) {
    throw new Error('無法初始化 Google Picker');
  }
  return pickerApi;
}

export interface PickFamilyLedgerFileOptions {
  fileId?: string;
}

/**
 * 動態載入 Google Picker 並讓使用者從 Google Drive 選擇共用家庭帳本 JSON 檔案。
 * 有指定 fileId 時只顯示該單一檔案；未指定時則篩選檔名含 fun2young 的共用 JSON 檔案。
 * 使用者取消選擇時拋出 DriveAuthCancelledError。
 */
export async function pickFamilyLedgerFile(
  accessToken: string,
  options?: PickFamilyLedgerFileOptions,
): Promise<{ id: string; name: string }> {
  if (!isPickerConfigured()) {
    throw new Error('尚未設定 Google 檔案選擇器金鑰');
  }

  const pickerApi = await ensureGooglePickerLoaded();
  const targetFileId = options?.fileId?.trim() || undefined;

  return new Promise<{ id: string; name: string }>((resolve, reject) => {
    const view = new pickerApi.DocsView()
      .setIncludeFolders(false)
      .setMimeTypes('application/json')
      .setOwnedByMe(false);

    if (targetFileId) {
      view.setFileIds(targetFileId);
    } else {
      view.setQuery('fun2young');
    }

    const title = targetFileId
      ? '請點選家人分享的帳本，再按「選取」'
      : '請點選結尾是 .fun2young.json 的帳本，再按「選取」';

    const maxW = typeof window !== 'undefined' ? window.innerWidth : 640;
    const maxH = typeof window !== 'undefined' ? window.innerHeight : 480;
    const width = Math.min(Math.max(300, maxW - 24), 720);
    const height = Math.min(Math.max(380, maxH - 48), 540);

    const picker = new pickerApi.PickerBuilder()
      .addView(view)
      .setTitle(title)
      .setSize(width, height)
      .setOAuthToken(accessToken)
      .setDeveloperKey(GOOGLE_PICKER_API_KEY)
      .setAppId(GOOGLE_CLOUD_PROJECT_NUMBER)
      .setCallback((data) => {
        if (data.action === pickerApi.Action.PICKED) {
          const doc = data.docs?.[0];
          if (doc?.id) {
            resolve({ id: doc.id, name: doc.name ?? '' });
          } else {
            reject(new DriveAuthCancelledError('未選擇任何檔案'));
          }
          return;
        }
        if (data.action === pickerApi.Action.CANCEL) {
          reject(new DriveAuthCancelledError('已取消選擇家庭帳本檔案'));
        }
      })
      .build();

    picker.setVisible(true);
  });
}
