import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

interface PwaUpdatePromptProps {
  /** 畫面上方／底部已有其他提示條時避開重疊 */
  hasBottomToast?: boolean;
}

/**
 * 隔離 virtual:pwa-register/react 的更新提示元件，避免測試環境直接匯入虛擬模組。
 */
export function PwaUpdatePrompt({ hasBottomToast = false }: PwaUpdatePromptProps) {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const intervalRef = useRef<number | null>(null);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) {
        return;
      }
      registrationRef.current = registration;
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
      }
      intervalRef.current = window.setInterval(() => {
        void registration.update();
      }, UPDATE_CHECK_INTERVAL_MS);
    },
  });

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && registrationRef.current) {
        void registrationRef.current.update();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  if (!needRefresh) {
    return null;
  }

  return (
    <div
      role="status"
      className={`fixed left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-[688px] -translate-x-1/2 items-center justify-between gap-3 rounded-xl border border-emerald-700/40 bg-slate-900 px-3.5 py-2.5 text-xs text-white shadow-lg transition-all dark:border-emerald-500/40 dark:bg-slate-800 ${
        hasBottomToast ? 'bottom-36' : 'bottom-20'
      }`}
    >
      <span className="font-medium">有新版本可以用了</span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void updateServiceWorker(true)}
          className="rounded-lg bg-emerald-500 px-2.5 py-1 font-semibold text-slate-950 hover:bg-emerald-400"
        >
          立即更新
        </button>
        <button
          type="button"
          onClick={() => setNeedRefresh(false)}
          className="rounded-lg px-2 py-1 text-slate-300 hover:bg-slate-700"
        >
          稍後
        </button>
      </div>
    </div>
  );
}
