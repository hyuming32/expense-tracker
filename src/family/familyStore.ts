import { DriveApiError } from '../sync/driveStore';

export interface FamilyDriveAbout {
  permissionId: string;
  emailAddress: string;
  displayName: string;
}

export interface FamilyDriveFileItem {
  id: string;
  name: string;
  ownedByMe: boolean;
}

export interface FamilyDriveStore {
  about(): Promise<FamilyDriveAbout>;
  create(name: string, json: string): Promise<{ id: string }>;
  download(fileId: string): Promise<string>;
  update(fileId: string, json: string): Promise<void>;
  findAppFiles(): Promise<FamilyDriveFileItem[]>;
  share(fileId: string, email: string): Promise<void>;
  unshare(fileId: string, permissionId: string): Promise<void>;
}

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const SHARE_EMAIL_MESSAGE = '打開 Fun2young記帳 → 設定 → 家庭帳本 → 加入';

/**
 * 使用 fetch 呼叫 Google Drive REST v3（drive.file 權限範圍）的家庭帳本儲存實作。
 */
export class FetchFamilyDriveStore implements FamilyDriveStore {
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

  async about(): Promise<FamilyDriveAbout> {
    const res = await this.authorizedFetch(`${DRIVE_API_BASE}/about?fields=user`);
    const data = (await res.json()) as {
      user?: {
        permissionId?: string;
        emailAddress?: string;
        displayName?: string;
      };
    };
    const permissionId = data.user?.permissionId?.trim() ?? '';
    const emailAddress = data.user?.emailAddress?.trim() ?? '';
    const displayName = data.user?.displayName?.trim() || emailAddress;
    if (!permissionId || !emailAddress) {
      throw new Error('無法取得 Google 帳號使用者資訊');
    }
    return { permissionId, emailAddress, displayName };
  }

  async create(name: string, json: string): Promise<{ id: string }> {
    const boundary = `fun2young_family_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const metadata = JSON.stringify({
      name,
      mimeType: 'application/json',
      parents: ['root'],
      appProperties: { fun2youngFamily: '1' },
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
      `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    const data = (await res.json()) as { id: string };
    return { id: data.id };
  }

