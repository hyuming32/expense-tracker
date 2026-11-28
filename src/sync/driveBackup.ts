import { db, type ExpenseDatabase, META_KEYS, personalDb } from '../db/database';
import { type BackupPayload, exportBackupData, parseBackupPayload } from '../db/repository';
import { type RestoreDataSummary, summarizeBackupPayload } from '../domain/restore';
import { requestDriveFileAccessToken } from './auth';
import { DriveApiError, type DriveStore } from './driveStore';

export const BACKUP_FOLDER_NAME = '記帳備份';
export const BACKUP_FILE_PREFIX = '記帳備份_';
export const BACKUP_KEEP_COUNT = 10;
export const BACKUP_LIST_DEFAULT_LIMIT = 5;

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveBackupFile {
  id: string;
  name: string;
  createdTime?: string;
  size?: number;
}

export interface DriveBackupResult {
  fileId: string;
  fileName: string;
  backedUpAt: number;
  trashedCount: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 產生可見備份檔名：`記帳備份_YYYY-MM-DD_HHmm.json`（使用本地時間並補零）。
 */
export function buildBackupFileName(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  return `${BACKUP_FILE_PREFIX}${year}-${month}-${day}_${hours}${minutes}.json`;
}

function parseCreatedTimeMs(createdTime?: string): number {
  if (!createdTime) {
    return 0;
  }
  const ms = Date.parse(createdTime);
  return Number.isFinite(ms) ? ms : 0;
}

function compareBackupFilesDesc<T extends DriveBackupFile>(a: T, b: T): number {
  const timeDiff = parseCreatedTimeMs(b.createdTime) - parseCreatedTimeMs(a.createdTime);
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return b.name.localeCompare(a.name);
}

/**
 * 從檔案清單中篩選以「記帳備份_」開頭的檔案，依時間由新到舊排序，最多回傳指定筆數（預設 5 份）。
 */
export function selectRecentBackups<T extends DriveBackupFile>(
  files: readonly T[],
  limit: number = BACKUP_LIST_DEFAULT_LIMIT,
): T[] {
  const safeLimit = Math.max(0, Math.trunc(limit));
  const backupFiles = files.filter((f) => f.name.startsWith(BACKUP_FILE_PREFIX));
  if (safeLimit === 0 || backupFiles.length === 0) {
    return [];
  }
  return [...backupFiles].sort(compareBackupFilesDesc).slice(0, safeLimit);
}

/**
 * 從檔案清單中篩選以「記帳備份_」開頭的檔案，依建立時間由新到舊排序後，
 * 回傳超過保留份數（預設 10 份）的較舊檔案清單供移入垃圾桶。
 */
export function selectBackupsToTrash<T extends DriveBackupFile>(
  files: readonly T[],
  keep: number = BACKUP_KEEP_COUNT,
): T[] {
  const safeKeep = Math.max(0, Math.trunc(keep));
  const backupFiles = files.filter((f) => f.name.startsWith(BACKUP_FILE_PREFIX));
  if (backupFiles.length <= safeKeep) {
    return [];
  }

  const sorted = [...backupFiles].sort(compareBackupFilesDesc);
  return sorted.slice(safeKeep);
}

async function authorizedFetch(
  getToken: () => Promise<string>,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const token = await getToken();
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

async function isFolderValid(getToken: () => Promise<string>, folderId: string): Promise<boolean> {
  try {
    const res = await authorizedFetch(
      getToken,
      `${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}?fields=id,trashed,mimeType`,
    );
    const data = (await res.json()) as {
      id?: string;
      trashed?: boolean;
      mimeType?: string;
    };
    return Boolean(data.id) && data.trashed !== true && data.mimeType === FOLDER_MIME_TYPE;
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 404) {
      return false;
    }
    throw err;
  }
}

async function findBackupFolder(
  getToken: () => Promise<string>,
  database: ExpenseDatabase,
): Promise<string | null> {
  const saved = await database.meta.get(META_KEYS.DRIVE_BACKUP_FOLDER_ID);
  if (saved?.value) {
    const valid = await isFolderValid(getToken, saved.value);
    if (valid) {
      return saved.value;
    }
  }

  const query = `name = '${BACKUP_FOLDER_NAME}' and mimeType = '${FOLDER_MIME_TYPE}' and 'root' in parents and trashed = false`;
  const listParams = new URLSearchParams({
    q: query,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: '10',
  });
  const listRes = await authorizedFetch(getToken, `${DRIVE_API_BASE}/files?${listParams.toString()}`);
  const listData = (await listRes.json()) as {
    files?: Array<{ id: string; name: string }>;
  };

  const folderId = listData.files?.[0]?.id ?? null;
  if (folderId) {
    await database.meta.put({
      key: META_KEYS.DRIVE_BACKUP_FOLDER_ID,
      value: folderId,
    });
  }
  return folderId;
}

async function findOrCreateBackupFolder(
  getToken: () => Promise<string>,
  database: ExpenseDatabase,
): Promise<string> {
  const existingId = await findBackupFolder(getToken, database);
  if (existingId) {
    return existingId;
  }

  const createRes = await authorizedFetch(getToken, `${DRIVE_API_BASE}/files?fields=id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      name: BACKUP_FOLDER_NAME,
      mimeType: FOLDER_MIME_TYPE,
      parents: ['root'],
    }),
  });
  const created = (await createRes.json()) as { id: string };
  const folderId = created.id;

  await database.meta.put({
    key: META_KEYS.DRIVE_BACKUP_FOLDER_ID,
    value: folderId,
  });

  return folderId;
}

async function uploadBackupFile(
  getToken: () => Promise<string>,
  folderId: string,
  fileName: string,
  json: string,
): Promise<{ id: string; name: string }> {
  const boundary = `expense_backup_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
    mimeType: 'application/json',
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

  const res = await authorizedFetch(
    getToken,
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name`,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );

  const data = (await res.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
}

async function listFolderFiles(
  getToken: () => Promise<string>,
  folderId: string,
): Promise<DriveBackupFile[]> {
  const files: DriveBackupFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,createdTime,size)',
      orderBy: 'createdTime desc',
      pageSize: '100',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const res = await authorizedFetch(getToken, `${DRIVE_API_BASE}/files?${params.toString()}`);
    const data = (await res.json()) as {
      nextPageToken?: string;
      files?: Array<{ id: string; name: string; createdTime?: string; size?: string | number }>;
    };

    if (Array.isArray(data.files)) {
      for (const f of data.files) {
        const parsedSize =
          typeof f.size === 'number'
            ? f.size
            : typeof f.size === 'string' && f.size.trim().length > 0
              ? Number(f.size)
              : undefined;
        files.push({
          id: f.id,
          name: f.name,
          createdTime: f.createdTime,
          size: parsedSize !== undefined && Number.isFinite(parsedSize) ? parsedSize : undefined,
        });
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

async function trashDriveFile(getToken: () => Promise<string>, fileId: string): Promise<void> {
  await authorizedFetch(getToken, `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ trashed: true }),
  });
}

