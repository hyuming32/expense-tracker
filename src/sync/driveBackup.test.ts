import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ExpenseDatabase, ensureSeeded } from '../db/database';
import { exportBackupData, restoreBackupData, saveTransaction } from '../db/repository';
import {
  buildBackupFileName,
  downloadDriveBackup,
  type DriveBackupFile,
  listDriveBackups,
  selectBackupsToTrash,
} from './driveBackup';
import { MemoryDriveStore } from './driveStore';

const createdDbs: ExpenseDatabase[] = [];

function createTestDb(label: string): ExpenseDatabase {
  const database = new ExpenseDatabase(`test-drive-backup-${label}-${Date.now()}-${Math.random()}`);
  createdDbs.push(database);
  return database;
}

afterEach(async () => {
  while (createdDbs.length > 0) {
    const database = createdDbs.pop();
    if (database) {
      await database.delete();
    }
  }
});

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

describe('driveBackup 列出、下載與還原整合（MemoryDriveStore）', () => {
  it('列出備份檔依時間新到舊排序且預設最多 5 份', async () => {
    const drive = new MemoryDriveStore();
    await drive.upload('其他檔案.txt', '{}');
    for (let day = 1; day <= 7; day++) {
      await drive.upload(`記帳備份_2026-11-0${day}_1000.json`, '{}');
    }

    const listed = await listDriveBackups({ driveStore: drive });
    expect(listed).toHaveLength(5);
    expect(listed.map((f) => f.name)).toEqual([
      '記帳備份_2026-11-07_1000.json',
      '記帳備份_2026-11-06_1000.json',
      '記帳備份_2026-11-05_1000.json',
      '記帳備份_2026-11-04_1000.json',
      '記帳備份_2026-11-03_1000.json',
    ]);
  });

  it('下載備份並解析出筆數與日期範圍，且還原後本機資料正確', async () => {
    const drive = new MemoryDriveStore();
    const sourceDb = createTestDb('source');
    const targetDb = createTestDb('target');

    await ensureSeeded(sourceDb);
    await ensureSeeded(targetDb);

    await saveTransaction(
      {
        kind: 'expense',
        date: '2026-10-12',
        amount: 120,
        accountId: 'seed-acc-cash',
        toAccountId: null,
        categoryId: 'seed-cat-food-lunch',
        note: '麵線',
      },
      sourceDb,
    );
    await saveTransaction(
      {
        kind: 'income',
        date: '2026-11-26',
        amount: 5000,
        accountId: 'seed-acc-bank',
        toAccountId: null,
        categoryId: 'seed-cat-income-bonus',
        note: '獎金',
      },
      sourceDb,
    );

    const backupPayload = await exportBackupData(sourceDb);
    const uploaded = await drive.upload(
      '記帳備份_2026-11-26_1200.json',
      JSON.stringify(backupPayload),
    );

    const downloaded = await downloadDriveBackup(uploaded.id, { driveStore: drive });
    expect(downloaded.summary).toEqual({
      transactionCount: 2,
      accountCount: 3,
      minDate: '2026-10-12',
      maxDate: '2026-11-26',
    });

    await restoreBackupData(downloaded.payload, targetDb);
    const targetTxs = await targetDb.transactions.toArray();
    expect(targetTxs.filter((tx) => !tx.deleted)).toHaveLength(2);
    expect(targetTxs.map((tx) => tx.note).sort()).toEqual(['獎金', '麵線']);
  });
});
