import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { MAX_STORAGE_BYTES, MAX_UPLOAD_BYTES } from './config.js';
import { auth } from './firebase.js';
import {
  authManager,
  hasEmailPasswordProvider,
  isValidEmail,
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
  validateNickname,
} from './auth.js';
import { UploadTooLargeError, uploadFile } from './storage.js';
import {
  applyFilter,
  childPath,
  createFolderRecord,
  deleteFileItem,
  deleteFolderRecord,
  fileKind,
  folderHasFiles,
  formatFileInfo,
  formatSize,
  getDisplayName,
  goUpPath,
  isInboxFolder,
  isReceived,
  loadIncomingShareItems,
  migrateLegacyFiles,
  isReservedFolderName,
  listenUserFiles,
  loadAccountStats,
  openFileUrl,
  pathTitle,
  searchUsersByNick,
  sendFileToUser,
  addFileRecord,
} from './files.js';

const PREFS_THEME = 'app_prefs_theme';
const PREFS_CONFIRM = 'app_prefs_confirm_delete';
const THEME_SYSTEM = 0;
const THEME_LIGHT = 1;
const THEME_DARK = 2;

const $ = (id) => document.getElementById(id);

const state = {
  view: 'home',
  allFiles: [],
  firestoreFiles: [],
  incomingShares: [],
  sharesRequestId: 0,
  currentFolder: '',
  filesUnsub: null,
  menuItem: null,
  registerMode: false,
  resendTimer: null,
};

function getTheme() {
  const raw = localStorage.getItem(PREFS_THEME);
  const n = raw == null ? THEME_SYSTEM : Number(raw);
  return Number.isFinite(n) ? n : THEME_SYSTEM;
}

function applyTheme(theme) {
  const dark =
    theme === THEME_DARK ||
    (theme !== THEME_LIGHT && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function setTheme(theme) {
  localStorage.setItem(PREFS_THEME, String(theme));
  applyTheme(theme);
}

function confirmDeleteEnabled() {
  const raw = localStorage.getItem(PREFS_CONFIRM);
  return raw == null ? true : raw === 'true';
}

function setConfirmDelete(value) {
  localStorage.setItem(PREFS_CONFIRM, value ? 'true' : 'false');
}

function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function setLoading(visible, label) {
  const overlay = $('loading-overlay');
  const text = $('loading-text');
  const track = $('loading-track');
  const bar = $('loading-bar');
  overlay.hidden = !visible;
  if (text) text.textContent = label || '';
  if (track) track.hidden = true;
  if (bar) bar.style.width = '0%';
}

function setUploadProgress(ratio) {
  const overlay = $('loading-overlay');
  const text = $('loading-text');
  const track = $('loading-track');
  const bar = $('loading-bar');
  overlay.hidden = false;
  const pct = Math.min(100, Math.round(ratio * 100));
  if (text) text.textContent = 'Загрузка… ' + pct + '%';
  if (track) track.hidden = false;
  if (bar) bar.style.width = pct + '%';
}

function setVisible(el, visible) {
  if (!el) return;
  el.hidden = !visible;
}

function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => {
    v.hidden = v.dataset.view !== name;
  });
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.nav === name);
  });
  if (name === 'home') refreshHome();
  if (name === 'profile') authManager.checkUserStatusAndRoute();
  if (name === 'settings') refreshSettings();
  const hash = '#' + name;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function hideAllProfileSteps() {
  [
    'layout-initial',
    'layout-email-login',
    'layout-verify-email',
    'layout-username',
    'layout-password',
    'layout-check-password',
    'layout-logged-in',
    'layout-dashboard',
  ].forEach((id) => setVisible($(id), false));
}

function showProfileStep(id, title, subtitle) {
  hideAllProfileSteps();
  const layout = $(id);
  setVisible(layout, true);
  const t = layout.querySelector('.profile-title');
  const s = layout.querySelector('.profile-subtitle');
  if (t && title) t.textContent = title;
  if (s && subtitle) s.textContent = subtitle;
}

