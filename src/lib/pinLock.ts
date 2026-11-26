export const PIN_LENGTH = 4;
export const PIN_PBKDF2_ITERATIONS = 100_000;
export const PIN_SALT_BYTES = 16;
export const PIN_MAX_FAILED_ATTEMPTS = 5;
export const PIN_LOCKOUT_DURATION_MS = 30_000;
export const PIN_BACKGROUND_LOCK_THRESHOLD_MS = 60_000;

export interface PinRecord {
  salt: string;
  hash: string;
  iterations: number;
}

export interface PinAttemptState {
  failedAttempts: number;
  lockedUntil: number | null;
}

export const INITIAL_PIN_ATTEMPT_STATE: PinAttemptState = {
  failedAttempts: 0,
  lockedUntil: null,
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('無效的十六進位字串');
  }
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 檢查是否為合法的 4 位數數字密碼。
 */
export function isValidPinFormat(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

async function derivePinHashHex(
  pin: string,
  saltBytes: Uint8Array,
  iterations: number,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('此環境不支援 Web Crypto API');
  }
  const encoder = new TextEncoder();
  const keyMaterial = await subtle.importKey(
    'raw',
    encoder.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const saltBuffer = new Uint8Array(saltBytes).buffer;
  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

/**
 * 使用 PBKDF2-SHA256（10 萬次迭代、16 bytes 隨機 salt）雜湊 4 位數密碼，不回傳明碼。
 */
export async function hashPin(pin: string, customSalt?: Uint8Array): Promise<PinRecord> {
  if (!isValidPinFormat(pin)) {
    throw new Error('密碼必須為 4 位數字');
  }
  const saltBytes =
    customSalt ?? globalThis.crypto.getRandomValues(new Uint8Array(PIN_SALT_BYTES));
  const hash = await derivePinHashHex(pin, saltBytes, PIN_PBKDF2_ITERATIONS);
  return {
    salt: bytesToHex(saltBytes),
    hash,
    iterations: PIN_PBKDF2_ITERATIONS,
  };
}

/**
 * 驗證輸入的 4 位數密碼是否與儲存的 salt／雜湊相符。
 */
export async function verifyPin(pin: string, record: PinRecord): Promise<boolean> {
  if (!isValidPinFormat(pin)) {
    return false;
  }
  try {
    const saltBytes = hexToBytes(record.salt);
    const derived = await derivePinHashHex(pin, saltBytes, record.iterations);
    return constantTimeEqual(derived, record.hash);
  } catch {
    return false;
  }
}

/**
 * 記錄一次密碼輸入錯誤；累計達 5 次時鎖定 30 秒。
 */
export function recordPinFailure(state: PinAttemptState, now: number): PinAttemptState {
  const nextFailed = state.failedAttempts + 1;
  if (nextFailed >= PIN_MAX_FAILED_ATTEMPTS) {
    return {
      failedAttempts: nextFailed,
      lockedUntil: now + PIN_LOCKOUT_DURATION_MS,
    };
  }
  return {
    failedAttempts: nextFailed,
    lockedUntil: state.lockedUntil,
  };
}

/**
 * 檢查目前是否處於錯誤次數過多的冷卻鎖定期間。
 */
export function isPinLockedOut(
  state: PinAttemptState,
  now: number,
): { locked: boolean; remainingSeconds: number } {
  if (state.lockedUntil === null || now >= state.lockedUntil) {
    return { locked: false, remainingSeconds: 0 };
  }
  const remainingSeconds = Math.ceil((state.lockedUntil - now) / 1000);
  return { locked: true, remainingSeconds };
}

/**
 * 判斷 App 從背景回到前景時是否應重新上鎖（預設背景超過 60 秒即上鎖）。
 */
export function shouldLockOnResume(
  hiddenAt: number | null,
  now: number,
  thresholdMs: number = PIN_BACKGROUND_LOCK_THRESHOLD_MS,
): boolean {
  if (hiddenAt === null) {
    return false;
  }
  return now - hiddenAt > thresholdMs;
}

/**
 * 解析儲存在本機 meta 的密碼鎖設定 JSON。
 */
export function parsePinRecordJson(raw: string | undefined): PinRecord | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'salt' in parsed &&
      'hash' in parsed &&
      'iterations' in parsed &&
      typeof parsed.salt === 'string' &&
      typeof parsed.hash === 'string' &&
      typeof parsed.iterations === 'number' &&
      parsed.salt.length > 0 &&
      parsed.hash.length > 0 &&
      Number.isFinite(parsed.iterations) &&
      parsed.iterations > 0
    ) {
      return {
        salt: parsed.salt,
        hash: parsed.hash,
        iterations: parsed.iterations,
      };
    }
    return null;
  } catch {
    return null;
  }
}
