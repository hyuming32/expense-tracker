import type { InstallPlatform } from './onboarding';

/**
 * 語音輸入方式：
 * - web-speech：使用瀏覽器 Web Speech API（Android Chrome、桌機 Chrome／Edge 可用）
 * - keyboard-dictation：iPhone／iPad 的 Web Speech API 在 Safari 與「加到主畫面」模式下常常沒反應，
 *   改為把游標移到輸入框，請使用者按鍵盤上的 🎤 聽寫（系統內建，穩定可用）
 * - none：不支援，不顯示麥克風按鈕
 */
export type VoiceInputMode = 'web-speech' | 'keyboard-dictation' | 'none';

export function chooseVoiceInputMode(
  platform: InstallPlatform,
  hasSpeechRecognition: boolean,
): VoiceInputMode {
  if (platform === 'ios-safari' || platform === 'ios-other') {
    return 'keyboard-dictation';
  }
  return hasSpeechRecognition ? 'web-speech' : 'none';
}

/** 將 Web Speech API 的錯誤代碼轉成使用者看得懂的中文提示 */
export function describeSpeechError(code: string | undefined): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '沒有麥克風權限，請到瀏覽器設定允許此網站使用麥克風。';
    case 'no-speech':
      return '沒有聽到聲音，請再按一次 🎤 並靠近手機說話。';
    case 'audio-capture':
      return '找不到麥克風，請確認裝置的麥克風可以使用。';
    case 'network':
      return '語音辨識需要網路連線，請確認網路後再試一次。';
    case 'aborted':
      return '';
    default:
      return '語音輸入沒有成功，請再試一次，或改用鍵盤上的 🎤 聽寫。';
  }
}

export const KEYBOARD_DICTATION_TIP =
  '請按鍵盤上的 🎤（空白鍵旁或右下角）直接說，例如「午餐 牛肉麵 180」。沒看到麥克風的話，到 iPhone「設定 > 一般 > 鍵盤」開啟「啟用聽寫」。';