authManager.setCallback({
  onShowLoading() {
    setLoading(true);
  },
  onHideLoading() {
    setLoading(false);
  },
  onNewUserRegistration(usernameAlreadySaved) {
    const user = auth.currentUser;
    if (!user) return;
    if (!usernameAlreadySaved) {
      showProfileStep(
        'layout-username',
        'Регистрация профиля',
        'Шаг 1: Придумайте уникальный никнейм',
      );
    } else if (!hasEmailPasswordProvider(user)) {
      showProfileStep(
        'layout-password',
        'Регистрация профиля',
        'Шаг 2: Установка дополнительного пароля',
      );
    } else {
      authManager.checkUserStatusAndRoute();
    }
  },
  onPasswordVerificationRequired() {
    showProfileStep('layout-check-password', 'Вход в систему', 'Введите дополнительный пароль защиты');
  },
  onUserAuthenticated(username, showDashboardImmediately) {
    setLoading(false);
    stopResendTimer();
    $('et-login-password').value = '';
    $('et-login-password-confirm').value = '';
    hideAllProfileSteps();
    bindAccountInfo(username);
    if (showDashboardImmediately) {
      showDashboard();
    } else {
      setVisible($('layout-logged-in'), true);
    }
    refreshHome();
    refreshSettings();
  },
  onUnauthenticated() {
    setLoading(false);
    hideAllProfileSteps();
    showProfileStep('layout-initial', 'Войдите в профиль', 'Выберите удобный способ для авторизации');
    stopFilesListener();
    state.currentFolder = '';
    state.allFiles = [];
    state.firestoreFiles = [];
    state.incomingShares = [];
    refreshHome();
    refreshSettings();
  },
  onError(message) {
    showToast(message);
  },
  onInfo(message) {
    showToast(message);
  },
  onEmailVerificationRequired(email) {
    setLoading(false);
    $('et-login-password').value = '';
    $('et-login-password-confirm').value = '';
    showProfileStep(
      'layout-verify-email',
      'Подтвердите почту',
      'Мы отправили письмо на ' + email +
        '. Перейдите по ссылке в письме, затем нажмите «Я подтвердил». Пока почта не подтверждена, файлы недоступны.',
    );
    if (state.view !== 'profile') showView('profile');
    startResendTimer();
    stopFilesListener();
    refreshHome();
    refreshSettings();
  },
});

// --- Вход и регистрация по почте ---

function showEmailLogin(register) {
  state.registerMode = register;
  setVisible($('row-login-password-confirm'), register);
  setVisible($('btn-forgot-password'), !register);
  setVisible($('tv-login-hint'), register);
  $('tv-login-hint').textContent =
    'Пароль — не короче ' + MIN_PASSWORD_LENGTH +
    ' символов. После регистрации мы пришлём письмо: почту нужно подтвердить, чтобы пользоваться файлами.';
  $('btn-login-submit').textContent = register ? 'Зарегистрироваться' : 'Войти';
  $('btn-toggle-register').textContent = register
    ? 'Уже есть аккаунт? Войти'
    : 'Нет аккаунта? Зарегистрироваться';
  $('et-login-password').autocomplete = register ? 'new-password' : 'current-password';
  showProfileStep(
    'layout-email-login',
    register ? 'Регистрация по почте' : 'Вход по почте',
    register ? 'Придумайте пароль для аккаунта' : 'Введите почту и пароль',
  );
}

function fieldError(input, message) {
  input.setCustomValidity(message);
  input.reportValidity();
  input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
}

function submitEmailLogin(event) {
  if (event) event.preventDefault();
  const emailInput = $('et-login-email');
  const passInput = $('et-login-password');
  const confirmInput = $('et-login-password-confirm');
  const email = emailInput.value.trim();
  const password = passInput.value;

  if (!isValidEmail(email)) {
    fieldError(emailInput, 'Введите корректный email');
    return;
  }
  if (state.registerMode) {
    const passError = validateNewPassword(password);
    if (passError) {
      fieldError(passInput, passError);
      return;
    }
    if (password !== confirmInput.value) {
      fieldError(confirmInput, 'Пароли не совпадают!');
      return;
    }
  } else if (!password) {
    fieldError(passInput, 'Введите пароль!');
    return;
  }
  const wait = authManager.cooldownSecondsLeft();
  if (wait > 0) {
    showToast('Слишком много неудачных попыток. Подождите ' + wait + ' с');
    return;
  }
  if (state.registerMode) authManager.signUpWithEmail(email, password);
  else authManager.signInWithEmail(email, password);
}

