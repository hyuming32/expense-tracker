import type { SyncSchedule } from '../db/repository';

export const RESUME_SYNC_THRESHOLD_MS = 10 * 60 * 1000;
export const PERIODIC_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SyncSchedulerDeps<TTimer = ReturnType<typeof setTimeout>> {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TTimer;
  clearTimer?: (id: TTimer) => void;
  getSchedule: () => SyncSchedule | Promise<SyncSchedule>;
  getOutboxCount: () => number | Promise<number>;
  getLastSyncAt: () => number | null | Promise<number | null>;
  runSync: () => Promise<boolean>;
  isVisible?: () => boolean;
}

export interface SyncScheduler {
  start: () => Promise<boolean>;
  stop: () => void;
  onVisibilityChange: (visible: boolean) => Promise<boolean>;
  onPageHide: () => Promise<boolean>;
  onOnline: () => Promise<boolean>;
  triggerManual: () => Promise<boolean>;
}

/**
 * 建立純邏輯同步排程器：支援啟動同步、前景恢復節流、離開補傳、定時檢查與單飛防重入。
 */
export function createSyncScheduler<TTimer = ReturnType<typeof setTimeout>>(
  deps: SyncSchedulerDeps<TTimer>,
): SyncScheduler {
  const now = deps.now ?? (() => Date.now());
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms) as unknown as TTimer);
  const clearTimer =
    deps.clearTimer ??
    ((id: TTimer) => {
      globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    });
  const isVisible = deps.isVisible ?? (() => true);

  let started = false;
  let visible = isVisible();
  let timerId: TTimer | null = null;
  let inFlight: Promise<boolean> | null = null;
  let lastSyncFailed = false;
  let onlineRetryPending = false;

  function clearScheduledTimer(): void {
    if (timerId !== null) {
      clearTimer(timerId);
      timerId = null;
    }
  }

  function executeOnce(options?: { fromOnline?: boolean }): Promise<boolean> {
    if (inFlight !== null) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const ok = await deps.runSync();
        lastSyncFailed = !ok;
        onlineRetryPending = ok ? false : !options?.fromOnline;
        return ok;
      } catch {
        lastSyncFailed = true;
        onlineRetryPending = !options?.fromOnline;
        return false;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  async function checkPeriodic(): Promise<boolean> {
    if (!started || !visible || lastSyncFailed) {
      return false;
    }

    const schedule = await deps.getSchedule();
    if (schedule === 'none') {
      return false;
    }

    const intervalMs = schedule === 'weekly' ? WEEKLY_INTERVAL_MS : DAILY_INTERVAL_MS;
    const lastSyncAt = await deps.getLastSyncAt();
    if (lastSyncAt === null || now() - lastSyncAt >= intervalMs) {
      return executeOnce();
    }
    return false;
  }

  function scheduleNextCheck(): void {
    clearScheduledTimer();
    if (!started || !visible) {
      return;
    }
    timerId = setTimer(() => {
      timerId = null;
      void checkPeriodic().finally(() => {
        if (started && visible && timerId === null) {
          scheduleNextCheck();
        }
      });
    }, PERIODIC_CHECK_INTERVAL_MS);
  }

  async function onLeave(): Promise<boolean> {
    const outboxCount = await deps.getOutboxCount();
    if (outboxCount > 0) {
      return executeOnce();
    }
    return false;
  }

  return {
    async start(): Promise<boolean> {
      started = true;
      visible = isVisible();
      if (visible) {
        scheduleNextCheck();
      }
      return executeOnce();
    },

    stop(): void {
      started = false;
      clearScheduledTimer();
    },

    async onVisibilityChange(nextVisible: boolean): Promise<boolean> {
      visible = nextVisible;
      if (!nextVisible) {
        clearScheduledTimer();
        return onLeave();
      }

      if (started) {
        scheduleNextCheck();
      }
      const lastSyncAt = await deps.getLastSyncAt();
      if (lastSyncAt === null || now() - lastSyncAt > RESUME_SYNC_THRESHOLD_MS) {
        return executeOnce();
      }
      return false;
    },

    async onPageHide(): Promise<boolean> {
      visible = false;
      clearScheduledTimer();
      return onLeave();
    },

    async onOnline(): Promise<boolean> {
      if (!onlineRetryPending) {
        return false;
      }
      const outboxCount = await deps.getOutboxCount();
      if (outboxCount <= 0) {
        return false;
      }
      onlineRetryPending = false;
      return executeOnce({ fromOnline: true });
    },

    async triggerManual(): Promise<boolean> {
      return executeOnce();
    },
  };
}
