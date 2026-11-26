interface PickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: PickerAcceptType[];
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  types?: PickerAcceptType[];
}

interface FileSystemWritableFileStream {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
  getFile(): Promise<File>;
}

interface WindowWithFilePickers extends Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
}

export type SaveFileResult = 'saved' | 'cancelled';

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function getBaseMimeType(mime: string): string {
  return mime.split(';')[0]?.trim() || 'application/octet-stream';
}

function getExtensionFromName(filename: string): string | null {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === filename.length - 1) {
    return null;
  }
  return filename.slice(dotIdx).toLowerCase();
}

function buildPickerTypes(suggestedName: string, mime: string): PickerAcceptType[] | undefined {
  const ext = getExtensionFromName(suggestedName);
  const baseMime = getBaseMimeType(mime);
  if (!ext) {
    return undefined;
  }
  return [
    {
      accept: {
        [baseMime]: [ext],
      },
    },
  ];
}

function triggerAnchorDownload(blob: Blob, suggestedName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * 依執行環境選擇最適合的本地存檔方式：
 * 1. window.showSaveFilePicker（電腦版 Chrome / Edge）
 * 2. navigator.canShare({ files })（iOS / Android / PWA）
 * 3. <a download> 下載（其他瀏覽器）
 * 使用者取消時回傳 'cancelled'，成功回傳 'saved'。
 */
export async function saveFile(
  blob: Blob,
  suggestedName: string,
  mime: string,
): Promise<SaveFileResult> {
  const win = typeof window !== 'undefined' ? (window as WindowWithFilePickers) : undefined;
  const pickerTypes = buildPickerTypes(suggestedName, mime);

  if (win && typeof win.showSaveFilePicker === 'function') {
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName,
        ...(pickerTypes ? { types: pickerTypes } : {}),
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'saved';
    } catch (err) {
      if (isAbortError(err)) {
        return 'cancelled';
      }
      throw err;
    }
  }

  const baseMime = getBaseMimeType(mime);
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function'
  ) {
    const file = new File([blob], suggestedName, { type: baseMime });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: suggestedName });
        return 'saved';
      } catch (err) {
        if (isAbortError(err)) {
          return 'cancelled';
        }
        // 若分享因非取消原因失敗（例如非使用者手勢觸發），降級改用下載
      }
    }
  }

  triggerAnchorDownload(blob, suggestedName);
  return 'saved';
}

/**
 * 檢查是否支援電腦版 showOpenFilePicker。
 */
export function supportsOpenFilePicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as WindowWithFilePickers).showOpenFilePicker === 'function'
  );
}

/**
 * 使用 showOpenFilePicker 開啟單一檔案；使用者取消時回傳 null。
 */
export async function pickFileWithSystemPicker(
  description: string,
  mime: string,
  extensions: string[],
): Promise<File | null> {
  const win = window as WindowWithFilePickers;
  if (typeof win.showOpenFilePicker !== 'function') {
    return null;
  }
  try {
    const [handle] = await win.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description,
          accept: { [mime]: extensions },
        },
      ],
    });
    if (!handle) {
      return null;
    }
    return await handle.getFile();
  } catch (err) {
    if (isAbortError(err)) {
      return null;
    }
    throw err;
  }
}