function onForgotPassword() {
  const emailInput = $('et-login-email');
  const email = emailInput.value.trim();
  if (!isValidEmail(email)) {
    fieldError(emailInput, 'Введите почту — на неё придёт ссылка для сброса пароля');
    return;
  }
  authManager.sendPasswordReset(email);
}

// --- Таймер повторной отправки письма ---

function stopResendTimer() {
  if (state.resendTimer) {
    clearInterval(state.resendTimer);
    state.resendTimer = null;
  }
}

function startResendTimer() {
  stopResendTimer();
  const btn = $('btn-verify-resend');
  const tick = () => {
    const left = authManager.verificationResendSecondsLeft();
    if (left <= 0) {
      btn.disabled = false;
      btn.style.opacity = '';
      btn.textContent = 'Отправить письмо ещё раз';
      stopResendTimer();
      return;
    }
    btn.disabled = true;
    btn.style.opacity = '0.55';
    btn.textContent = 'Отправить ещё раз через ' + left + ' с';
  };
  tick();
  if (authManager.verificationResendSecondsLeft() > 0) state.resendTimer = setInterval(tick, 1000);
}

function bindAccountInfo(username) {
  const user = auth.currentUser;
  $('tv-account-name').textContent = username || 'Пользователь';
  $('tv-account-email').textContent = (user && user.email) || '';
  $('tv-avatar-letter').textContent = username ? username.charAt(0).toUpperCase() : '?';
  if (user) {
    const uid = user.uid;
    $('tv-account-uid').textContent = 'ID: ' + (uid.length > 10 ? uid.slice(0, 10) + '…' : uid);
  }
}

function showDashboard() {
  hideAllProfileSteps();
  setVisible($('layout-dashboard'), true);
  setVisible($('card-nickname-conflict'), authManager.hasNicknameConflict());
  loadStats();
}

function showChangeNicknameDialog() {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field';
  input.maxLength = 20;
  input.placeholder = 'Новый ник (3–20 символов: буквы, цифры, _)';
  input.autocomplete = 'off';
  openDialog({
    title: 'Новый ник',
    node: input,
    confirmLabel: 'Сохранить',
    onConfirm: () => {
      const nick = input.value.trim();
      const error = validateNickname(nick);
      if (error) {
        showToast(error);
        return;
      }
      authManager.changeNickname(nick);
    },
    afterOpen: () => input.focus(),
  });
}

async function loadStats() {
  const user = auth.currentUser;
  if (!user || !user.email) return;
  try {
    const stats = await loadAccountStats(user.email);
    $('tv-stat-files').textContent = String(stats.count);
    $('tv-stat-size').textContent = formatSize(stats.total);
  } catch (error) {
    console.error(error);
  }
}

function refreshHome() {
  const loggedIn = authManager.loggedIn();
  setVisible($('layout-guest'), !loggedIn);
  setVisible($('layout-files'), loggedIn);
  if (loggedIn) {
    loadUserFiles();
  } else {
    state.currentFolder = '';
    stopFilesListener();
  }
}

function stopFilesListener() {
  if (state.filesUnsub) {
    state.filesUnsub();
    state.filesUnsub = null;
  }
}

function loadUserFiles() {
  const user = auth.currentUser;
  if (!user || !user.email) return;
  // Перенос старых записей на users/<uid>/... (один раз за сессию, в фоне).
  migrateLegacyFiles();
  stopFilesListener();
  state.filesUnsub = listenUserFiles(
    user.email,
    (items, totalSize) => {
      state.firestoreFiles = items;
      updateStorageInfo(totalSize);
      mergeFiles();
    },
    (error) => {
      console.error(error);
      showToast('Ошибка загрузки списка: ' + (error.message || error));
    },
  );
  loadIncomingShares();
}

function mergeFiles() {
  state.allFiles = state.firestoreFiles.concat(state.incomingShares);
  renderFiles();
}

/** Входящие файлы из Supabase public.shares (recipient_uid = мой UID). */
async function loadIncomingShares() {
  const requestId = ++state.sharesRequestId;
  try {
    const items = await loadIncomingShareItems();
    if (requestId !== state.sharesRequestId || !authManager.loggedIn()) return;
    state.incomingShares = items;
    mergeFiles();
  } catch (error) {
    // Таблица недоступна — показываем только свои файлы.
    console.warn('incoming shares failed', error);
  }
}

