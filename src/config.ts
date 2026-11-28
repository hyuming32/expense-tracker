export const GOOGLE_CLIENT_ID = '518552653919-lor508476jj66e97mmgdmruc4qe7h5b6.apps.googleusercontent.com';

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

/**
 * 檢查是否已設定有效的 Google OAuth Client ID。
 */
export function isGoogleClientConfigured(): boolean {
  return GOOGLE_CLIENT_ID.trim().length > 0 && GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com');
}
/** 「備份到 Drive」與家庭帳本共用：只能存取本 App 自己建立或使用者選擇的可見檔案（非敏感權限）。 */
export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Google Picker API Key（尚未設定時為空字串）。 */
export const GOOGLE_PICKER_API_KEY = '';

/** Google Cloud 專案編號（供 Google Picker 設定 appId）。 */
export const GOOGLE_CLOUD_PROJECT_NUMBER = '518552653919';

/**
 * 檢查是否已設定 Google Picker 所需的 API Key 與專案編號。
 */
export function isPickerConfigured(): boolean {
  return (
    GOOGLE_PICKER_API_KEY.trim().length > 0 && GOOGLE_CLOUD_PROJECT_NUMBER.trim().length > 0
  );
}
