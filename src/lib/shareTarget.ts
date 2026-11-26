export const SHARE_CACHE_NAME = 'expense-tracker-share-target-v1';
export const SHARE_CACHE_KEY = '/shared-lottery-image';

/**
 * 偵測目前瀏覽器是否為不支援 Web Share Target（檔案分享接收）的平台（例如 iOS Safari）。
 */
export function isShareTargetUnsupported(): boolean {
  if (typeof navigator === 'undefined') {
    return true;
  }
  const ua = navigator.userAgent || '';
  const isIos =
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIos) {
    return true;
  }
  return !('serviceWorker' in navigator) || typeof caches === 'undefined';
}

/**
 * 從 Service Worker 暫存的 Cache 讀取並刪除分享進來的截圖檔案。
 */
export async function consumeSharedLotteryImage(): Promise<File | null> {
  if (typeof caches === 'undefined') {
    return null;
  }
  try {
    const cache = await caches.open(SHARE_CACHE_NAME);
    const response = await cache.match(SHARE_CACHE_KEY);
    if (!response) {
      return null;
    }
    await cache.delete(SHARE_CACHE_KEY);
    const blob = await response.blob();
    if (blob.size === 0) {
      return null;
    }
    const rawName = response.headers.get('X-Shared-Filename');
    const fileName = rawName ? decodeURIComponent(rawName) : 'shared-lottery.png';
    return new File([blob], fileName, { type: blob.type || 'image/png' });
  } catch {
    return null;
  }
}