function updateStorageInfo(usedBytes) {
  const percent = Math.min(100, Math.floor((usedBytes * 100) / MAX_STORAGE_BYTES));
  $('tv-storage-used').textContent = 'Использовано ' + formatSize(usedBytes) + ' из 1 ГБ';
  $('tv-storage-percent').textContent = percent + '%';
  $('progress-storage').style.width = percent + '%';
  $('progress-storage').parentElement.setAttribute('aria-valuenow', String(percent));
}

function renderFiles() {
  const queryText = $('et-search-files').value;
  const shown = applyFilter(state.allFiles, state.currentFolder, queryText);
  const list = $('rv-files');
  list.replaceChildren();

  $('tv-files-title').textContent = pathTitle(state.currentFolder);
  setVisible($('btn-folder-up'), !!state.currentFolder);

  const empty = shown.length === 0;
  setVisible($('layout-empty-files'), empty);
  setVisible(list, !empty);

  for (const item of shown) {
    list.appendChild(renderFileRow(item));
  }
}

function iconSvg(kind) {
  const icons = {
    folder:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>',
    inbox:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 3H5a2 2 0 0 0-2 2v14l4-4h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>',
    image:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
    video:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 10.5V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5l4 4v-11l-4 4z"/></svg>',
    pdf:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm1 13h-2v2h-2v-2H9v-2h2v-2h2v2h2v2zm-1-6V3.5L18.5 9H14z"/></svg>',
    zip:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 6h-8l-2-2H4a2 2 0 0 0-1.99 2L2 18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-2 6h-2v2h2v2h-2v2h-2v-2h2v-2h-2v-2h2v-2h-2V8h2v2h2v2z"/></svg>',
    audio:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 15a3 3 0 1 1-2-2.83V9h4v2h-2v5.17c.31-.11.65-.17 1-.17z"/></svg>',
    file:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>',
  };
  return icons[kind] || icons.file;
}

function renderFileRow(item) {
  const row = document.createElement('article');
  row.className = 'file-row';
  row.tabIndex = 0;

  const iconWrap = document.createElement('div');
  iconWrap.className = 'file-icon';
  const kind = item.isFolder ? (isInboxFolder(item) ? 'inbox' : 'folder') : fileKind(item.contentType);
  iconWrap.innerHTML = iconSvg(kind);

  const meta = document.createElement('div');
  meta.className = 'file-meta';
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = getDisplayName(item);
  const info = document.createElement('div');
  info.className = 'file-info';
  info.textContent = formatFileInfo(item);
  meta.append(name, info);

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'icon-btn file-menu-btn';
  menuBtn.setAttribute('aria-label', 'Меню файла');
  menuBtn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';

  row.append(iconWrap, meta, menuBtn);

  const open = () => {
    hideMenus();
    if (item.isFolder) {
      state.currentFolder = childPath(item);
      renderFiles();
    } else {
      openStoredFile(item);
    }
  };

  row.addEventListener('click', (event) => {
    if (event.target.closest('.file-menu-btn')) return;
    open();
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  menuBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    showItemMenu(item, menuBtn);
  });

  return row;
}

function hideMenus() {
  $('item-menu').hidden = true;
  $('add-menu').hidden = true;
  state.menuItem = null;
}

function placeMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.hidden = false;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = rect.right - mw;
  let top = rect.bottom + 6;
  if (left < 8) left = 8;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = rect.top - mh - 6;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function showItemMenu(item, anchor) {
  const menu = $('item-menu');
  menu.replaceChildren();
  state.menuItem = item;

  const add = (label, action) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-item';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      hideMenus();
      action();
    });
    menu.appendChild(btn);
  };

  if (item.isFolder) {
    if (!isInboxFolder(item)) add('Удалить', () => confirmDelete(item));
  } else {
    add('Скачать', () => openStoredFile(item));
    if (!isReceived(item)) add('Отправить', () => showSendDialog(item));
    add('Удалить', () => confirmDelete(item));
  }

  if (!menu.childElementCount) {
    menu.hidden = true;
    return;
  }
  placeMenu(menu, anchor);
}

