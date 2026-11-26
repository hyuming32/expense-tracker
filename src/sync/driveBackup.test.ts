import { describe, expect, it } from 'vitest';
import {
  buildBackupFileName,
  type DriveBackupFile,
  selectBackupsToTrash,
} from './driveBackup';

function makeFile(idx: number, createdTime: string, prefix = '記帳備份_'): DriveBackupFile {
  return {
    id: `file-${idx}`,
    name: `${prefix}2026-11-${String(idx).padStart(2, '0')}_1000.json`,
    createdTime,
  };
}

describe('driveBackup 純邏輯', () => {
  it('buildBackupFileName 依本地時間格式化並補零', () => {
    const dt = new Date(2026, 0, 5, 9, 3); // 2026-01-05 09:03 本地時間
    expect(buildBackupFileName(dt)).toBe('記帳備份_2026-01-05_0903.json');

    const dt2 = new Date(2026, 10, 26, 17, 45); // 2026-11-26 17:45 本地時間
    expect(buildBackupFileName(dt2)).toBe('記帳備份_2026-11-26_1745.json');
  });

  it('selectBackupsToTrash 少於或等於 10 份時不淘汰任何檔案', () => {
    const fewer = Array.from({ length: 5 }, (_, i) =>
      makeFile(i + 1, `2026-11-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`),
    );
    expect(selectBackupsToTrash(fewer)).toEqual([]);

    const exactTen = Array.from({ length: 10 }, (_, i) =>
      makeFile(i + 1, `2026-11-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`),
    );
    expect(selectBackupsToTrash(exactTen)).toEqual([]);
  });

  it('selectBackupsToTrash 超過 10 份時僅保留最新 10 份並淘汰較舊檔案', () => {
    const files: DriveBackupFile[] = Array.from({ length: 13 }, (_, i) =>
      makeFile(i + 1, `2026-11-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`),
    );
    // 打亂輸入順序確認排序正確
    const shuffled = [...files].reverse();
    const toTrash = selectBackupsToTrash(shuffled, 10);

    expect(toTrash.map((f) => f.id)).toEqual(['file-3', 'file-2', 'file-1']);
  });

  it('selectBackupsToTrash 只計算「記帳備份_」開頭的檔案', () => {
    const backups = Array.from({ length: 11 }, (_, i) =>
      makeFile(i + 1, `2026-11-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`),
    );
    const others: DriveBackupFile[] = [
      { id: 'other-1', name: '筆記.txt', createdTime: '2026-10-01T00:00:00.000Z' },
      { id: 'other-2', name: '手動備份.json', createdTime: '2026-11-20T00:00:00.000Z' },
      { id: 'other-3', name: '說明文件.pdf', createdTime: '2026-11-25T00:00:00.000Z' },
    ];

    const toTrash = selectBackupsToTrash([...backups, ...others], 10);
    expect(toTrash.map((f) => f.id)).toEqual(['file-1']);
  });
});
