import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpenseDatabase } from '../db/database';
import { getSyncSchedule, setSyncSchedule, type SyncSchedule } from '../db/repository';
import { DriveApiError } from './driveStore';
import { toFriendlySyncError } from './syncManager';
import {
  createSyncScheduler,
  DAILY_INTERVAL_MS,
  PERIODIC_CHECK_INTERVAL_MS,
  RESUME_SYNC_THRESHOLD_MS,
  WEEKLY_INTERVAL_MS,
} from './syncScheduler';

describe('createSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setupScheduler(options?: {
    schedule?: SyncSchedule;
    outboxCount?: number;
    initialLastSyncAt?: number | null;
    initialVisible?: boolean;
    runSyncImpl?: () => Promise<boolean>;
  }) {
    let schedule: SyncSchedule = options?.schedule ?? 'daily';
    let outboxCount = options?.outboxCount ?? 0;
    let lastSyncAt: number | null = options?.initialLastSyncAt ?? null;
    let visible = options?.initialVisible ?? true;
    let syncCount = 0;

    const runSync = vi.fn(async () => {
      syncCount += 1;
      if (options?.runSyncImpl) {
        const ok = await options.runSyncImpl();
        if (ok) {
          lastSyncAt = Date.now();
        }
        return ok;
      }
      lastSyncAt = Date.now();
      return true;
    });

    const scheduler = createSyncScheduler({
      now: () => Date.now(),
      getSchedule: () => schedule,
      getOutboxCount: () => outboxCount,
      getLastSyncAt: () => lastSyncAt,
      isVisible: () => visible,
      runSync,
    });

    return {
      scheduler,
      runSync,
      getSyncCount: () => syncCount,
      setScheduleValue: (next: SyncSchedule) => {
        schedule = next;
      },
      setOutboxCountValue: (next: number) => {
        outboxCount = next;
      },
      setVisibleValue: (next: boolean) => {
        visible = next;
      },
    };
  }

  it('開啟時同步一次', async () => {
    const { scheduler, runSync } = setupScheduler();
    const ok = await scheduler.start();

    expect(ok).toBe(true);
    expect(runSync).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('10 分鐘內回前景不同步、超過 10 分鐘才同步', async () => {
    const { scheduler, runSync } = setupScheduler();
    await scheduler.start();
    expect(runSync).toHaveBeenCalledTimes(1);

    await scheduler.onVisibilityChange(false);
    vi.advanceTimersByTime(RESUME_SYNC_THRESHOLD_MS);
    await scheduler.onVisibilityChange(true);
    expect(runSync).toHaveBeenCalledTimes(1);

    await scheduler.onVisibilityChange(false);
    vi.advanceTimersByTime(RESUME_SYNC_THRESHOLD_MS + 1);
    await scheduler.onVisibilityChange(true);
    expect(runSync).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('離開時 outbox 非空才同步（visibilitychange hidden 與 pagehide）', async () => {
    const { scheduler, runSync, setOutboxCountValue } = setupScheduler({ outboxCount: 0 });
    await scheduler.start();
    expect(runSync).toHaveBeenCalledTimes(1);

    // outbox 為空，離開不同步
    await scheduler.onVisibilityChange(false);
    expect(runSync).toHaveBeenCalledTimes(1);

    // outbox 非空，離開時同步
    setOutboxCountValue(3);
    await scheduler.onVisibilityChange(false);
    expect(runSync).toHaveBeenCalledTimes(2);

    // pagehide 時 outbox 為空不同步，非空才同步
    setOutboxCountValue(0);
    await scheduler.onPageHide();
    expect(runSync).toHaveBeenCalledTimes(2);

    setOutboxCountValue(1);
    await scheduler.onPageHide();
    expect(runSync).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it('寫入導致 outbox 增加時不會自動同步', async () => {
    const { scheduler, runSync, setOutboxCountValue } = setupScheduler({ outboxCount: 0 });
    await scheduler.start();
    expect(runSync).toHaveBeenCalledTimes(1);

    setOutboxCountValue(5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(runSync).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('daily 在 24 小時後觸發、weekly 7 天觸發、none 不觸發', async () => {
    // daily
    const daily = setupScheduler({ schedule: 'daily' });
    await daily.scheduler.start();
    expect(daily.runSync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DAILY_INTERVAL_MS - PERIODIC_CHECK_INTERVAL_MS);
    expect(daily.runSync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PERIODIC_CHECK_INTERVAL_MS);
    expect(daily.runSync).toHaveBeenCalledTimes(2);
    daily.scheduler.stop();

    // weekly
    const weekly = setupScheduler({ schedule: 'weekly' });
    await weekly.scheduler.start();
    expect(weekly.runSync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WEEKLY_INTERVAL_MS - PERIODIC_CHECK_INTERVAL_MS);
    expect(weekly.runSync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PERIODIC_CHECK_INTERVAL_MS);
    expect(weekly.runSync).toHaveBeenCalledTimes(2);
    weekly.scheduler.stop();

    // none
    const none = setupScheduler({ schedule: 'none' });
    await none.scheduler.start();
    expect(none.runSync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WEEKLY_INTERVAL_MS * 2);
    expect(none.runSync).toHaveBeenCalledTimes(1);
    none.scheduler.stop();
  });

  it('App 在背景時不執行定時檢查', async () => {
    const getScheduleSpy = vi.fn<() => SyncSchedule>(() => 'daily');
    let lastSyncAt: number | null = null;
    const runSync = vi.fn(async () => {
      lastSyncAt = Date.now();
      return true;
    });

    const scheduler = createSyncScheduler({
      now: () => Date.now(),
      getSchedule: getScheduleSpy,
      getOutboxCount: () => 0,
      getLastSyncAt: () => lastSyncAt,
      runSync,
    });

    await scheduler.start();
    expect(runSync).toHaveBeenCalledTimes(1);
    getScheduleSpy.mockClear();

    await scheduler.onVisibilityChange(false);
    await vi.advanceTimersByTimeAsync(DAILY_INTERVAL_MS * 2);

    expect(getScheduleSpy).not.toHaveBeenCalled();
    expect(runSync).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('同時只有一個同步在執行（單飛防重入）', async () => {
    let resolveSync!: (value: boolean) => void;
    const runSync = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSync = resolve;
        }),
    );

    const scheduler = createSyncScheduler({
      now: () => Date.now(),
      getSchedule: () => 'daily',
      getOutboxCount: () => 2,
      getLastSyncAt: () => null,
      runSync,
    });

    const p1 = scheduler.triggerManual();
    const p2 = scheduler.triggerManual();
    const p3 = scheduler.onVisibilityChange(false);

    expect(runSync).toHaveBeenCalledTimes(1);
    resolveSync(true);
    await Promise.all([p1, p2, p3]);
    expect(runSync).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('手動同步隨時可用，即使排程為 none 或剛失敗過', async () => {
    let shouldFail = true;
    const { scheduler, runSync } = setupScheduler({
      schedule: 'none',
      runSyncImpl: async () => !shouldFail,
    });

    const firstOk = await scheduler.start();
    expect(firstOk).toBe(false);
    expect(runSync).toHaveBeenCalledTimes(1);

    shouldFail = false;
    const manualOk = await scheduler.triggerManual();
    expect(manualOk).toBe(true);
    expect(runSync).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('失敗後不自動重試；恢復網路（online）且 outbox 非空時最多補一次', async () => {
    let shouldFail = true;
    const { scheduler, runSync, setOutboxCountValue } = setupScheduler({
      schedule: 'daily',
      outboxCount: 2,
      runSyncImpl: async () => !shouldFail,
    });

    await scheduler.start();
    expect(runSync).toHaveBeenCalledTimes(1);

    // 失敗後經過 24 小時也不會定時重試
    await vi.advanceTimersByTimeAsync(DAILY_INTERVAL_MS + PERIODIC_CHECK_INTERVAL_MS);
    expect(runSync).toHaveBeenCalledTimes(1);

    // 恢復網路時重試一次，但若仍失敗，再次觸發 online 也不會再重試
    await scheduler.onOnline();
    expect(runSync).toHaveBeenCalledTimes(2);

    shouldFail = false;
    await scheduler.onOnline();
    expect(runSync).toHaveBeenCalledTimes(2);

    // 手動重試成功後，之後沒有失敗待補，online 不會多餘同步
    await scheduler.triggerManual();
    expect(runSync).toHaveBeenCalledTimes(3);
    setOutboxCountValue(1);
    await scheduler.onOnline();
    expect(runSync).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });
});

describe('sync.schedule 本機設定', () => {
  it('預設為 daily，可儲存與讀取 weekly / none', async () => {
    const db = new ExpenseDatabase(`test-sync-schedule-${Date.now()}`);
    expect(await getSyncSchedule(db)).toBe('daily');

    await setSyncSchedule('weekly', db);
    expect(await getSyncSchedule(db)).toBe('weekly');

    await setSyncSchedule('none', db);
    expect(await getSyncSchedule(db)).toBe('none');

    await db.delete();
  });
});

describe('toFriendlySyncError', () => {
  it('正確轉換網路錯誤、DriveApiError 403/429/5xx 與未知錯誤', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(toFriendlySyncError(new TypeError('Failed to fetch'))).toBe('網路連線失敗');
    expect(toFriendlySyncError(new Error('NetworkError when attempting to fetch'))).toBe(
      '網路連線失敗',
    );
    expect(toFriendlySyncError(new DriveApiError('Forbidden', 403))).toBe(
      'Google Drive 拒絕存取',
    );
    expect(toFriendlySyncError(new DriveApiError('Rate Limit', 429))).toBe(
      'Google 伺服器暫時忙碌，請稍後重試',
    );
    expect(toFriendlySyncError(new DriveApiError('Service Unavailable', 503))).toBe(
      'Google 伺服器暫時忙碌，請稍後重試',
    );
    expect(toFriendlySyncError(new Error('raw internal token detail'))).toBe('未知錯誤');
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });
});
