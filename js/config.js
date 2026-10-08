/**
 * Конфигурация бэкенда FileServerStorage.
 *
 * Значения совпадают с Android-приложением:
 *   - Firebase: app/google-services.json
 *   - Supabase: database/SupabaseManager.java
 *
 * Если Android apiKey ограничен только Android-приложениями, зарегистрируйте
 * Web-приложение в Firebase Console и подставьте сюда его apiKey и appId.
 *
 * Firebase JS SDK (модульный v10+) подключается из:
 *   https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js
 *   https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js
 *   https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js
 */

export const FIREBASE_SDK_VERSION = '10.14.1';

export const firebaseConfig = {
  apiKey: 'AIzaSyDn45ZLyszYmfH6gHPLF-i4DbGQ-nepfmk',
  authDomain: 'fileserverstorage-10052.firebaseapp.com',
  projectId: 'fileserverstorage-10052',
  storageBucket: 'fileserverstorage-10052.firebasestorage.app',
  messagingSenderId: '1059424430921',
  // Android appId из google-services.json. Для веба лучше заменить на appId Web-приложения.
  appId: '1:1059424430921:android:353047fb6cbad7a283c898',
};

/**
 * Web Client ID из AuthManager.GOOGLE_WEB_CLIENT_ID.
 * Для signInWithPopup Firebase использует OAuth-клиент проекта сам;
 * идентификатор оставлен для справки и совпадения с приложением.
 */
export const GOOGLE_WEB_CLIENT_ID =
  '1059424430921-kqui7bbgmkdu7f5jbra4as2dvabegs2n.apps.googleusercontent.com';

/** https://zehkfdbhxhymjwkghklm.supabase.co — SupabaseManager.SUPABASE_URL */
export const SUPABASE_URL = 'https://zehkfdbhxhymjwkghklm.supabase.co';

/** Публикуемый ключ (publishable / anon) — SupabaseManager.SUPABASE_ANON_KEY */
export const SUPABASE_ANON_KEY =
  'sb_publishable_b2iSNRHBrMDkSxLK8XwAyg__XgxNSh3';

/** Бакет хранилища — SupabaseManager.BUCKET */
export const SUPABASE_BUCKET = 'user-files';

/** Лимит одного файла — SupabaseManager.MAX_UPLOAD_BYTES */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Квота хранилища пользователя — HomeFragment.MAX_STORAGE_BYTES */
export const MAX_STORAGE_BYTES = 1024 * 1024 * 1024;

export const SIGNED_URL_TTL_UPLOAD = 604800; // 7 суток, как в приложении
export const SIGNED_URL_TTL_OPEN = 3600; // 1 час для своих файлов