/**
 * 讀取本機記錄的上次備份到 Google Drive 時間戳記。
 */
export async function getLastDriveBackupAt(
  database: ExpenseDatabase = personalDb,
): Promise<number | null> {
  const entry = await database.meta.get(META_KEYS.DRIVE_BACKUP_LAST_AT);
  if (!entry) {
    return null;
  }
  const num = Number(entry.value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * 將完整 JSON 備份上傳至使用者 Google Drive 根目錄「記帳備份」資料夾，
 * 並將超過最近 10 份的較舊備份移至垃圾桶。
 */
export async function backupToGoogleDrive(options?: {
  database?: ExpenseDatabase;
  getToken?: () => Promise<string>;
  now?: Date;
}): Promise<DriveBackupResult> {
  const database = options?.database ?? db;
  const metaDb = options?.database ?? personalDb;
  const now = options?.now ?? new Date();
  let cachedToken: string | null = null;
  const getToken =
    options?.getToken ??
    (async () => {
      if (!cachedToken) {
        cachedToken = await requestDriveFileAccessToken();
      }
      return cachedToken;
    });

  // 先取得授權，若使用者拒絕則提早中止
  await getToken();

  const payload = await exportBackupData(database);
  const json = JSON.stringify(payload, null, 2);
  const fileName = buildBackupFileName(now);

  const folderId = await findOrCreateBackupFolder(getToken, metaDb);
  const uploaded = await uploadBackupFile(getToken, folderId, fileName, json);

  const backedUpAt = Date.now();
  await metaDb.meta.put({
    key: META_KEYS.DRIVE_BACKUP_LAST_AT,
    value: String(backedUpAt),
  });

  const existingFiles = await listFolderFiles(getToken, folderId);
  const toTrash = selectBackupsToTrash(existingFiles, BACKUP_KEEP_COUNT);
  for (const file of toTrash) {
    await trashDriveFile(getToken, file.id);
  }

  return {
    fileId: uploaded.id,
    fileName: uploaded.name,
    backedUpAt,
    trashedCount: toTrash.length,
  };
}

function createCachedTokenGetter(customGetToken?: () => Promise<string>): () => Promise<string> {
  if (customGetToken) {
    return customGetToken;
  }
  let cachedToken: string | null = null;
  return async () => {
    if (!cachedToken) {
      cachedToken = await requestDriveFileAccessToken();
    }
    return cachedToken;
  };
}

/**
 * 列出 Google Drive「記帳備份」資料夾中的備份檔（依時間由新到舊排序，預設最多 5 份）。
 * 若傳入 driveStore（如 MemoryDriveStore），則直接透過 DriveStore 介面讀取以便測試。
 */
export async function listDriveBackups(options?: {
  driveStore?: DriveStore;
  database?: ExpenseDatabase;
  getToken?: () => Promise<string>;
  limit?: number;
}): Promise<DriveBackupFile[]> {
  const limit = options?.limit ?? BACKUP_LIST_DEFAULT_LIMIT;

  if (options?.driveStore) {
    const files = await options.driveStore.list();
    return selectRecentBackups(files, limit);
  }

  const database = options?.database ?? personalDb;
  const getToken = createCachedTokenGetter(options?.getToken);
  const folderId = await findBackupFolder(getToken, database);
  if (!folderId) {
    return [];
  }

  const files = await listFolderFiles(getToken, folderId);
  return selectRecentBackups(files, limit);
}

export interface DownloadedDriveBackup {
  payload: BackupPayload;
  summary: RestoreDataSummary;
}

/**
 * 下載指定的 Google Drive 備份檔內容並解析為 BackupPayload 與摘要資訊。
 * 若傳入 driveStore（如 MemoryDriveStore），則直接透過 DriveStore 介面下載以便測試。
 */
export async function downloadDriveBackup(
  fileId: string,
  options?: {
    driveStore?: DriveStore;
    getToken?: () => Promise<string>;
  },
): Promise<DownloadedDriveBackup> {
  let raw: string;

  if (options?.driveStore) {
    raw = await options.driveStore.download(fileId);
  } else {
    const getToken = createCachedTokenGetter(options?.getToken);
    const res = await authorizedFetch(
      getToken,
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
    );
    raw = await res.text();
  }

  const parsed: unknown = JSON.parse(raw);
  const payload = parseBackupPayload(parsed);
  const summary = summarizeBackupPayload(payload);
  return { payload, summary };
}
