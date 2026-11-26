import { useCallback, useEffect, useState } from 'react';
import { clearPinRecord } from '../db/repository';
import {
  INITIAL_PIN_ATTEMPT_STATE,
  isPinLockedOut,
  PIN_LENGTH,
  type PinAttemptState,
  type PinRecord,
  recordPinFailure,
  verifyPin,
} from '../lib/pinLock';
import { isSyncEnabled, signInWithGoogle } from '../sync/auth';

interface PinLockScreenProps {
  pinRecord: PinRecord;
  onUnlock: () => void;
}

const KEYPAD_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
] as const;

/**
 * 全螢幕 4 位數密碼鎖定畫面，遮蓋底下所有內容。
 */
export function PinLockScreen({ pinRecord, onUnlock }: PinLockScreenProps) {
  const [pin, setPin] = useState('');
  const [attemptState, setAttemptState] = useState<PinAttemptState>(INITIAL_PIN_ATTEMPT_STATE);
  const [now, setNow] = useState(() => Date.now());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const lockout = isPinLockedOut(attemptState, now);
  const syncEnabled = isSyncEnabled();
  const iconSrc = `${import.meta.env.BASE_URL}icon-192.png`;

  useEffect(() => {
    if (!lockout.locked) {
      return;
    }
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => window.clearInterval(timer);
  }, [lockout.locked]);

  const submitPin = useCallback(
    async (candidate: string) => {
      const currentNow = Date.now();
      setNow(currentNow);
      const currentLockout = isPinLockedOut(attemptState, currentNow);
      if (currentLockout.locked) {
        setPin('');
        return;
      }

      setVerifying(true);
      try {
        const ok = await verifyPin(candidate, pinRecord);
        if (ok) {
          setAttemptState(INITIAL_PIN_ATTEMPT_STATE);
          setPin('');
          setErrorMessage(null);
          onUnlock();
        } else {
          const nextState = recordPinFailure(attemptState, Date.now());
          setAttemptState(nextState);
          setPin('');
          const nextLockout = isPinLockedOut(nextState, Date.now());
          if (nextLockout.locked) {
            setErrorMessage(null);
          } else {
            setErrorMessage('密碼錯誤，請再試一次');
          }
        }
      } finally {
        setVerifying(false);
      }
    },
    [attemptState, onUnlock, pinRecord],
  );

  const handleDigit = useCallback(
    (digit: string) => {
      if (verifying || showForgot) {
        return;
      }
      const currentNow = Date.now();
      setNow(currentNow);
      if (isPinLockedOut(attemptState, currentNow).locked) {
        return;
      }
      if (pin.length >= PIN_LENGTH) {
        return;
      }
      const next = `${pin}${digit}`;
      setPin(next);
      setErrorMessage(null);
      if (next.length === PIN_LENGTH) {
        void submitPin(next);
      }
    },
    [attemptState, pin, showForgot, submitPin, verifying],
  );

  const handleBackspace = useCallback(() => {
    if (verifying || showForgot) {
      return;
    }
    setPin((prev) => prev.slice(0, -1));
  }, [showForgot, verifying]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleBackspace, handleDigit]);

  async function handleGoogleUnlock() {
    setGoogleBusy(true);
    setGoogleError(null);
    try {
      const token = await signInWithGoogle();
      if (token) {
        await clearPinRecord();
        onUnlock();
      }
    } catch (err) {
      setGoogleError(err instanceof Error ? err.message : 'Google 驗證失敗，無法解鎖');
    } finally {
      setGoogleBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="密碼鎖定畫面"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-50 px-6 py-8 text-slate-900 dark:bg-slate-950 dark:text-slate-100"
    >
      <div className="flex w-full max-w-xs flex-col items-center">
        <img
          src={iconSrc}
          alt="記帳本圖示"
          className="mb-4 h-16 w-16 rounded-2xl border border-slate-200 bg-white object-cover shadow-sm dark:border-slate-800"
        />
        <h1 className="text-lg font-bold">輸入密碼解鎖</h1>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">請輸入 4 位數密碼</p>

        {/* 4 個密碼圓點 */}
        <div className="my-6 flex items-center gap-4" aria-label={`已輸入 ${pin.length} 碼`}>
          {Array.from({ length: PIN_LENGTH }, (_, idx) => {
            const filled = idx < pin.length;
            return (
              <span
                key={idx}
                className={`h-3.5 w-3.5 rounded-full border-2 transition-colors ${
                  filled
                    ? 'border-emerald-600 bg-emerald-600 dark:border-emerald-400 dark:bg-emerald-400'
                    : 'border-slate-300 bg-transparent dark:border-slate-600'
                }`}
              />
            );
          })}
        </div>

        {/* 錯誤或冷卻提示 */}
        <div className="mb-4 min-h-[20px] text-center text-xs font-medium">
          {lockout.locked ? (
            <span className="text-red-600 dark:text-red-400">
              錯誤次數過多，請等 {lockout.remainingSeconds} 秒後再試
            </span>
          ) : errorMessage ? (
            <span className="text-red-600 dark:text-red-400">{errorMessage}</span>
          ) : null}
        </div>

        {!showForgot ? (
          <>
            {/* 數字鍵盤 */}
            <div className="grid w-full max-w-[260px] grid-cols-3 gap-3">
              {KEYPAD_ROWS.flat().map((digit) => (
                <button
                  key={digit}
                  type="button"
                  disabled={lockout.locked || verifying}
                  onClick={() => handleDigit(digit)}
                  className="flex h-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-xl font-semibold text-slate-900 shadow-sm transition-colors hover:bg-slate-100 active:scale-95 disabled:opacity-40 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                >
                  {digit}
                </button>
              ))}
              <div />
              <button
                type="button"
                disabled={lockout.locked || verifying}
                onClick={() => handleDigit('0')}
                className="flex h-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-xl font-semibold text-slate-900 shadow-sm transition-colors hover:bg-slate-100 active:scale-95 disabled:opacity-40 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
              >
                0
              </button>
              <button
                type="button"
                disabled={verifying || pin.length === 0}
                onClick={handleBackspace}
                aria-label="退格"
                className="flex h-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-lg font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-100 active:scale-95 disabled:opacity-40 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                ⌫
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                setShowForgot(true);
                setGoogleError(null);
              }}
              className="mt-6 text-xs font-medium text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
            >
              忘記密碼？
            </button>
          </>
        ) : (
          <div className="w-full space-y-3 rounded-2xl border border-slate-200 bg-white p-4 text-xs shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">忘記密碼？</h2>
            <p className="leading-relaxed text-slate-600 dark:text-slate-300">
              密碼只存在這台裝置。若你有開 Google
              雲端同步，可以清除這個網站的瀏覽器資料後重新登入 Google
              取回帳目；若沒有同步，清除後資料無法找回。
            </p>
            {googleError && (
              <div className="rounded-lg bg-red-50 p-2 text-red-600 dark:bg-red-950/50 dark:text-red-300">
                {googleError}
              </div>
            )}
            <div className="flex flex-col gap-2 pt-1">
              {syncEnabled && (
                <button
                  type="button"
                  disabled={googleBusy}
                  onClick={() => void handleGoogleUnlock()}
                  className="w-full rounded-xl bg-emerald-600 px-3 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {googleBusy ? '驗證中…' : '已同步，用 Google 重新登入解鎖'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowForgot(false)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                返回輸入密碼
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
