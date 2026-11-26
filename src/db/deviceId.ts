import { uuidv7 } from './uuid';

const DEVICE_ID_STORAGE_KEY = 'expense_tracker_device_id';
let memoryDeviceId: string | null = null;

/**
 * 取得或建立本機裝置識別碼，優先儲存於 localStorage。
 */
export function getDeviceId(): string {
  if (typeof globalThis.localStorage !== 'undefined') {
    const existing = globalThis.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing) {
      return existing;
    }
    const created = uuidv7();
    globalThis.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  }

  if (!memoryDeviceId) {
    memoryDeviceId = uuidv7();
  }
  return memoryDeviceId;
}