  async download(fileId: string): Promise<string> {
    const res = await this.authorizedFetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
    );
    return res.text();
  }

  async update(fileId: string, json: string): Promise<void> {
    await this.authorizedFetch(
      `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: json,
      },
    );
  }

  async findAppFiles(): Promise<FamilyDriveFileItem[]> {
    const files: FamilyDriveFileItem[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q: "appProperties has { key='fun2youngFamily' and value='1' } and trashed=false",
        spaces: 'drive',
        fields: 'nextPageToken,files(id,name,ownedByMe)',
        pageSize: '100',
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }
      const res = await this.authorizedFetch(`${DRIVE_API_BASE}/files?${params.toString()}`);
      const data = (await res.json()) as {
        nextPageToken?: string;
        files?: Array<{ id: string; name: string; ownedByMe?: boolean }>;
      };
      if (Array.isArray(data.files)) {
        for (const f of data.files) {
          files.push({
            id: f.id,
            name: f.name,
            ownedByMe: Boolean(f.ownedByMe),
          });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
  }

  async share(fileId: string, email: string): Promise<void> {
    const params = new URLSearchParams({
      sendNotificationEmail: 'true',
      emailMessage: SHARE_EMAIL_MESSAGE,
    });
    await this.authorizedFetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({
          role: 'writer',
          type: 'user',
          emailAddress: email,
        }),
      },
    );
  }

  async unshare(fileId: string, permissionId: string): Promise<void> {
    await this.authorizedFetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
      {
        method: 'DELETE',
      },
    );
  }
}

interface MemoryFamilyFileEntry {
  id: string;
  name: string;
  ownerPermissionId: string;
  content: string;
  allowedEmails: Set<string>;
  allowedPermissionIds: Set<string>;
}

/**
 * 供單元與整合測試使用的記憶體版家庭雲端儲存（支援多成員權限模擬）。
 */
export class MemoryFamilyDriveStore implements FamilyDriveStore {
  private readonly files = new Map<string, MemoryFamilyFileEntry>();
  private readonly userByEmail = new Map<string, FamilyDriveAbout>();
  private readonly user: FamilyDriveAbout;
  private readonly nextIdRef: { current: number };

  constructor(
    user: FamilyDriveAbout = {
      permissionId: 'perm-owner',
      emailAddress: 'owner@example.com',
      displayName: 'Owner',
    },
    sharedState?: {
      files: Map<string, MemoryFamilyFileEntry>;
      userByEmail: Map<string, FamilyDriveAbout>;
      nextIdRef: { current: number };
    },
  ) {
    this.user = user;
    if (sharedState) {
      this.files = sharedState.files;
      this.userByEmail = sharedState.userByEmail;
      this.nextIdRef = sharedState.nextIdRef;
    } else {
      this.nextIdRef = { current: 1 };
    }
    this.userByEmail.set(user.emailAddress.toLowerCase(), user);
  }

  /**
   * 切換或取得另一個成員視角的儲存實作（共用同一份模擬雲端檔案與權限狀態）。
   */
  asUser(user: FamilyDriveAbout): MemoryFamilyDriveStore {
    this.userByEmail.set(user.emailAddress.toLowerCase(), user);
    return new MemoryFamilyDriveStore(user, {
      files: this.files,
      userByEmail: this.userByEmail,
      nextIdRef: this.nextIdRef,
    });
  }

  private getAuthorizedFile(fileId: string): MemoryFamilyFileEntry {
    const entry = this.files.get(fileId);
    if (!entry) {
      throw new DriveApiError(`找不到檔案：${fileId}`, 404);
    }
    const emailKey = this.user.emailAddress.toLowerCase();
    if (
      entry.ownerPermissionId !== this.user.permissionId &&
      !entry.allowedPermissionIds.has(this.user.permissionId) &&
      !entry.allowedEmails.has(emailKey)
    ) {
      throw new DriveApiError('沒有權限存取此家庭帳本檔案', 403);
    }
    return entry;
  }

  async about(): Promise<FamilyDriveAbout> {
    return { ...this.user };
  }

  async create(name: string, json: string): Promise<{ id: string }> {
    const id = `mem-family-${this.nextIdRef.current++}`;
    this.files.set(id, {
      id,
      name,
      ownerPermissionId: this.user.permissionId,
      content: json,
      allowedEmails: new Set([this.user.emailAddress.toLowerCase()]),
      allowedPermissionIds: new Set([this.user.permissionId]),
    });
    return { id };
  }

  async download(fileId: string): Promise<string> {
    const entry = this.getAuthorizedFile(fileId);
    return entry.content;
  }

  async update(fileId: string, json: string): Promise<void> {
    const entry = this.getAuthorizedFile(fileId);
    entry.content = json;
  }

  async findAppFiles(): Promise<FamilyDriveFileItem[]> {
    const result: FamilyDriveFileItem[] = [];
    const emailKey = this.user.emailAddress.toLowerCase();
    for (const entry of this.files.values()) {
      const ownedByMe = entry.ownerPermissionId === this.user.permissionId;
      const hasAccess =
        ownedByMe ||
        entry.allowedPermissionIds.has(this.user.permissionId) ||
        entry.allowedEmails.has(emailKey);
      if (hasAccess) {
        result.push({ id: entry.id, name: entry.name, ownedByMe });
      }
    }
    return result;
  }

  async share(fileId: string, email: string): Promise<void> {
    const entry = this.getAuthorizedFile(fileId);
    const normalized = email.trim().toLowerCase();
    entry.allowedEmails.add(normalized);
    const knownUser = this.userByEmail.get(normalized);
    if (knownUser) {
      entry.allowedPermissionIds.add(knownUser.permissionId);
    }
  }

  async unshare(fileId: string, permissionId: string): Promise<void> {
    const entry = this.getAuthorizedFile(fileId);
    entry.allowedPermissionIds.delete(permissionId);
    for (const [email, user] of this.userByEmail.entries()) {
      if (user.permissionId === permissionId) {
        entry.allowedEmails.delete(email);
      }
    }
  }
}
