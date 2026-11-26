import { useEffect, useState } from 'react';
import { type BackupPayload, restoreBackupData } from '../db/repository';
import {
  formatBackupFileLabel,
  formatBackupFileSize,
  type RestoreDataSummary,
} from '../domain/restore';
import { DriveAuthCancelledError } from '../sync/auth';
import {
  downloadDriveBackup,
  type DriveBackupFile,
  listDriveBackups,
} from '../sync/driveBackup';
import { toFriendlySyncError, triggerSync } from '../sync/syncManager';

export type CloudRestoreModalMode =
  | {
      kind: 'synced-restored';
      appliedTransactionsCount: number;
      summary: RestoreDataSummary;
    }
  | { kind: 'check-backups' }
  | { kind: 'manual-backups' };

interface CloudRestoreModalProps {
  mode: CloudRestoreModalMode | null;
  onClose: () => void;
}

type ModalStep =
  | { kind: 'synced-restored' }
  | { kind: 'loading-list' }
  | { kind: 'auth-needed' }
  | { kind: 'empty' }
  | { kind: 'list'; totalCount: number; files: DriveBackupFile[] }
  | { kind: 'downloading'; file: DriveBackupFile; totalCount: number; files: DriveBackupFile[] }
  | {
      kind: 'preview';
      file: DriveBackupFile;
      payload: BackupPayload;
      summary: RestoreDataSummary;
      totalCount: number;
      files: DriveBackupFile[];
    }
  | { kind: 'restoring'; file: DriveBackupFile; summary: RestoreDataSummary }
  | { kind: 'restored'; summary: RestoreDataSummary }
  | { kind: 'error'; message: string };

function formatDateRange(summary: RestoreDataSummary): string {
  if (!summary.minDate || !summary.maxDate) {
    return '無交易紀錄';
  }
  if (summary.minDate === summary.maxDate) {
    return summary.minDate;
  }
  return `${summary.minDate} ～ ${summary.maxDate}`;
}