async function openStoredFile(item) {
  try {
    setLoading(true, 'Открытие файла…');
    const url = await openFileUrl(item);
    setLoading(false);
    if (!url) {
      showToast('Не удалось получить ссылку на файл');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    console.error(error);
    setLoading(false);
    showToast(error && error.code === 'untrusted-url' ? error.message : 'Не удалось получить ссылку на файл');
  }
}

function confirmDelete(item) {
  if (!confirmDeleteEnabled()) {
    deleteItem(item);
    return;
  }
  openDialog({
    title: item.isFolder ? 'Удалить папку?' : 'Удалить файл?',
    body: getDisplayName(item),
    confirmLabel: 'Удалить',
    danger: true,
    onConfirm: () => deleteItem(item),
  });
}

async function deleteItem(item) {
  if (item.isFolder) {
    if (folderHasFiles(state.allFiles, item)) {
      showToast('Сначала удалите файлы внутри папки');
      return;
    }
    try {
      await deleteFolderRecord(item);
      showToast('Папка удалена');
    } catch (error) {
      if (error && error.code === 'empty-folder') {
        showToast('Папка пустая');
        return;
      }
      console.error(error);
      showToast('Не удалось удалить папку');
    }
    return;
  }

  setLoading(true);
  try {
    await deleteFileItem(item);
    if (item.shareId) {
      state.incomingShares = state.incomingShares.filter((x) => x.shareId !== item.shareId);
      mergeFiles();
    }
    setLoading(false);
    showToast('Файл удалён');
  } catch (error) {
    console.error(error);
    setLoading(false);
    showToast(error.message === 'Ошибка удаления файла из Storage'
      ? error.message
      : item.shareId ? 'Не удалось удалить файл' : 'Ошибка удаления из БД');
  }
}

function showAddMenu(anchor) {
  if (isReservedFolderName(state.currentFolder) || state.currentFolder.includes('/!')) {
    $('file-input').click();
    return;
  }
  const menu = $('add-menu');
  placeMenu(menu, anchor);
}

function showCreateFolderDialog() {
  if (isReservedFolderName(state.currentFolder)) {
    showToast('Сюда нельзя создавать папки');
    return;
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field';
  input.placeholder = 'Название папки';
  input.autocomplete = 'off';
  openDialog({
    title: 'Новая папка',
    node: input,
    confirmLabel: 'Создать',
    cancelLabel: 'Отмена',
    onConfirm: () => createFolder(input.value.trim()),
    afterOpen: () => input.focus(),
  });
}

async function createFolder(name) {
  const user = auth.currentUser;
  if (!user || !user.email) return;
  if (!name) {
    showToast('Введите название');
    return;
  }
  if (name.includes('/')) {
    showToast('Нельзя использовать / в названии');
    return;
  }
  if (isReservedFolderName(name)) {
    showToast('Название не может начинаться с ' + '!');
    return;
  }
  const exists = state.allFiles.some(
    (item) => item.isFolder && state.currentFolder === (item.parent || '') && name === item.name,
  );
  if (exists) {
    showToast('Такая папка уже есть');
    return;
  }
  try {
    await createFolderRecord(name, state.currentFolder, user.email);
    showToast('Папка создана');
  } catch (error) {
    console.error(error);
    showToast('Не удалось создать папку');
  }
}

async function handleUpload(file) {
  const user = auth.currentUser;
  if (!user || !user.email) {
    showToast('Вы не авторизованы');
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    showToast('Файл слишком большой, максимум 50 МБ');
    return;
  }
  setUploadProgress(0);
  let result;
  try {
    result = await uploadFile(file, setUploadProgress);
  } catch (error) {
    console.error(error);
    setLoading(false);
    if (error instanceof UploadTooLargeError) {
      showToast(error.message);
      return;
    }
    showToast('Ошибка загрузки файла');
    return;
  }
  try {
    await addFileRecord(file, result, user.email, state.currentFolder);
    setLoading(false);
    showToast('Файл успешно загружен');
  } catch (error) {
    console.error(error);
    setLoading(false);
    showToast('Ошибка сохранения метаданных: ' + (error.message || error));
  }
}

function showSendDialog(file) {
  const wrap = document.createElement('div');
  wrap.className = 'share-dialog';

  const row = document.createElement('div');
  row.className = 'share-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field';
  input.placeholder = 'Ник пользователя';
  input.autocomplete = 'off';
  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'btn btn-primary';
  searchBtn.textContent = 'Найти';
  row.append(input, searchBtn);

  const empty = document.createElement('p');
  empty.className = 'muted center';
  empty.textContent = 'Введите точный ник';

  const results = document.createElement('div');
  results.className = 'user-hits';
  results.hidden = true;

  wrap.append(row, empty, results);

  const dialog = openDialog({
    title: 'Отправить «' + file.name + '»',
    node: wrap,
    cancelLabel: 'Закрыть',
    hideConfirm: true,
    afterOpen: () => input.focus(),
  });

  const runSearch = async () => {
    const nick = input.value.trim();
    if (!nick) {
      input.focus();
      showToast('Введите ник');
      return;
    }
    const me = auth.currentUser;
    try {
      const hits = await searchUsersByNick(nick, me && me.email, me && me.uid);
      results.replaceChildren();
      if (!hits.length) {
        empty.hidden = false;
        empty.textContent = 'Пользователь не найден';
        results.hidden = true;
        return;
      }
      empty.hidden = true;
      results.hidden = false;
      for (const hit of hits) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'user-hit';
        // Показываем только ник — почту других пользователей не раскрываем.
        const n = document.createElement('strong');
        n.textContent = hit.username;
        btn.append(n);
        btn.addEventListener('click', () => {
          dialog.close();
          sendTo(file, hit);
        });
        results.appendChild(btn);
      }
    } catch (error) {
      console.error(error);
      showToast('Ошибка поиска: ' + (error.message || error));
    }
  };

  searchBtn.addEventListener('click', runSearch);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    }
  });
}

