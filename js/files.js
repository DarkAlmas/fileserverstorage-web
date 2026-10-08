/**
 * Модель FileItem и операции с коллекцией Files — как в Android-приложении.
 */
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { MAX_STORAGE_BYTES, SIGNED_URL_TTL_OPEN, SIGNED_URL_TTL_UPLOAD } from './config.js';
import { auth, db } from './firebase.js';
import { createSignedUrl, deleteStoredFile } from './storage.js';

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
        if (!item.isFolder) totalSize += item.size;
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
  const received = isReceived(item);
  if (!received && item.storagePath) {
    try {
      await deleteStoredFile(item.storagePath);
    } catch (error) {
      const err = new Error('Ошибка удаления файла из Storage');
      err.cause = error;
      throw err;
    }
  }
  await deleteDoc(doc(db, 'Files', item.id));
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
 * Поиск по нику. Email нужен только для записи Files.ownerEmail получателя —
 * в интерфейсе показывается только ник. Старый (Users/{email}) и новый
 * (Users/{uid}) документ одного человека дают один результат.
 */
export async function searchUsersByNick(nick, myEmail, myUid) {
  const snap = await getDocs(
    query(collection(db, 'Users'), where('userName', '==', nick), limit(20)),
  );
  const hits = [];
  const seen = new Set();
  snap.forEach((d) => {
    const data = d.data();
    const email = data.email || (d.id.includes('@') ? d.id : null);
    if (!email) return;
    const uid = data.uid || null;
    if (myEmail && email.toLowerCase() === myEmail.toLowerCase()) return;
    if (myUid && uid === myUid) return;
    const key = uid || email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ email, uid, username: data.displayName || data.userName || 'Пользователь' });
  });
  return hits;
}

export async function sendFileToUser(file, hit, myEmail, senderName) {
  if (!file.storagePath) {
    throw new Error('Не удалось получить ссылку на файл');
  }
  let signedUrl;
  try {
    signedUrl = await createSignedUrl(file.storagePath, SIGNED_URL_TTL_UPLOAD);
  } catch (error) {
    throw new Error('Не удалось получить ссылку на файл');
  }
  await addDoc(collection(db, 'Files'), {
    name: file.name,
    storagePath: file.storagePath,
    downloadUrl: signedUrl,
    size: file.size,
    uploadedAt: Date.now(),
    ownerEmail: hit.email,
    ownerUid: hit.uid || null,
    contentType: file.contentType,
    // Папка у получателя «От: <ник>» — email отправителя не показываем.
    parent: inboxFolderFor(String(senderName || 'пользователя').replace(/\//g, '_')),
    isFolder: false,
    sharedBy: myEmail,
    sharedByUid: auth.currentUser ? auth.currentUser.uid : null,
  });
}

export async function openFileUrl(item) {
  if (!isReceived(item) && item.storagePath) {
    return createSignedUrl(item.storagePath, SIGNED_URL_TTL_OPEN);
  }
  return item.downloadUrl || null;
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

