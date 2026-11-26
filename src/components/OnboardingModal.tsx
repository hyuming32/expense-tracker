import { useRef, useState } from 'react';
import type { InstallPlatform } from '../domain/onboarding';
import { type BeforeInstallPromptEvent, InstallGuideContent } from './InstallGuideContent';

interface OnboardingModalProps {
  open: boolean;
  platform: InstallPlatform;
  deferredPrompt: BeforeInstallPromptEvent | null;
  onTriggerInstall?: () => Promise<void> | void;
  onEnableSync: () => Promise<void> | void;
  onComplete: () => void;
}

const TOTAL_STEPS = 3;

/**
 * 初次使用 3 步新手導覽，支援左右滑動、略過與「重看新手導覽」。
 */
export function OnboardingModal({
  open,
  platform,
  deferredPrompt,
  onTriggerInstall,
  onEnableSync,
  onComplete,
}: OnboardingModalProps) {
  const [step, setStep] = useState(0);
  const [syncBusy, setSyncBusy] = useState(false);
  const touchStartXRef = useRef<number | null>(null);

  if (!open) {
    return null;
  }

  function handleNext() {
    if (step < TOTAL_STEPS - 1) {
      setStep((prev) => prev + 1);
    } else {
      setStep(0);
      onComplete();
    }
  }

  function handleSkip() {
    setStep(0);
    onComplete();
  }

  async function handleEnableSyncClick() {
    if (syncBusy) {
      return;
    }
    setSyncBusy(true);
    try {
      await onEnableSync();
    } catch {
      // 登入取消或設定未完整時仍可繼續下一步導覽
    } finally {
      setSyncBusy(false);
      setStep(2);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="新手導覽"
      className="fixed inset-0 z-50 flex flex-col justify-between bg-white px-6 py-8 dark:bg-slate-950"
      onTouchStart={(e) => {
        touchStartXRef.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const startX = touchStartXRef.current;
        const endX = e.changedTouches[0]?.clientX;
        touchStartXRef.current = null;
        if (startX === null || endX === undefined) {
          return;
        }
        const deltaX = endX - startX;
        if (deltaX < -40 && step < TOTAL_STEPS - 1) {
          setStep((prev) => prev + 1);
        } else if (deltaX > 40 && step > 0) {
          setStep((prev) => prev - 1);
        }
      }}
    >
      {/* 頂部略過按鈕 */}
      <div className="mx-auto flex w-full max-w-[480px] items-center justify-end">
        <button
          type="button"
          onClick={handleSkip}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          略過
        </button>
      </div>

      {/* 主內容區 */}
      <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col items-center justify-center text-center">
        {step === 0 && (
          <div className="space-y-4">
            <div className="text-6xl" aria-hidden="true">
              ⚡
            </div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">3 秒記一筆</h1>
            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              按右下角 ＋，輸入金額選分類就好；也可以在首頁打一句話「午餐 牛肉麵 180」。
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="w-full space-y-4">
            <div className="text-6xl" aria-hidden="true">
              🔐
            </div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
              資料存在你自己的手機和 Google 雲端
            </h1>
            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              我們沒有伺服器，看不到你的帳。
            </p>
            <div className="pt-2">
              <button
                type="button"
                disabled={syncBusy}
                onClick={() => void handleEnableSyncClick()}
                className="w-full rounded-xl border border-emerald-600 px-4 py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-500 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
              >
                {syncBusy ? '開啟中…' : '現在開啟 Google 同步'}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="w-full space-y-4">
            <div className="text-6xl" aria-hidden="true">
              📲
            </div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
              加到主畫面，用起來像 App
            </h1>
            <div className="text-left">
              <InstallGuideContent
                platform={platform}
                deferredPrompt={deferredPrompt}
                onTriggerInstall={onTriggerInstall}
              />
            </div>
          </div>
        )}
      </div>

      {/* 底部指示點與下一步按鈕 */}
      <div className="mx-auto w-full max-w-[480px] space-y-5">
        <div className="flex items-center justify-center gap-2" aria-label={`第 ${step + 1} 頁，共 ${TOTAL_STEPS} 頁`}>
          {Array.from({ length: TOTAL_STEPS }).map((_, index) => (
            <button
              key={index}
              type="button"
              aria-label={`跳至第 ${index + 1} 頁`}
              onClick={() => setStep(index)}
              className={`h-2 rounded-full transition-all ${
                step === index
                  ? 'w-6 bg-emerald-600 dark:bg-emerald-500'
                  : 'w-2 bg-slate-300 dark:bg-slate-700'
              }`}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={handleNext}
          className="w-full rounded-2xl bg-emerald-600 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
        >
          {step === TOTAL_STEPS - 1 ? '開始記帳' : '下一步'}
        </button>
      </div>
    </div>
  );
}