function isDriveAuthError(err: unknown): boolean {
  if (err instanceof DriveAuthCancelledError) {
    return true;
  }
  if (err instanceof Error && /授權|popup|token|client/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * 登入後新裝置還原提示與從 Google 雲端備份還原的共用面板。
 */
export function CloudRestoreModal({ mode, onClose }: CloudRestoreModalProps) {
  const [step, setStep] = useState<ModalStep>({ kind: 'loading-list' });

  async function loadBackupList() {
    setStep({ kind: 'loading-list' });
    try {
      const allFiles = await listDriveBackups({ limit: 100 });
      if (allFiles.length === 0) {
        setStep({ kind: 'empty' });
        return;
      }
      setStep({
        kind: 'list',
        totalCount: allFiles.length,
        files: allFiles.slice(0, 5),
      });
    } catch (err) {
      if (isDriveAuthError(err)) {
        setStep({ kind: 'auth-needed' });
        return;
      }
      setStep({ kind: 'error', message: toFriendlySyncError(err) });
    }
  }

  useEffect(() => {
    if (!mode) {
      return;
    }
    if (mode.kind === 'synced-restored') {
      setStep({ kind: 'synced-restored' });
      return;
    }
    void loadBackupList();
  }, [mode]);

  if (!mode) {
    return null;
  }

  async function handleSelectFile(
    file: DriveBackupFile,
    totalCount: number,
    files: DriveBackupFile[],
  ) {
    setStep({ kind: 'downloading', file, totalCount, files });
    try {
      const { payload, summary } = await downloadDriveBackup(file.id);
      setStep({
        kind: 'preview',
        file,
        payload,
        summary,
        totalCount,
        files,
      });
    } catch (err) {
      if (isDriveAuthError(err)) {
        setStep({ kind: 'auth-needed' });
        return;
      }
      setStep({
        kind: 'error',
        message: err instanceof Error ? err.message : '下載或解析備份檔失敗',
      });
    }
  }

  async function handleConfirmRestore(
    file: DriveBackupFile,
    payload: BackupPayload,
    summary: RestoreDataSummary,
  ) {
    setStep({ kind: 'restoring', file, summary });
    try {
      await restoreBackupData(payload);
      await triggerSync();
      setStep({ kind: 'restored', summary });
    } catch (err) {
      setStep({
        kind: 'error',
        message: err instanceof Error ? err.message : '還原備份失敗',
      });
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Google 雲端帳目還原"
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/60 p-0 sm:items-center sm:p-4"
    >
      <div className="w-full max-w-[460px] rounded-t-3xl bg-white p-6 shadow-xl dark:border dark:border-slate-800 dark:bg-slate-900 sm:rounded-3xl">
        {mode.kind === 'synced-restored' && step.kind === 'synced-restored' && (
          <div className="space-y-4">
            <div className="text-center text-4xl" aria-hidden="true">
              ☁️
            </div>
            <h2 className="text-center text-lg font-bold text-slate-900 dark:text-slate-100">
              已從 Google 雲端還原 {mode.appliedTransactionsCount} 筆帳目 ✅
            </h2>
            <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700 dark:bg-slate-800/80 dark:text-slate-200">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">日期範圍</span>
                <span className="font-medium tabular-nums">{formatDateRange(mode.summary)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">帳戶數</span>
                <span className="font-medium tabular-nums">{mode.summary.accountCount} 個</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
            >
              開始使用
            </button>
          </div>
        )}

        {step.kind === 'loading-list' && (
          <div className="space-y-4 py-4 text-center">
            <div className="text-3xl" aria-hidden="true">
              🔍
            </div>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
              正在檢查 Google 雲端備份檔…
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              先略過
            </button>
          </div>
        )}

        {step.kind === 'auth-needed' && (
          <div className="space-y-4">
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
              需要授權讀取雲端備份
            </h2>
            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              {mode.kind === 'check-backups'
                ? '雲端同步沒有找到帳目。如果你之前曾把備份存到 Google 雲端「記帳備份」資料夾，請授權讀取備份檔。'
                : '請授權讀取 Google 雲端「記帳備份」資料夾中的備份檔。'}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-2xl border border-slate-200 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {mode.kind === 'check-backups' ? '略過，直接開始' : '取消'}
              </button>
              <button
                type="button"
                onClick={() => void loadBackupList()}
                className="flex-1 rounded-2xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
              >
                授權並檢查備份
              </button>
            </div>
          </div>
        )}

        {step.kind === 'empty' && (
          <div className="space-y-4 text-center">
            <div className="text-4xl" aria-hidden="true">
              📝
            </div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
              {mode.kind === 'check-backups'
                ? '雲端上沒有找到之前的帳目，從今天開始記吧！'
                : 'Google 雲端「記帳備份」資料夾裡目前沒有備份檔'}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
            >
              {mode.kind === 'check-backups' ? '開始使用' : '關閉'}
            </button>
          </div>
        )}

        {step.kind === 'list' && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                {mode.kind === 'check-backups'
                  ? `雲端同步沒有找到帳目，但找到 ${step.totalCount} 份備份檔`
                  : '從 Google 雲端備份還原'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                列出最近 {step.files.length} 份備份，點選一份即可預覽並還原：
              </p>
            </div>

            <div className="max-h-72 space-y-2 overflow-y-auto">
              {step.files.map((file) => {
                const sizeLabel = formatBackupFileSize(file.size);
                return (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => void handleSelectFile(file, step.totalCount, step.files)}
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-left hover:border-emerald-500 hover:bg-emerald-50/60 dark:border-slate-700 dark:bg-slate-800/70 dark:hover:border-emerald-500 dark:hover:bg-emerald-950/30"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {formatBackupFileLabel(file)}
                      </div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {file.name}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs font-medium text-slate-500 tabular-nums dark:text-slate-400">
                      {sizeLabel ?? '選擇'}
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-2xl border border-slate-200 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {mode.kind === 'check-backups' ? '略過，從今天開始記' : '取消'}
            </button>
          </div>
        )}

        {step.kind === 'downloading' && (
          <div className="space-y-3 py-6 text-center">
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
              正在下載並解析「{formatBackupFileLabel(step.file)}」…
            </div>
          </div>
        )}

        {step.kind === 'preview' && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                確認從雲端備份還原
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {formatBackupFileLabel(step.file)}（{step.file.name}）
              </p>
            </div>

            <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700 dark:bg-slate-800/80 dark:text-slate-200">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">交易筆數</span>
                <span className="font-semibold tabular-nums">
                  {step.summary.transactionCount} 筆
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">帳戶數</span>
                <span className="font-medium tabular-nums">{step.summary.accountCount} 個</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">日期範圍</span>
                <span className="font-medium tabular-nums">{formatDateRange(step.summary)}</span>
              </div>
            </div>

            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200">
              還原會將備份裡的帳目合併到這支手機（同一筆以較新的為主，不會清空現有資料）。
            </p>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  setStep({
                    kind: 'list',
                    totalCount: step.totalCount,
                    files: step.files,
                  })
                }
                className="flex-1 rounded-2xl border border-slate-200 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                返回清單
              </button>
              <button
                type="button"
                onClick={() =>
                  void handleConfirmRestore(step.file, step.payload, step.summary)
                }
                className="flex-1 rounded-2xl bg-amber-600 py-2.5 text-sm font-semibold text-white hover:bg-amber-700"
              >
                確認還原
              </button>
            </div>
          </div>
        )}

        {step.kind === 'restoring' && (
          <div className="space-y-3 py-6 text-center">
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
              正在還原帳目並同步到 Google 雲端…
            </div>
          </div>
        )}

        {step.kind === 'restored' && (
          <div className="space-y-4">
            <div className="text-center text-4xl" aria-hidden="true">
              ✅
            </div>
            <h2 className="text-center text-lg font-bold text-slate-900 dark:text-slate-100">
              已從雲端備份還原 {step.summary.transactionCount} 筆帳目
            </h2>
            <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700 dark:bg-slate-800/80 dark:text-slate-200">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">日期範圍</span>
                <span className="font-medium tabular-nums">{formatDateRange(step.summary)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">帳戶數</span>
                <span className="font-medium tabular-nums">{step.summary.accountCount} 個</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
            >
              {mode.kind === 'check-backups' ? '開始使用' : '完成'}
            </button>
          </div>
        )}

        {step.kind === 'error' && (
          <div className="space-y-4">
            <h2 className="text-base font-bold text-red-700 dark:text-red-300">
              無法讀取雲端備份
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">{step.message}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-2xl border border-slate-200 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                關閉
              </button>
              <button
                type="button"
                onClick={() => void loadBackupList()}
                className="flex-1 rounded-2xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                重試
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
