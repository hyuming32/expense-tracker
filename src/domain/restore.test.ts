import { describe, expect, it } from 'vitest';
import {
  formatBackupFileLabel,
  formatBackupFileSize,
  isNewDevice,
  summarizeBackupPayload,
} from './restore';

describe('新裝置判斷 isNewDevice', () => {
  it('只有種子資料（0 筆交易）時判斷為新裝置', () => {
    expect(isNewDevice([])).toBe(true);
  });

  it('有一筆自建未刪除交易時判斷為非新裝置', () => {
    expect(
      isNewDevice([
        { deleted: false, deviceId: 'device-a' },
      ]),
    ).toBe(false);
  });

  it('只有已刪除交易時仍判斷為新裝置', () => {
    expect(
      isNewDevice([
        { deleted: true, deviceId: 'device-a' },
        { deleted: true, deviceId: 'device-b' },
      ]),
    ).toBe(true);
  });
});

describe('備份摘要與格式化工具', () => {
  it('summarizeBackupPayload 計算未刪除交易筆數、帳戶數與日期範圍', () => {
    const summary = summarizeBackupPayload({
      accounts: [{ deleted: false }, { deleted: true }],
      transactions: [
        { date: '2026-10-05', deleted: false },
        { date: '2026-11-20', deleted: false },
        { date: '2026-01-01', deleted: true },
      ],
    });

    expect(summary).toEqual({
      transactionCount: 2,
      accountCount: 1,
      minDate: '2026-10-05',
      maxDate: '2026-11-20',
    });
  });

  it('formatBackupFileSize 與 formatBackupFileLabel 格式化正確', () => {
    expect(formatBackupFileSize(512)).toBe('512 B');
    expect(formatBackupFileSize(2048)).toBe('2 KB');
    expect(formatBackupFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBackupFileSize(undefined)).toBeNull();

    expect(formatBackupFileLabel({ name: '記帳備份_2026-11-26_0930.json' })).toBe(
      '2026/11/26 09:30',
    );
  });
});
