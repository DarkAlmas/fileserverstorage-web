/**
 * Клиент Supabase Storage по образцу database/SupabaseManager.java.
 * Авторизация: Bearer <Firebase ID token> + apikey: <publishable key>.
 */
import {
  MAX_UPLOAD_BYTES,
  SIGNED_URL_TTL_UPLOAD,
  SUPABASE_ANON_KEY,
  SUPABASE_BUCKET,
  SUPABASE_URL,
} from './config.js';
import { auth } from './firebase.js';

export { MAX_UPLOAD_BYTES };

export class UploadTooLargeError extends Error {
  constructor() {
    super('Файл слишком большой, максимум 50 МБ');
    this.name = 'UploadTooLargeError';
  }
}

export async function firebaseIdToken(forceRefresh = false) {
  const user = auth.currentUser;
  if (!user) throw new Error('Нет авторизованного пользователя');
  let result = await user.getIdTokenResult(forceRefresh);
  // Supabase пускает только с email_verified = true. Если почту уже подтвердили,
  // а в закэшированном токене ещё false — принудительно обновляем токен.
  if (user.emailVerified && result.claims.email_verified !== true) {
    result = await user.getIdTokenResult(true);
  }
  const token = result.token;
  if (!token) throw new Error('Пустой Firebase ID token');
  return token;
}

function encodePath(path) {
  return String(path)
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/\+/g, '%20'))
    .join('/');
}

function objectUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${encodePath(path)}`;
}

function signUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/sign/${SUPABASE_BUCKET}/${encodePath(path)}`;
}

function authHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    apikey: SUPABASE_ANON_KEY,
    ...extra,
  };
}

function safeFileName(fileName) {
  return String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * @param {File} file
 * @param {(ratio: number) => void} [onProgress]
 * @returns {Promise<{ path: string, downloadUrl: string }>}
 */
export async function uploadFile(file, onProgress) {
  const user = auth.currentUser;
  if (!user) throw new Error('Нет авторизованного пользователя');
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadTooLargeError();

  const token = await firebaseIdToken();
  const path = `users/${user.uid}/${crypto.randomUUID()}_${safeFileName(file.name)}`;
  const mime = file.type || 'application/octet-stream';

  await putObject(path, file, token, mime, onProgress);
  const downloadUrl = await createSignedUrl(path, SIGNED_URL_TTL_UPLOAD);
  if (!downloadUrl) throw new Error('Не удалось получить ссылку на файл');
  return { path, downloadUrl };
}

function putObject(path, file, token, mime, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', objectUrl(path));
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('Content-Type', mime);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === 'function') {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(new Error(xhr.responseText || `Upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Ошибка сети при загрузке файла'));
    xhr.send(file);
  });
}

export async function deleteStoredFile(storagePath) {
  const token = await firebaseIdToken();
  const response = await fetch(objectUrl(storagePath), {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `Delete failed: ${response.status}`);
  }
}

/**
 * POST /storage/v1/object/sign/user-files/<path>  { expiresIn }
 * Ответ: { signedURL } → SUPABASE_URL + "/storage/v1" + signedURL
 */
export async function createSignedUrl(storagePath, expiresInSeconds) {
  const token = await firebaseIdToken();
  const response = await fetch(signUrl(storagePath), {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `Sign failed: ${response.status}`);
  }
  const json = await response.json();
  const signedURL = json && json.signedURL;
  if (!signedURL) throw new Error('Sign response missing signedURL');
  return `${SUPABASE_URL}/storage/v1${signedURL}`;
}
