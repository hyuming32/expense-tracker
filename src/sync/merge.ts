import type { BaseRecord } from '../db/types';

/**
 * 合併單筆本機與遠端紀錄：
 * 同 id 取 updatedAt 較大者；若相同則取 deviceId 字串較大者，確保每台裝置結果一致。
 */
export function mergeRecord<T extends BaseRecord>(local: T | undefined, remote: T): T {
  if (!local) {
    return remote;
  }
  if (remote.updatedAt > local.updatedAt) {
    return remote;
  }
  if (remote.updatedAt < local.updatedAt) {
    return local;
  }
  return remote.deviceId > local.deviceId ? remote : local;
}