async function sendTo(file, hit) {
  const me = auth.currentUser;
  if (!me) return;
  setLoading(true);
  try {
    await sendFileToUser(file, hit);
    setLoading(false);
    showToast('Отправлено @' + hit.username);
  } catch (error) {
    console.error(error);
    setLoading(false);
    if (error && error.code === 'already-shared') {
      showToast('Этот файл уже отправлен @' + hit.username);
      return;
    }
    showToast(error && error.message ? error.message : 'Не удалось отправить файл');
  }
}

function openDialog({
  title,
  body,
  node,
  confirmLabel = 'OK',
  cancelLabel = 'Отмена',
  hideConfirm = false,
  danger = false,
  onConfirm,
  afterOpen,
}) {
  const backdrop = $('dialog-backdrop');
  const titleEl = $('dialog-title');
  const bodyEl = $('dialog-body');
  const confirmBtn = $('dialog-confirm');
  const cancelBtn = $('dialog-cancel');

  titleEl.textContent = title || '';
  bodyEl.replaceChildren();
  if (body) {
    const p = document.createElement('p');
    p.textContent = body;
    bodyEl.appendChild(p);
  }
  if (node) bodyEl.appendChild(node);

  confirmBtn.hidden = hideConfirm;
  confirmBtn.textContent = confirmLabel;
  confirmBtn.classList.toggle('btn-danger', !!danger);
  confirmBtn.classList.toggle('btn-primary', !danger);
  cancelBtn.textContent = cancelLabel;

  backdrop.hidden = false;

  const close = () => {
    backdrop.hidden = true;
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
  };

  cancelBtn.onclick = close;
  confirmBtn.onclick = () => {
    close();
    if (typeof onConfirm === 'function') onConfirm();
  };

  if (typeof afterOpen === 'function') afterOpen();
  return { close };
}

function refreshSettings() {
  const theme = getTheme();
  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.checked = Number(input.value) === theme;
  });
  $('sw-confirm-delete').checked = confirmDeleteEnabled();
  setVisible($('btn-settings-logout'), !!auth.currentUser);
}

function clearAuthFields() {
  $('et-username').value = '';
  $('et-mfa-pass').value = '';
  $('et-mfa-pass-confirm').value = '';
  $('et-check-pass').value = '';
  $('et-login-email').value = '';
  $('et-login-password').value = '';
  $('et-login-password-confirm').value = '';
}

