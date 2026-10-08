/**
 * Модель FileItem и операции с коллекцией Files — как в Android-приложении.
 */
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { MAX_STORAGE_BYTES, SIGNED_URL_TTL_OPEN } from './config.js';
import { auth, db } from './firebase.js';
import { isSearchableNickname, nicknameKey } from './auth.js';
import {
  createSignedUrl,
  deleteShare,
  deleteSharesForPath,
  deleteStoredFile,
  insertShare,
  isTrustedStorageUrl,
  withDownloadName,
  listIncomingShares,
} from './storage.js';

export const INBOX_PREFIX = '!';
export { MAX_STORAGE_BYTES };

export function isReservedFolderName(name) {
  return typeof name === 'string' && name.startsWith(INBOX_PREFIX);
}

export function inboxFolderFor(senderEmail) {
  return INBOX_PREFIX + senderEmail;
}

export function parentPath(item) {
  return item.parent == null ? '' : item.parent;
}

export function childPath(item) {
  const p = parentPath(item);
  return p === '' ? item.name : `${p}/${item.name}`;
}

export function isInboxFolder(item) {
  return item.isFolder && item.name && item.name.startsWith(INBOX_PREFIX);
}

export function getDisplayName(item) {
  if (isInboxFolder(item) && item.name.length > 1) {
    return 'От: ' + item.name.substring(1);
  }
  return item.name || '';
}

export function displayFolderName(name) {
  if (isReservedFolderName(name) && name.length > 1) {
    return 'От: ' + name.substring(1);
  }
  return name;
}

export function isReceived(item) {
  return !!(item.sharedBy && item.sharedBy.length);
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' КБ';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' МБ';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
}

export function formatFileInfo(item) {
  if (item.isFolder) {
    return isInboxFolder(item) ? 'Входящие файлы' : 'Папка';
  }
  if (item.shareId) {
    // У входящих из public.shares размер неизвестен — показываем только дату.
    const d = item.uploadedAt
      ? new Date(item.uploadedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
      : '';
    return 'Получен' + (d ? ' · ' + d : '');
  }
  const date = item.uploadedAt
    ? new Date(item.uploadedAt).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';
  return formatSize(item.size) + (date ? ' · ' + date : '');
}

export function fileKind(contentType) {
  const t = contentType || '';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.includes('pdf')) return 'pdf';
  if (t.includes('png')) return 'image';
  if (t.includes('zip')) return 'zip';
  if (t.includes('wav') || t.includes('aiff') || t.includes('dsd') || t.includes('dxd') || t.startsWith('audio/')) {
    return 'audio';
  }
  return 'file';
}

export function fromFirestore(id, data) {
  return {
    id,
    name: data.name || '',
    storagePath: data.storagePath || '',
    downloadUrl: data.downloadUrl || '',
    size: Number(data.size) || 0,
    uploadedAt: Number(data.uploadedAt) || 0,
    ownerEmail: data.ownerEmail || '',
    contentType: data.contentType || '',
    isFolder: !!data.isFolder,
    parent: data.parent == null ? '' : data.parent,
    sharedBy: data.sharedBy || '',
  };
}

export function listenUserFiles(ownerEmail, onChange, onError) {
  const q = query(
    collection(db, 'Files'),
    where('ownerEmail', '==', ownerEmail),
    orderBy('uploadedAt', 'desc'),
  );
  return onSnapshot(
    q,
    (snapshots) => {
      const items = [];
      let totalSize = 0;
      snapshots.forEach((d) => {
        const item = fromFirestore(d.id, d.data());
        items.push(item);
        if (!item.isFolder && !isReceived(item)) totalSize += item.size;
      });
      onChange(items, totalSize);
    },
    onError,
  );
}

function matches(name, queryText) {
  if (!queryText) return true;
  return name != null && name.toLowerCase().includes(queryText);
}

