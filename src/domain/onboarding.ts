export type InstallPlatform =
  | 'ios-safari'
  | 'ios-other'
  | 'android-chrome'
  | 'android-inapp'
  | 'desktop-chromium'
  | 'other';

export interface PlatformDetectionInput {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

export interface DataProtectionCardInput {
  isSyncEnabled: boolean;
  isPersisted: boolean | null;
  transactionCount: number;
  lastJsonBackupAt: number | null;
  dismissedAt: number | null;
  now: number;
}

export interface InstallPromptCardInput {
  isInstalled: boolean;
  transactionCount: number;
  dismissedAt: number | null;
  now: number;
}

export interface OnboardingVisibilityInput {
  onboardingCompleted: boolean;
  transactionCount: number;
}

export type HomeReminderCardType = 'data-protection' | 'install-pwa' | null;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DATA_PROTECTION_INTERVAL_DAYS = 14;
export const INSTALL_DISMISS_INTERVAL_DAYS = 30;
export const DATA_PROTECTION_MIN_TX = 10;
export const INSTALL_PROMPT_MIN_TX = 3;

const INAPP_BROWSER_RE = /Line\/|FBAN|FBAV|Instagram|MicroMessenger|wv\)/i;
const IOS_NON_SAFARI_RE = /CriOS|FxiOS|EdgiOS|OPiOS|Line\/|FBAN|FBAV|Instagram|MicroMessenger/i;

/**
 * 依據瀏覽器 UA、platform 與觸控點數判斷目前執行平台，供「加到主畫面」引導使用。
 */
export function detectInstallPlatform({
  userAgent,
  platform = '',
  maxTouchPoints = 0,
}: PlatformDetectionInput): InstallPlatform {
  const ua = userAgent || '';

  // iPadOS 13+ 桌面版模式會回報 Macintosh UA，但 platform 為 MacIntel 且具備多點觸控
  const isIPadDesktopMode =
    (platform === 'MacIntel' || /Macintosh/i.test(ua)) && maxTouchPoints > 1;
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || isIPadDesktopMode;

  if (isIOS) {
    if (IOS_NON_SAFARI_RE.test(ua)) {
      return 'ios-other';
    }
    if (/Safari/i.test(ua)) {
      return 'ios-safari';
    }
    return 'ios-other';
  }

  if (/Android/i.test(ua)) {
    if (INAPP_BROWSER_RE.test(ua)) {
      return 'android-inapp';
    }
    if (/Chrome\/|EdgA\//i.test(ua) && !/OPR\//i.test(ua)) {
      return 'android-chrome';
    }
    return 'other';
  }

  // 桌機 Chromium 系瀏覽器（Chrome / Edge）
  if ((/Chrome\//i.test(ua) || /Edg\//i.test(ua)) && !/OPR\//i.test(ua)) {
    return 'desktop-chromium';
  }

  return 'other';
}

/**
 * 判斷目前是否已以獨立 App（PWA）模式開啟。
 */
export function isStandaloneDisplayMode(
  matchMediaStandalone: boolean,
  navigatorStandalone?: boolean,
): boolean {
  return Boolean(matchMediaStandalone || navigatorStandalone === true);
}

/**
 * 判斷首頁是否應顯示「資料保護提醒卡」。
 * 必須同時符合：未開啟 Google 同步、未取得永久保存、交易 >= 10 筆、距上次 JSON 備份或關閉達 14 天。
 */
export function shouldShowDataProtectionCard(input: DataProtectionCardInput): boolean {
  if (input.isSyncEnabled) {
    return false;
  }
  if (input.isPersisted === true) {
    return false;
  }
  if (input.transactionCount < DATA_PROTECTION_MIN_TX) {
    return false;
  }

  const lastAckAt = Math.max(input.lastJsonBackupAt ?? 0, input.dismissedAt ?? 0);
  if (lastAckAt <= 0) {
    return true;
  }

  return input.now - lastAckAt >= DATA_PROTECTION_INTERVAL_DAYS * DAY_MS;
}

/**
 * 判斷首頁是否應顯示「加到主畫面」提醒小卡。
 * 必須同時符合：尚未安裝、交易 >= 3 筆、未在 30 天內關閉過。
 */
export function shouldShowInstallPromptCard(input: InstallPromptCardInput): boolean {
  if (input.isInstalled) {
    return false;
  }
  if (input.transactionCount < INSTALL_PROMPT_MIN_TX) {
    return false;
  }
  if (input.dismissedAt !== null && input.dismissedAt > 0) {
    return input.now - input.dismissedAt < INSTALL_DISMISS_INTERVAL_DAYS * DAY_MS ? false : true;
  }
  return true;
}

/**
 * 決定首頁要顯示哪一張提醒卡（一次最多一張，優先順序：資料保護 > 加到主畫面）。
 */
export function getHomeReminderCard(params: {
  dataProtection: DataProtectionCardInput;
  installPrompt: InstallPromptCardInput;
}): HomeReminderCardType {
  if (shouldShowDataProtectionCard(params.dataProtection)) {
    return 'data-protection';
  }
  if (shouldShowInstallPromptCard(params.installPrompt)) {
    return 'install-pwa';
  }
  return null;
}

/**
 * 判斷是否應自動顯示初次使用的新手導覽。
 * 僅在尚未完成導覽且交易筆數為 0 時顯示。
 */
export function shouldShowOnboarding(input: OnboardingVisibilityInput): boolean {
  return !input.onboardingCompleted && input.transactionCount === 0;
}
