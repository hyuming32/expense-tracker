/**
 * 產生符合 RFC 9562 的 UUID v7 字串（前 48 位元為毫秒時間戳，其餘為隨機位元）。
 */
export function uuidv7(): string {
  const timestamp = Date.now();
  const bytes = new Uint8Array(16);

  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // 寫入 48 位元毫秒時間戳（大端序）
  const timeHigh = Math.floor(timestamp / 0x10000);
  const timeLow = timestamp & 0xffff;
  bytes[0] = (timeHigh >>> 24) & 0xff;
  bytes[1] = (timeHigh >>> 16) & 0xff;
  bytes[2] = (timeHigh >>> 8) & 0xff;
  bytes[3] = timeHigh & 0xff;
  bytes[4] = (timeLow >>> 8) & 0xff;
  bytes[5] = timeLow & 0xff;

  // 設定版本為 7 (0111xxxx) 與變體為 RFC 4122/9562 (10xxxxxx)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
