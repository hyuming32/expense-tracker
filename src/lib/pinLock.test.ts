import { describe, expect, it } from 'vitest';
import {
  hashPin,
  INITIAL_PIN_ATTEMPT_STATE,
  isPinLockedOut,
  PIN_BACKGROUND_LOCK_THRESHOLD_MS,
  PIN_LOCKOUT_DURATION_MS,
  recordPinFailure,
  shouldLockOnResume,
  verifyPin,
} from './pinLock';

describe('pinLock', () => {
  it('正確 PIN 驗證通過、錯誤 PIN 驗證失敗，且不存明碼', async () => {
    const record = await hashPin('1357');
    expect(record.iterations).toBe(100_000);
    expect(record.salt.length).toBe(32); // 16 bytes hex
    expect(record.hash).not.toContain('1357');
    expect(JSON.stringify(record)).not.toContain('1357');

    expect(await verifyPin('1357', record)).toBe(true);
    expect(await verifyPin('2468', record)).toBe(false);
    expect(await verifyPin('135', record)).toBe(false);
  });

  it('相同 PIN 使用不同 salt 會產生不同雜湊', async () => {
    const r1 = await hashPin('0000');
    const r2 = await hashPin('0000');
    expect(r1.salt).not.toBe(r2.salt);
    expect(r1.hash).not.toBe(r2.hash);
    expect(await verifyPin('0000', r1)).toBe(true);
    expect(await verifyPin('0000', r2)).toBe(true);
  });

  it('錯誤次數達 5 次後鎖定 30 秒，時間到後可再試', () => {
    let state = INITIAL_PIN_ATTEMPT_STATE;
    const baseTime = 1_000_000;

    for (let i = 0; i < 4; i += 1) {
      state = recordPinFailure(state, baseTime + i * 100);
      expect(isPinLockedOut(state, baseTime + i * 100).locked).toBe(false);
    }

    // 第 5 次錯誤觸發 30 秒冷卻鎖定
    const fifthAt = baseTime + 500;
    state = recordPinFailure(state, fifthAt);
    const duringLock = isPinLockedOut(state, fifthAt + 10_000);
    expect(duringLock.locked).toBe(true);
    expect(duringLock.remainingSeconds).toBe(20);

    // 30 秒後解除鎖定
    const afterLock = isPinLockedOut(state, fifthAt + PIN_LOCKOUT_DURATION_MS);
    expect(afterLock.locked).toBe(false);
    expect(afterLock.remainingSeconds).toBe(0);
  });

  it('上鎖時機判斷：背景 59 秒不鎖、61 秒鎖', () => {
    const hiddenAt = 500_000;
    expect(shouldLockOnResume(null, hiddenAt + 100_000)).toBe(false);
    expect(
      shouldLockOnResume(hiddenAt, hiddenAt + 59_000, PIN_BACKGROUND_LOCK_THRESHOLD_MS),
    ).toBe(false);
    expect(
      shouldLockOnResume(hiddenAt, hiddenAt + 61_000, PIN_BACKGROUND_LOCK_THRESHOLD_MS),
    ).toBe(true);
  });
});
