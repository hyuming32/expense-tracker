export const GOOGLE_CLIENT_ID = '518552653919-lor508476jj66e97mmgdmruc4qe7h5b6.apps.googleusercontent.com';

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

/**
 * 檢查是否已設定有效的 Google OAuth Client ID。
 */
export function isGoogleClientConfigured(): boolean {
  return GOOGLE_CLIENT_ID.trim().length > 0 && GOOGLE_CLIENT_ID !== '518552653919-lor508476jj66e97mmgdmruc4qe7h5b6.apps.googleusercontent.com';
}
