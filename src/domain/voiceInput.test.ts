import { describe, expect, it } from 'vitest';
import { chooseVoiceInputMode, describeSpeechError } from './voiceInput';

describe('chooseVoiceInputMode', () => {
  it('iPhone／iPad 一律改用鍵盤聽寫（即使有 webkitSpeechRecognition）', () => {
    expect(chooseVoiceInputMode('ios-safari', true)).toBe('keyboard-dictation');
    expect(chooseVoiceInputMode('ios-other', true)).toBe('keyboard-dictation');
    expect(chooseVoiceInputMode('ios-other', false)).toBe('keyboard-dictation');
  });

  it('其他平台有 Web Speech API 才使用，否則不顯示', () => {
    expect(chooseVoiceInputMode('android-chrome', true)).toBe('web-speech');
    expect(chooseVoiceInputMode('desktop-chromium', true)).toBe('web-speech');
    expect(chooseVoiceInputMode('other', false)).toBe('none');
    expect(chooseVoiceInputMode('android-inapp', false)).toBe('none');
  });
});

describe('describeSpeechError', () => {
  it('常見錯誤有對應的中文說明，aborted 不提示', () => {
    expect(describeSpeechError('not-allowed')).toContain('麥克風權限');
    expect(describeSpeechError('no-speech')).toContain('沒有聽到聲音');
    expect(describeSpeechError('aborted')).toBe('');
    expect(describeSpeechError(undefined)).toContain('再試一次');
  });
});
