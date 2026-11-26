/**
 * 查詢目前瀏覽器是否已開啟永久保存（StorageManager.persisted）。
 * 若瀏覽器不支援則回傳 null，不拋出錯誤。
 */
export async function getStoragePersistedStatus(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) {
    return null;
  }
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

/**
 * 嘗試向瀏覽器申請永久保存（StorageManager.persist）。
 * 若已為 true 就不再重複呼叫；不支援時安靜略過並回傳 null。
 */
export async function requestStoragePersistence(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return null;
  }
  try {
    if (typeof navigator.storage.persisted === 'function') {
      const alreadyPersisted = await navigator.storage.persisted();
      if (alreadyPersisted) {
        return true;
      }
    }
    if (typeof navigator.storage.persist === 'function') {
      return await navigator.storage.persist();
    }
    return null;
  } catch {
    return null;
  }
}
