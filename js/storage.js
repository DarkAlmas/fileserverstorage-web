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
  const signedToken = extractSignedToken(signedURL);
  if (!signedToken) throw new Error('Sign response missing token');
  // Supabase отдаёт путь в signedURL НЕ закодированным (пробелы, «#», «%», «?» в имени ломают ссылку),
  // поэтому собираем ссылку сами из закодированного пути и токена.
  return buildSignedUrl(storagePath, signedToken);
}

/** Токен из ответа /object/sign: последний «?token=» (путь может сам содержать «?»). */
export function extractSignedToken(signedURL) {
  if (typeof signedURL !== 'string') return null;
  const start = Math.max(signedURL.lastIndexOf('?token='), signedURL.lastIndexOf('&token='));
  if (start < 0) return null;
  let raw = signedURL.slice(start + '?token='.length);
  const amp = raw.indexOf('&');
  if (amp >= 0) raw = raw.slice(0, amp);
  let token;
  try {
    token = decodeURIComponent(raw);
  } catch (error) {
    return null;
  }
  return /^[A-Za-z0-9._-]+$/.test(token) ? token : null;
}

export function buildSignedUrl(storagePath, signedToken, downloadName) {
  let url = `${signUrl(storagePath)}?token=${encodeURIComponent(signedToken)}`;
  if (downloadName) url += `&download=${encodeURIComponent(downloadName)}`;
  return url;
}

/** Добавляет download=<имя>: Supabase отдаст файл как вложение (Content-Disposition: attachment). */
export function withDownloadName(signedUrl, name) {
  if (!name) return signedUrl;
  let url;
  try {
    url = new URL(signedUrl);
  } catch (error) {
    return signedUrl;
  }
  if (url.searchParams.has('download')) return signedUrl;
  return `${signedUrl}&download=${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// Таблица public.shares (отправка файлов другим пользователям по UID).
// Контракт: INSERT {owner_uid, recipient_uid, path, file_name}; path = users/<owner_uid>/<имя>,
// файл уже лежит в бакете; входящие = recipient_uid = мой UID; UPDATE запрещён.
// ---------------------------------------------------------------------------

const SHARES_URL = `${SUPABASE_URL}/rest/v1/shares`;

/** Путь подходит под контракт shares: users/<ownerUid>/<имя>, без «..». */
export function isShareablePath(path, ownerUid) {
  if (!path || !ownerUid || String(path).includes('..')) return false;
  if (!/^[A-Za-z0-9]{1,128}$/.test(ownerUid)) return false;
  const prefix = `users/${ownerUid}/`;
  return path.startsWith(prefix) && path.length > prefix.length && !path.slice(prefix.length).includes('/');
}

export class ShareError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function insertShare(ownerUid, recipientUid, path, fileName) {
  if (!isShareablePath(path, ownerUid)) {
    throw new ShareError('bad-path', 'Этот файл загружен в старом формате — отправить его пока нельзя');
  }
  const token = await firebaseIdToken();
  const name = String(fileName || 'file').slice(0, 255) || 'file';
  const response = await fetch(SHARES_URL, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ owner_uid: ownerUid, recipient_uid: recipientUid, path, file_name: name }),
  });
  if (response.status === 409) {
    throw new ShareError('already-shared', 'Этот файл уже отправлен этому пользователю');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('Share insert failed', response.status, body);
    throw new ShareError('error', 'Не удалось отправить файл');
  }
}

/** Входящие: [{ id, owner_uid, path, file_name, created_at }] */
export async function listIncomingShares(myUid) {
  const token = await firebaseIdToken();
  const url =
    `${SHARES_URL}?select=id,owner_uid,path,file_name,created_at` +
    `&recipient_uid=eq.${encodeURIComponent(myUid)}&order=created_at.desc`;
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `Shares list failed: ${response.status}`);
  }
  return response.json();
}

async function deleteShares(filter) {
  const token = await firebaseIdToken();
  const response = await fetch(`${SHARES_URL}?${filter}`, {
    method: 'DELETE',
    headers: authHeaders(token, { Prefer: 'return=minimal' }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `Share delete failed: ${response.status}`);
  }
}

/** Получатель убирает входящий файл у себя: удаляется только запись, файл остаётся у владельца. */
export function deleteShare(shareId) {
  return deleteShares(`id=eq.${encodeURIComponent(shareId)}`);
}

/** Владелец удалил файл — удаляем его отправки (триггер в БД делает то же самое). */
export function deleteSharesForPath(ownerUid, path) {
  return deleteShares(
    `owner_uid=eq.${encodeURIComponent(ownerUid)}&path=eq.${encodeURIComponent(path)}`,
  );
}

/**
 * Открывать можно только ссылки на наш Supabase Storage: https, тот же origin, что у
 * SUPABASE_URL, и путь /storage/v1/... URL разбирается через new URL (нормализует «..»,
 * %2e и т.п.), сравниваются origin и pathname, а не сырая строка.
 */
export function isTrustedStorageUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let url;
  let base;
  try {
    url = new URL(raw);
    base = new URL(SUPABASE_URL);
  } catch (error) {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.origin === base.origin &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !raw.includes('#') &&
    url.pathname.startsWith('/storage/v1/') &&
    !/\/\.\.?(\/|$)/.test(url.pathname)
  );
}