function bindUi() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.nav));
  });

  $('btn-login').addEventListener('click', () => showView('profile'));
  $('btn-login-google').addEventListener('click', () => authManager.signInWithGoogle());
  $('btn-login-email').addEventListener('click', () => showEmailLogin(false));
  $('layout-email-login').addEventListener('submit', submitEmailLogin);
  $('btn-toggle-register').addEventListener('click', () => showEmailLogin(!state.registerMode));
  $('btn-forgot-password').addEventListener('click', onForgotPassword);
  $('btn-login-back').addEventListener('click', () => authManager.checkUserStatusAndRoute());
  $('btn-verify-done').addEventListener('click', () => authManager.reloadAndCheckEmailVerified());
  $('btn-verify-resend').addEventListener('click', () => authManager.resendVerificationEmail());
  $('btn-verify-logout').addEventListener('click', () => {
    stopResendTimer();
    authManager.signOut(clearAuthFields);
  });

  $('btn-next-username').addEventListener('click', () => {
    const username = $('et-username').value.trim();
    if (!username) {
      $('et-username').setCustomValidity('Введите никнейм!');
      $('et-username').reportValidity();
      return;
    }
    const nickError = validateNickname(username);
    if (nickError) {
      $('et-username').setCustomValidity(nickError);
      $('et-username').reportValidity();
      return;
    }
    $('et-username').setCustomValidity('');
    authManager.saveUsername(username);
  });

  $('btn-save-password').addEventListener('click', () => {
    const pass = $('et-mfa-pass').value;
    const confirm = $('et-mfa-pass-confirm').value;
    const passError = validateNewPassword(pass);
    if (passError) {
      $('et-mfa-pass').setCustomValidity(passError);
      $('et-mfa-pass').reportValidity();
      return;
    }
    $('et-mfa-pass').setCustomValidity('');
    if (pass !== confirm) {
      $('et-mfa-pass-confirm').setCustomValidity('Пароли не совпадают!');
      $('et-mfa-pass-confirm').reportValidity();
      return;
    }
    $('et-mfa-pass-confirm').setCustomValidity('');
    authManager.linkPassword(pass);
  });

  $('btn-skip-password').addEventListener('click', () => authManager.checkUserStatusAndRoute());

  $('btn-verify-password').addEventListener('click', () => {
    const pass = $('et-check-pass').value;
    if (!pass) {
      $('et-check-pass').setCustomValidity('Введите пароль!');
      $('et-check-pass').reportValidity();
      return;
    }
    $('et-check-pass').setCustomValidity('');
    authManager.verifyPassword(pass);
  });

  $('btn-done').addEventListener('click', showDashboard);
  $('btn-change-nickname').addEventListener('click', showChangeNicknameDialog);
  $('btn-logout').addEventListener('click', () => authManager.signOut(clearAuthFields));
  $('btn-open-files').addEventListener('click', () => showView('home'));
  $('btn-open-storage').addEventListener('click', () => showView('home'));

  $('btn-settings-logout').addEventListener('click', () => {
    authManager.signOut(() => {
      clearAuthFields();
      showToast('Вы вышли из аккаунта');
      showView('profile');
    });
  });

  $('btn-clear-cache').addEventListener('click', () => {
    showToast('Кэш очищен');
  });

  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) setTheme(Number(input.value));
    });
  });

  $('sw-confirm-delete').addEventListener('change', (event) => {
    setConfirmDelete(event.target.checked);
  });

  $('btn-folder-up').addEventListener('click', () => {
    state.currentFolder = goUpPath(state.currentFolder);
    renderFiles();
  });

  $('et-search-files').addEventListener('input', renderFiles);

  $('fab-add-file').addEventListener('click', (event) => {
    event.stopPropagation();
    showAddMenu(event.currentTarget);
  });

  $('add-file-option').addEventListener('click', () => {
    hideMenus();
    $('file-input').click();
  });
  $('add-folder-option').addEventListener('click', () => {
    hideMenus();
    showCreateFolderDialog();
  });

  $('file-input').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) handleUpload(file);
  });

  $('dialog-backdrop').addEventListener('click', (event) => {
    if (event.target === $('dialog-backdrop')) $('dialog-backdrop').hidden = true;
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.popover') && !event.target.closest('#fab-add-file') && !event.target.closest('.file-menu-btn')) {
      hideMenus();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideMenus();
      $('dialog-backdrop').hidden = true;
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === THEME_SYSTEM) applyTheme(THEME_SYSTEM);
  });
}

function boot() {
  applyTheme(getTheme());
  bindUi();
  const initial = (location.hash || '#home').slice(1);
  showView(['home', 'settings', 'profile'].includes(initial) ? initial : 'home');
  setLoading(true);

  onAuthStateChanged(auth, () => {
    if (auth.currentUser) {
      authManager.checkUserStatusAndRoute();
    } else if (!authManager.loggedIn()) {
      authManager.callback && authManager.callback.onUnauthenticated();
    } else {
      setLoading(false);
    }
  });
}

boot();
