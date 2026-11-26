import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  detectInstallPlatform,
  getHomeReminderCard,
  isStandaloneDisplayMode,
  shouldShowDataProtectionCard,
  shouldShowInstallPromptCard,
  shouldShowOnboarding,
} from './onboarding';

describe('detectInstallPlatform', () => {
  it('辨識 iPhone Safari', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    expect(detectInstallPlatform({ userAgent: ua, platform: 'iPhone', maxTouchPoints: 5 })).toBe(
      'ios-safari',
    );
  });

  it('辨識 iPhone Chrome (CriOS)', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1';
    expect(detectInstallPlatform({ userAgent: ua, platform: 'iPhone', maxTouchPoints: 5 })).toBe(
      'ios-other',
    );
  });

  it('辨識 iPhone LINE 內建瀏覽器', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/14.7.0';
    expect(detectInstallPlatform({ userAgent: ua, platform: 'iPhone', maxTouchPoints: 5 })).toBe(
      'ios-other',
    );
  });

  it('辨識 iPad 桌面版 UA 搭配 maxTouchPoints', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    expect(detectInstallPlatform({ userAgent: ua, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(
      'ios-safari',
    );
    expect(detectInstallPlatform({ userAgent: ua, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(
      'other',
    );
  });

  it('辨識 Android Chrome', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.165 Mobile Safari/537.36';
    expect(detectInstallPlatform({ userAgent: ua, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(
      'android-chrome',
    );
  });

  it('辨識 Android FB 內建瀏覽器', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36 [FBAN/FB4A;FBAV/465.0.0.0;]';
    expect(detectInstallPlatform({ userAgent: ua, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(
      'android-inapp',
    );
  });

  it('辨識桌機 Chrome', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    expect(detectInstallPlatform({ userAgent: ua, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(
      'desktop-chromium',
    );
  });
});

describe('isStandaloneDisplayMode', () => {
  it('任一 standalone 條件成立即回傳 true', () => {
    expect(isStandaloneDisplayMode(true, false)).toBe(true);
    expect(isStandaloneDisplayMode(false, true)).toBe(true);
    expect(isStandaloneDisplayMode(false, false)).toBe(false);
    expect(isStandaloneDisplayMode(false, undefined)).toBe(false);
  });
});

describe('shouldShowDataProtectionCard', () => {
  const now = 1_700_000_000_000;
  const baseInput = {
    isSyncEnabled: false,
    isPersisted: false,
    transactionCount: 10,
    lastJsonBackupAt: null,
    dismissedAt: null,
    now,
  };

  it('交易筆數 9 筆不顯示、10 筆顯示', () => {
    expect(shouldShowDataProtectionCard({ ...baseInput, transactionCount: 9 })).toBe(false);
    expect(shouldShowDataProtectionCard({ ...baseInput, transactionCount: 10 })).toBe(true);
  });

  it('距離上次備份或關閉 13 天不顯示、14 天顯示', () => {
    expect(
      shouldShowDataProtectionCard({ ...baseInput, lastJsonBackupAt: now - 13 * DAY_MS }),
    ).toBe(false);
    expect(
      shouldShowDataProtectionCard({ ...baseInput, lastJsonBackupAt: now - 14 * DAY_MS }),
    ).toBe(true);
    expect(shouldShowDataProtectionCard({ ...baseInput, dismissedAt: now - 13 * DAY_MS })).toBe(
      false,
    );
    expect(shouldShowDataProtectionCard({ ...baseInput, dismissedAt: now - 14 * DAY_MS })).toBe(
      true,
    );
  });

  it('已開啟 Google 同步或已取得永久保存時不顯示', () => {
    expect(shouldShowDataProtectionCard({ ...baseInput, isSyncEnabled: true })).toBe(false);
    expect(shouldShowDataProtectionCard({ ...baseInput, isPersisted: true })).toBe(false);
    expect(shouldShowDataProtectionCard({ ...baseInput, isPersisted: null })).toBe(true);
  });
});

describe('shouldShowInstallPromptCard', () => {
  const now = 1_700_000_000_000;
  const baseInput = {
    isInstalled: false,
    transactionCount: 3,
    dismissedAt: null,
    now,
  };

  it('已安裝時不顯示', () => {
    expect(shouldShowInstallPromptCard({ ...baseInput, isInstalled: true })).toBe(false);
  });

  it('交易筆數 2 筆不顯示、3 筆顯示', () => {
    expect(shouldShowInstallPromptCard({ ...baseInput, transactionCount: 2 })).toBe(false);
    expect(shouldShowInstallPromptCard({ ...baseInput, transactionCount: 3 })).toBe(true);
  });

  it('30 天內關閉過不顯示、滿 30 天後再顯示', () => {
    expect(shouldShowInstallPromptCard({ ...baseInput, dismissedAt: now - 29 * DAY_MS })).toBe(
      false,
    );
    expect(shouldShowInstallPromptCard({ ...baseInput, dismissedAt: now - 30 * DAY_MS })).toBe(
      true,
    );
  });
});

describe('getHomeReminderCard', () => {
  const now = 1_700_000_000_000;

  it('同時符合條件時優先顯示資料保護卡', () => {
    expect(
      getHomeReminderCard({
        dataProtection: {
          isSyncEnabled: false,
          isPersisted: false,
          transactionCount: 12,
          lastJsonBackupAt: null,
          dismissedAt: null,
          now,
        },
        installPrompt: {
          isInstalled: false,
          transactionCount: 12,
          dismissedAt: null,
          now,
        },
      }),
    ).toBe('data-protection');
  });

  it('資料保護不顯示時才顯示加到主畫面卡', () => {
    expect(
      getHomeReminderCard({
        dataProtection: {
          isSyncEnabled: true,
          isPersisted: false,
          transactionCount: 5,
          lastJsonBackupAt: null,
          dismissedAt: null,
          now,
        },
        installPrompt: {
          isInstalled: false,
          transactionCount: 5,
          dismissedAt: null,
          now,
        },
      }),
    ).toBe('install-pwa');
  });

  it('兩者都不符合時回傳 null', () => {
    expect(
      getHomeReminderCard({
        dataProtection: {
          isSyncEnabled: true,
          isPersisted: true,
          transactionCount: 2,
          lastJsonBackupAt: null,
          dismissedAt: null,
          now,
        },
        installPrompt: {
          isInstalled: true,
          transactionCount: 2,
          dismissedAt: null,
          now,
        },
      }),
    ).toBeNull();
  });
});

describe('shouldShowOnboarding', () => {
  it('新使用者（未完成且無交易）顯示導覽', () => {
    expect(shouldShowOnboarding({ onboardingCompleted: false, transactionCount: 0 })).toBe(true);
  });

  it('已有交易的舊使用者不顯示導覽', () => {
    expect(shouldShowOnboarding({ onboardingCompleted: false, transactionCount: 1 })).toBe(false);
  });

  it('已完成導覽者不顯示導覽', () => {
    expect(shouldShowOnboarding({ onboardingCompleted: true, transactionCount: 0 })).toBe(false);
  });
});
