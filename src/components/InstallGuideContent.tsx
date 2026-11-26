import { useState } from 'react';
import type { InstallPlatform } from '../domain/onboarding';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const APP_SHARE_URL = 'https://money.fun2young.com';

interface InstallGuideContentProps {
  platform: InstallPlatform;
  deferredPrompt: BeforeInstallPromptEvent | null;
  onTriggerInstall?: () => Promise<void> | void;
}

/**
 * 依手機／桌面平台顯示「加到主畫面」的操作引導，供新手導覽與首頁引導面板共用。
 */
export function InstallGuideContent({
  platform,
  deferredPrompt,
  onTriggerInstall,
}: InstallGuideContentProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopyUrl() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(APP_SHARE_URL);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = APP_SHARE_URL;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 忽略剪貼簿權限錯誤
    }
  }

  if (platform === 'ios-safari') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
        點下方分享按鈕 <span aria-hidden="true">⬆️</span> →「加入主畫面」→ 新增
      </div>
    );
  }

  if (platform === 'ios-other') {
    return (
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
        <p>請先用 Safari 打開 money.fun2young.com，再加入主畫面</p>
        <button
          type="button"
          onClick={() => void handleCopyUrl()}
          className="w-full rounded-xl border border-emerald-600 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
        >
          {copied ? '已複製網址！' : '複製網址'}
        </button>
      </div>
    );
  }

  if (platform === 'android-inapp') {
    return (
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
        <p>點右上角 ⋮ →「用 Chrome 開啟」，再安裝</p>
        <button
          type="button"
          onClick={() => void handleCopyUrl()}
          className="w-full rounded-xl border border-emerald-600 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
        >
          {copied ? '已複製網址！' : '複製網址'}
        </button>
      </div>
    );
  }

  if (platform === 'android-chrome' || platform === 'desktop-chromium') {
    if (deferredPrompt && onTriggerInstall) {
      return (
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
          <p>一鍵安裝到主畫面，打開就像原生 App 一樣快。</p>
          <button
            type="button"
            onClick={() => void onTriggerInstall()}
            className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
          >
            安裝 App
          </button>
        </div>
      );
    }
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
        點右上角 ⋮ →「加到主畫面」或「安裝應用程式」
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
      使用瀏覽器選單的「加入主畫面」或「安裝應用程式」，即可從桌面快速開啟記帳。
    </div>
  );
}

interface InstallGuideSheetProps {
  open: boolean;
  platform: InstallPlatform;
  deferredPrompt: BeforeInstallPromptEvent | null;
  onTriggerInstall?: () => Promise<void> | void;
  onClose: () => void;
}

/**
 * 從首頁小卡開啟的「加到主畫面」引導底部面板。
 */
export function InstallGuideSheet({
  open,
  platform,
  deferredPrompt,
  onTriggerInstall,
  onClose,
}: InstallGuideSheetProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="加到主畫面引導"
        className="w-full max-w-[520px] rounded-t-3xl bg-white p-6 shadow-xl dark:bg-slate-900 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl" aria-hidden="true">
              📲
            </span>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
              加到主畫面，記帳更快
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉引導"
            className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            ✕
          </button>
        </div>

        <InstallGuideContent
          platform={platform}
          deferredPrompt={deferredPrompt}
          onTriggerInstall={onTriggerInstall}
        />

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-xl border border-slate-200 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          知道了
        </button>
      </div>
    </div>
  );
}
