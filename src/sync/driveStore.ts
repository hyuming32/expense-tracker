export interface DriveFile {
  id: string;
  name: string;
}

export interface DriveStore {
  list(): Promise<DriveFile[]>;
  download(fileId: string): Promise<string>;
  upload(name: string, json: string): Promise<DriveFile>;
  update(fileId: string, json: string): Promise<DriveFile>;
  remove(fileId: string): Promise<void>;
}

export class DriveApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DriveApiError';
    this.status = status;
  }
}

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/**
 * 使用 fetch 呼叫 Google Drive REST API（appDataFolder）的正式版儲存實作。
 */
export class FetchDriveStore implements DriveStore {
  private readonly getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.getToken = getToken;
  }

  private async authorizedFetch(url: string, init?: RequestInit): Promise<Response> {
    const token = await this.getToken();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);

    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new DriveApiError(
        `Drive API 錯誤（${response.status}）${detail ? `: ${detail}` : ''}`,
        response.status,
      );
    }
    return response;
  }

  async list(): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        fields: 'nextPageToken,files(id,name)',
        pageSize: '1000',
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      const res = await this.authorizedFetch(`${DRIVE_API_BASE}/files?${params.toString()}`);
      const data = (await res.json()) as {
        nextPageToken?: string;
        files?: Array<{ id: string; name: string }>;
      };

      if (Array.isArray(data.files)) {
        for (const f of data.files) {
          files.push({ id: f.id, name: f.name });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
  }

  async download(fileId: string): Promise<string> {
    const res = await this.authorizedFetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
    );
    return res.text();
  }

  async upload(name: string, json: string): Promise<DriveFile> {
    const boundary = `expense_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const metadata = JSON.stringify({
      name,
      parents: ['appDataFolder'],
    });

    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      metadata,
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      json,
      `--${boundary}--`,
    ].join('\r\n');

    const res = await this.authorizedFetch(
      `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );

    const data = (await res.json()) as DriveFile;
    return { id: data.id, name: data.name };
  }

  async update(fileId: string, json: string): Promise<DriveFile> {
    const res = await this.authorizedFetch(
      `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: json,
      },
    );

    const data = (await res.json()) as DriveFile;
    return { id: data.id, name: data.name };
  }

  async remove(fileId: string): Promise<void> {
    await this.authorizedFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    });
  }
}

/**
 * 供單元／整合測試使用的記憶體版 DriveStore。
 */
export class MemoryDriveStore implements DriveStore {
  private readonly files = new Map<string, { id: string; name: string; content: string }>();
  private nextId = 1;
  failNextUpload = false;

  async list(): Promise<DriveFile[]> {
    return Array.from(this.files.values()).map(({ id, name }) => ({ id, name }));
  }

  async download(fileId: string): Promise<string> {
    const entry = this.files.get(fileId);
    if (!entry) {
      throw new DriveApiError(`找不到檔案：${fileId}`, 404);
    }
    return entry.content;
  }

  async upload(name: string, json: string): Promise<DriveFile> {
    if (this.failNextUpload) {
      this.failNextUpload = false;
      throw new DriveApiError('模擬上傳失敗', 503);
    }
    const id = `mem-file-${this.nextId++}`;
    this.files.set(id, { id, name, content: json });
    return { id, name };
  }

  async update(fileId: string, json: string): Promise<DriveFile> {
    const existing = this.files.get(fileId);
    if (!existing) {
      throw new DriveApiError(`找不到檔案：${fileId}`, 404);
    }
    existing.content = json;
    return { id: existing.id, name: existing.name };
  }

  async remove(fileId: string): Promise<void> {
    this.files.delete(fileId);
  }
}