function firstChildFolder(parent, currentFolder) {
  if (!parent) return null;
  if (!currentFolder) {
    const slash = parent.indexOf('/');
    return slash < 0 ? parent : parent.substring(0, slash);
  }
  const prefix = currentFolder + '/';
  if (!parent.startsWith(prefix)) return null;
  const rest = parent.substring(prefix.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? rest : rest.substring(0, slash);
}

/** Фильтр списка как в HomeFragment.applyFilter */
export function applyFilter(allFiles, currentFolder, searchQuery) {
  const queryText = (searchQuery || '').trim().toLowerCase();
  const folders = [];
  const files = [];
  const folderNames = new Set();

  for (const item of allFiles) {
    if (item.isFolder && currentFolder === parentPath(item)) {
      if (matches(getDisplayName(item), queryText)) {
        folders.push(item);
        folderNames.add(item.name);
      }
    }
  }

  for (const item of allFiles) {
    if (item.isFolder) continue;
    const parent = parentPath(item);
    if (currentFolder === parent) {
      if (matches(item.name, queryText)) files.push(item);
    } else {
      const child = firstChildFolder(parent, currentFolder);
      if (child && !folderNames.has(child) && matches(displayFolderName(child), queryText)) {
        folders.push({
          id: null,
          isFolder: true,
          name: child,
          parent: currentFolder,
          uploadedAt: item.uploadedAt,
          size: 0,
          storagePath: '',
          downloadUrl: '',
          ownerEmail: '',
          contentType: '',
          sharedBy: '',
        });
        folderNames.add(child);
      }
    }
  }

  folders.sort((a, b) =>
    getDisplayName(a).localeCompare(getDisplayName(b), 'ru', { sensitivity: 'base' }),
  );
  return folders.concat(files);
}

export async function createFolderRecord(name, currentFolder, ownerEmail) {
  await addDoc(collection(db, 'Files'), {
    name,
    isFolder: true,
    parent: currentFolder,
    ownerEmail,
    ownerUid: auth.currentUser ? auth.currentUser.uid : null,
    uploadedAt: Date.now(),
    size: 0,
  });
}

export async function addFileRecord(file, result, ownerEmail, folder) {
  await addDoc(collection(db, 'Files'), {
    name: file.name,
    storagePath: result.path,
    downloadUrl: result.downloadUrl,
    size: file.size,
    uploadedAt: Date.now(),
    ownerEmail,
    ownerUid: auth.currentUser ? auth.currentUser.uid : null,
    contentType: file.type || 'application/octet-stream',
    parent: folder,
    isFolder: false,
  });
}

export async function deleteFileItem(item) {
  if (item.shareId) {
    // Входящий файл из public.shares: удаляем только запись, файл остаётся у владельца.
    await deleteShare(item.shareId);
    return;
  }
  const received = isReceived(item);
  if (!received && item.storagePath) {
    try {
      await deleteStoredFile(item.storagePath);
    } catch (error) {
      const err = new Error('Ошибка удаления файла из Storage');
      err.cause = error;
      throw err;
    }
    // Отправки этого файла (триггер в БД удаляет их тоже — это страховка).
    const me = auth.currentUser;
    if (me) {
      deleteSharesForPath(me.uid, item.storagePath).catch((e) =>
        console.warn('delete shares failed', e),
      );
      deleteLegacyShares(item.storagePath, me.email).catch((e) =>
        console.warn('delete legacy shares failed', e),
      );
    }
  }
  await deleteDoc(doc(db, 'Files', item.id));
}

/** Старые «отправки» (копии в Files от прошлых версий) этого файла. */
async function deleteLegacyShares(storagePath, myEmail) {
  if (!myEmail) return;
  const snap = await getDocs(
    query(
      collection(db, 'Files'),
      where('sharedBy', '==', myEmail),
      where('storagePath', '==', storagePath),
    ),
  );
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
}

export function folderHasFiles(allFiles, folder) {
  const path = childPath(folder);
  return allFiles.some(
    (item) =>
      !item.isFolder &&
      (path === parentPath(item) || parentPath(item).startsWith(path + '/')),
  );
}

export async function deleteFolderRecord(folder) {
  if (!folder.id) {
    const err = new Error('Папка пустая');
    err.code = 'empty-folder';
    throw err;
  }
  await deleteDoc(doc(db, 'Files', folder.id));
}

/**
 * Поиск по нику: только Usernames/{ник в нижнем регистре} → Users/{uid}. Запросов (list)
 * по Users нет — правила их запрещают. Старый профиль, ещё не перенесённый (человек не
 * входил в новую версию), не находится — ник закрепится при его первом входе.
 * Почта получателя не читается и не показывается: для отправки нужен только UID.
 */
export async function searchUsersByNick(nick, _myEmail, myUid) {
  const text = String(nick || '').trim();
  if (!text || !isSearchableNickname(text)) return [];
  const claim = await getDoc(doc(db, 'Usernames', nicknameKey(text)));
  if (!claim.exists()) return [];
  const uid = claim.data().uid;
  if (!uid || uid === myUid) return [];
  let username = claim.data().userName || text;
  try {
    const user = await getDoc(doc(db, 'Users', uid));
    if (user.exists() && user.data().displayName) username = user.data().displayName;
  } catch (error) {
    console.warn('user read failed', error);
  }
  return [{ uid, username }];
}

/**
 * Отправка через Supabase public.shares: INSERT {owner_uid, recipient_uid, path, file_name}.
 * Файл уже лежит в бакете; получатель создаёт ссылку сам в момент открытия.
 */
export async function sendFileToUser(file, hit) {
  const me = auth.currentUser;
  if (!me) throw new Error('Вы не авторизованы');
  if (!hit || !hit.uid) {
    throw new Error('Не удалось определить получателя. Пусть он войдёт в новую версию приложения');
  }
  await insertShare(me.uid, hit.uid, file.storagePath, file.name);
}

const senderNames = new Map();

async function senderName(uid) {
  if (senderNames.has(uid)) return senderNames.get(uid);
  let name = 'пользователя';
  try {
    const snap = await getDoc(doc(db, 'Users', uid));
    if (snap.exists()) name = snap.data().displayName || snap.data().userName || name;
  } catch (error) {
    console.warn('sender read failed', error);
  }
  name = String(name).replace(/\//g, '_');
  senderNames.set(uid, name);
  return name;
}

/** Входящие из public.shares как элементы списка в папках «От: <ник>». */
export async function loadIncomingShareItems() {
  const me = auth.currentUser;
  if (!me) return [];
  const rows = await listIncomingShares(me.uid);
  const items = [];
  for (const row of rows) {
    const name = await senderName(row.owner_uid);
    items.push({
      id: 'share:' + row.id,
      shareId: row.id,
      name: row.file_name || 'file',
      storagePath: row.path,
      downloadUrl: '',
      size: 0,
      uploadedAt: row.created_at ? Date.parse(row.created_at) || 0 : 0,
      ownerEmail: '',
      contentType: '',
      isFolder: false,
      parent: inboxFolderFor(name),
      sharedBy: row.owner_uid,
    });
  }
  return items;
}

export async function openFileUrl(item) {
  let url;
  // Свой файл или входящий из public.shares — ссылку создаём в момент открытия.
  if ((!isReceived(item) || item.shareId) && item.storagePath) {
    url = await createSignedUrl(item.storagePath, SIGNED_URL_TTL_OPEN);
  } else {
    // Старые «отправки» из Firestore: downloadUrl записал другой человек — не доверяем ему.
    url = item.downloadUrl || null;
  }
  if (!url) {
    const err = new Error('У файла нет ссылки для скачивания');
    err.code = 'no-url';
    throw err;
  }
  if (!isTrustedStorageUrl(url)) {
    console.error('Untrusted storage URL', url);
    const err = new Error('Небезопасная ссылка на файл — открытие заблокировано');
    err.code = 'untrusted-url';
    throw err;
  }
  return withDownloadName(url, item.name || '');
}

export async function loadAccountStats(ownerEmail) {
  const snap = await getDocs(
    query(collection(db, 'Files'), where('ownerEmail', '==', ownerEmail)),
  );
  let count = 0;
  let total = 0;
  snap.forEach((d) => {
    count += 1;
    const size = d.data().size;
    if (typeof size === 'number') total += size;
  });
  return { count, total };
}

export function goUpPath(currentFolder) {
  const slash = currentFolder.lastIndexOf('/');
  return slash < 0 ? '' : currentFolder.substring(0, slash);
}

export function pathTitle(currentFolder) {
  if (!currentFolder) return 'Мои файлы';
  if (isReservedFolderName(currentFolder)) return 'От: ' + currentFolder.substring(1);
  const slash = currentFolder.lastIndexOf('/');
  const leaf = slash < 0 ? currentFolder : currentFolder.substring(slash + 1);
  return displayFolderName(leaf);
}


// ---------------------------------------------------------------------------
// Перенос старых записей Files на новые пути в бакете (как LegacyFileMigration.java).
// Объекты users/<email с _at_>/X уже скопированы в users/<uid>/X (старые оставлены). Правила
// делают storagePath неизменяемым, поэтому создаётся НОВАЯ запись (id = <старый id>_u,
// storagePath = users/<uid>/X, ownerUid = uid, без downloadUrl и sharedBy*) и в том же batch
// (атомарно) удаляется старая. Папки не трогаем: дерево строится по строке parent, а не по id.
// Входящие «отправки» (sharedBy) не переносятся. Объекты в бакете не удаляются.
// Один раз за сессию на UID, после входа с подтверждённой почтой.
// ---------------------------------------------------------------------------

let migrationDoneFor = null;
let migrationRunningFor = null;

export function legacyNewPath(oldPath, uid) {
  if (!oldPath || oldPath.startsWith(`users/${uid}/`)) return null;
  const name = oldPath.substring(oldPath.lastIndexOf('/') + 1);
  if (!name || name === '.' || name === '..') return null;
  return `users/${uid}/${name}`;
}

export function legacyNewRecord(old, uid, email, newPath) {
  const data = { ...old };
  delete data.downloadUrl;
  delete data.sharedBy;
  delete data.sharedByUid;
  data.storagePath = newPath;
  data.ownerUid = uid;
  data.ownerEmail = email;
  data.migratedFrom = old.storagePath;
  return data;
}

export async function migrateLegacyFiles() {
  const user = auth.currentUser;
  if (!user || !user.email) return null;
  const { uid, email } = user;
  if (migrationDoneFor === uid || migrationRunningFor === uid) return null;
  migrationRunningFor = uid;
  const stats = { migrated: 0, skipped: 0, failed: 0 };
  try {
    const mine = new Map();
    const byEmail = await getDocs(query(collection(db, 'Files'), where('ownerEmail', '==', email)));
    byEmail.forEach((d) => mine.set(d.id, d));
    try {
      const byUid = await getDocs(query(collection(db, 'Files'), where('ownerUid', '==', uid)));
      byUid.forEach((d) => mine.set(d.id, d));
    } catch (error) {
      console.warn('migration: query by ownerUid failed', error);
    }
    for (const old of mine.values()) {
      const data = old.data();
      if (data.isFolder || data.sharedBy || data.sharedByUid) continue;
      const newPath = legacyNewPath(data.storagePath, uid);
      if (!newPath) continue;
      // Объект должен уже лежать по новому пути (его скопировали на сервере).
      try {
        await createSignedUrl(newPath, 60);
      } catch (error) {
        console.warn(`migration: skip ${old.id}: no object at ${newPath} (old record kept)`);
        stats.skipped += 1;
        continue;
      }
      const batch = writeBatch(db);
      batch.set(doc(db, 'Files', old.id + '_u'), legacyNewRecord(data, uid, email, newPath));
      batch.delete(old.ref);
      try {
        await batch.commit();
        stats.migrated += 1;
      } catch (error) {
        console.warn(`migration: ${old.id} failed (old record kept)`, error);
        stats.failed += 1;
      }
    }
    migrationDoneFor = uid;
    console.info('legacy migration', stats);
    return stats;
  } catch (error) {
    console.warn('legacy migration failed, will retry next session', error);
    return null;
  } finally {
    if (migrationRunningFor === uid) migrationRunningFor = null;
  }
}
