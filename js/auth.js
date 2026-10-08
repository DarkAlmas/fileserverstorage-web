/**
 * Порт auth/AuthManager.java: Google Sign-In, Email + пароль, документ Users.
 *
 * Подтверждение почты обязательно: пока user.emailVerified === false, доступ к
 * файлам закрыт (onEmailVerificationRequired). После подтверждения ID-токен
 * обновляется через getIdToken(true), чтобы в нём был email_verified = true.
 *
 * Документы Users хранятся по UID (Users/{uid}). Старый документ Users/{email}
 * при входе копируется в Users/{uid} и не удаляется.
 *
 * Ники уникальны: Usernames/{ник в нижнем регистре} = { uid, userName, createdAt }.
 * Ник занимается в одной транзакции с профилем. Если при переносе старого профиля ник
 * уже занят другим человеком, вход продолжается, но в профиле предлагается выбрать
 * новый ник (nicknameConflict = true).
 */
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  linkWithCredential,
  reauthenticateWithCredential,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  deleteField,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { auth, db } from './firebase.js';

export const USERS = 'Users';
export const USERNAMES = 'Usernames';
/** Users/{uid}/private/profile: почта и служебные поля, читает только владелец. */
export const PRIVATE = 'private';
export const PRIVATE_PROFILE = 'profile';
const NICK_TAKEN = 'nickname-taken';
const NICKNAME_RE = /^[A-Za-zА-Яа-яЁё0-9_]{3,20}$/;

/** null — ник подходит; иначе текст ошибки. */
export function validateNickname(nickname) {
  const n = String(nickname || '').trim();
  if (n.length < 3 || n.length > 20) return 'Ник должен быть от 3 до 20 символов';
  if (!NICKNAME_RE.test(n)) return 'В нике можно использовать только буквы, цифры и _';
  return null;
}

/** Ключ документа Usernames: без учёта регистра. */
export function nicknameKey(nickname) {
  return String(nickname).trim().toLowerCase();
}

function claimData(user, nickname) {
  return { uid: user.uid, userName: String(nickname).trim(), createdAt: serverTimestamp() };
}

function nickTakenError() {
  const err = new Error('Этот ник уже занят');
  err.code = NICK_TAKEN;
  return err;
}
export const MIN_PASSWORD_LENGTH = 8;
export const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

const MAX_FAILED_ATTEMPTS = 5;
const FAILED_COOLDOWN_MS = 60 * 1000;

export function hasEmailPasswordProvider(user) {
  return (user.providerData || []).some((info) => info.providerId === EmailAuthProvider.PROVIDER_ID);
}

export function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** null — пароль подходит, иначе текст ошибки. */
export function validateNewPassword(password) {
  if (!password) return 'Введите пароль';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return 'Пароль должен быть не короче ' + MIN_PASSWORD_LENGTH + ' символов';
  }
  if (password.trim() === '') return 'Пароль не может состоять из одних пробелов';
  return null;
}

/** Почта не подтверждена — доступ к файлам закрыт. Google-аккаунты уже подтверждены. */
export function needsEmailVerification(user) {
  return !!(user && user.email && !user.emailVerified);
}

/** Ключ владельца файлов (поле Files.ownerEmail) — email, как и раньше. */
export function ownerKey(user) {
  return user ? user.email : null;
}

function providerIds(user) {
  const list = [];
  for (const info of user.providerData || []) {
    if (info.providerId !== 'firebase' && !list.includes(info.providerId)) list.push(info.providerId);
  }
  return list;
}

/** Понятные сообщения об ошибках Firebase. */
export function describeAuthError(error, fallback) {
  const code = (error && error.code) || '';
  const map = {
    'auth/operation-not-allowed': 'Вход по почте и паролю не включён в настройках Firebase',
    'auth/network-request-failed': 'Нет соединения с интернетом',
    'auth/too-many-requests': 'Слишком много попыток. Попробуйте позже',
    'auth/weak-password': 'Слишком простой пароль: минимум ' + MIN_PASSWORD_LENGTH + ' символов',
    'auth/email-already-in-use': 'Этот email уже зарегистрирован. Войдите или восстановите пароль',
    'auth/requires-recent-login': 'Для этого действия выйдите и войдите в аккаунт заново',
    'auth/user-not-found': 'Неверный email или пароль',
    'auth/wrong-password': 'Неверный email или пароль',
    'auth/invalid-credential': 'Неверный email или пароль',
    'auth/invalid-email': 'Неверный формат email',
    'auth/user-disabled': 'Аккаунт отключён',
  };
  return map[code] || fallback;
}

export class AuthManager {
  constructor() {
    this.callback = null;
    this.isLoggedIn = false;
    this.currentUsername = '';
    this.isFirstLoginAfterAppStart = true;
    this.failedAttempts = 0;
    this.lockedUntil = 0;
    this.lastVerificationSentAt = 0;
    this.nicknameConflict = false;
  }

  /** Ник из старого профиля занят другим — нужно выбрать новый. */
  hasNicknameConflict() {
    return this.nicknameConflict;
  }

  setCallback(callback) {
    this.callback = callback;
  }

  getCurrentUsername() {
    return this.currentUsername || null;
  }

  /** Вошёл и подтвердил почту — можно пускать к файлам. */
  loggedIn() {
    return this.isLoggedIn && !needsEmailVerification(auth.currentUser);
  }

  // --- Ограничение неудачных попыток (дополнительно к защите Firebase) ---

  cooldownSecondsLeft() {
    const left = this.lockedUntil - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  checkCooldown() {
    const left = this.cooldownSecondsLeft();
    if (left > 0) {
      if (this.callback) this.callback.onError('Слишком много неудачных попыток. Подождите ' + left + ' с');
      return false;
    }
    return true;
  }

  registerFailure(error) {
    if (error && error.code === 'auth/network-request-failed') return;
    this.failedAttempts += 1;
    if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      this.failedAttempts = 0;
      this.lockedUntil = Date.now() + FAILED_COOLDOWN_MS;
    }
  }

  registerSuccess() {
    this.failedAttempts = 0;
    this.lockedUntil = 0;
  }

  // --- Google ---

  async signInWithGoogle() {
    if (auth.currentUser) {
      await this.checkUserStatusAndRoute();
      return;
    }
    const cb = this.callback;
    if (!cb) return;
    cb.onShowLoading();
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope('email');
      provider.setCustomParameters({ prompt: 'select_account' });
      const result = await signInWithPopup(auth, provider);
      if (!result.user) {
        cb.onHideLoading();
        cb.onError('Ошибка авторизации в Firebase');
        return;
      }
      await this.checkUserStatusAndRoute();
    } catch (error) {
      cb.onHideLoading();
      if (
        error &&
        (error.code === 'auth/popup-closed-by-user' ||
          error.code === 'auth/cancelled-popup-request')
      ) {
        return;
      }
      console.error('Google Sign-In failed', error);
      cb.onError('Ошибка авторизации Google');
    }
  }

  // --- Email + пароль ---

  async signInWithEmail(email, password) {
    if (!this.checkCooldown()) return;
    const cb = this.callback;
    if (!cb) return;
    cb.onShowLoading();
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      this.registerSuccess();
      // Пароль только что введён — «пароль защиты» повторно не спрашиваем.
      this.isFirstLoginAfterAppStart = true;
      await this.checkUserStatusAndRoute();
    } catch (error) {
      this.registerFailure(error);
      console.error('signInWithEmail failed', error);
      cb.onHideLoading();
      cb.onError(describeAuthError(error, 'Не удалось войти'));
    }
  }

  async signUpWithEmail(email, password) {
    if (!this.checkCooldown()) return;
    const cb = this.callback;
    if (!cb) return;
    const passwordError = validateNewPassword(password);
    if (passwordError) {
      cb.onError(passwordError);
      return;
    }
    cb.onShowLoading();
    try {
      const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
      this.registerSuccess();
      this.isFirstLoginAfterAppStart = true;
      try {
        await sendEmailVerification(result.user);
        this.lastVerificationSentAt = Date.now();
      } catch (sent) {
        console.error('sendEmailVerification failed', sent);
        cb.onError(describeAuthError(sent, 'Не удалось отправить письмо'));
      }
      await this.checkUserStatusAndRoute();
    } catch (error) {
      console.error('signUpWithEmail failed', error);
      cb.onHideLoading();
      cb.onError(describeAuthError(error, 'Не удалось зарегистрироваться'));
    }
  }

  async sendPasswordReset(email) {
    const cb = this.callback;
    if (!cb) return;
    cb.onShowLoading();
    try {
      await sendPasswordResetEmail(auth, email.trim());
      cb.onHideLoading();
      cb.onInfo('Если аккаунт с такой почтой есть, мы отправили письмо со ссылкой для сброса пароля');
    } catch (error) {
      console.error('sendPasswordResetEmail failed', error);
      cb.onHideLoading();
      cb.onError(describeAuthError(error, 'Не удалось отправить письмо'));
    }
  }

  // --- Подтверждение почты ---

  verificationResendSecondsLeft() {
    if (!this.lastVerificationSentAt) return 0;
    const left = this.lastVerificationSentAt + VERIFICATION_RESEND_COOLDOWN_MS - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  async resendVerificationEmail() {
    const user = auth.currentUser;
    const cb = this.callback;
    if (!user || !cb) return;
    const left = this.verificationResendSecondsLeft();
    if (left > 0) {
      cb.onError('Письмо можно отправить ещё раз через ' + left + ' с');
      return;
    }
    cb.onShowLoading();
    try {
      await sendEmailVerification(user);
      this.lastVerificationSentAt = Date.now();
      cb.onHideLoading();
      cb.onInfo('Письмо отправлено. Если его нет, проверьте папку «Спам»');
      cb.onEmailVerificationRequired(user.email || '');
    } catch (error) {
      cb.onHideLoading();
      cb.onError(describeAuthError(error, 'Не удалось отправить письмо'));
    }
  }

  /**
   * «Я подтвердил»: перечитываем профиль (reload), затем принудительно обновляем
   * ID-токен (getIdToken(true)), чтобы в нём был email_verified = true, и продолжаем вход.
   */
  async reloadAndCheckEmailVerified() {
    const cb = this.callback;
    let user = auth.currentUser;
    if (!cb || !user) return;
    cb.onShowLoading();
    try {
      await user.reload();
      user = auth.currentUser;
      if (!user) {
        cb.onHideLoading();
        this.resetSession();
        cb.onUnauthenticated();
        return;
      }
      if (!user.emailVerified) {
        cb.onHideLoading();
        cb.onError('Почта ещё не подтверждена. Откройте ссылку из письма и нажмите кнопку снова');
        return;
      }
      try {
        await user.getIdToken(true);
      } catch (error) {
        console.error('token refresh failed', error);
      }
      await this.checkUserStatusAndRoute();
    } catch (error) {
      cb.onHideLoading();
      cb.onError(describeAuthError(error, 'Не удалось проверить почту'));
    }
  }

  // --- Маршрутизация и документ Users ---

  async checkUserStatusAndRoute() {
    const cb = this.callback;
    if (!cb) return;

    const user = auth.currentUser;
    if (!user) {
      this.resetSession();
      cb.onUnauthenticated();
      return;
    }

    if (needsEmailVerification(user)) {
      this.isLoggedIn = false;
      cb.onHideLoading();
      cb.onEmailVerificationRequired(user.email || '');
      return;
    }

    if (this.isLoggedIn && this.currentUsername) {
      cb.onUserAuthenticated(this.currentUsername, true);
      return;
    }

    cb.onShowLoading();
    try {
      const data = await this.loadOrMigrateUserDocument(user);
      cb.onHideLoading();
      this.routeAfterUserDocument(user, data);
    } catch (error) {
      console.error('checkUserStatusAndRoute', error);
      cb.onHideLoading();
      cb.onError('Ошибка проверки данных сервера');
    }
  }

  userDoc(user) {
    return doc(db, USERS, user.uid);
  }

  /**
   * Читает Users/{uid}. Если его нет, но есть старый Users/{email} — копирует данные
   * в Users/{uid} (старый документ остаётся на месте).
   */
  async loadOrMigrateUserDocument(user) {
    const snap = await getDoc(this.userDoc(user));
    if (snap.exists()) {
      const data = snap.data();
      const name = typeof data.userName === 'string' ? data.userName : '';
      if (!name || data.nicknameClaimed === true) {
        this.nicknameConflict = false;
        await this.upsertUserProfile(user, null).catch((e) => console.warn('upsertUserProfile', e));
        return data;
      }
      // Профиль есть, но ник ещё не закреплён в Usernames — закрепляем.
      this.writePrivateProfile(user);
      await this.writeProfileClaimingNickname(user, this.profileFields(user), name);
      return data;
    }
    if (!user.email) return null;

    let legacy = null;
    try {
      legacy = await getDoc(doc(db, USERS, user.email));
    } catch (error) {
      console.warn('legacy user doc read failed', error);
    }
    if (!legacy || !legacy.exists()) return null;

    // Из старого документа берём только ник: остальные поля (в т.ч. почта)
    // в публичный профиль не попадают — правила разрешают лишь публичные ключи.
    const merged = {
      ...this.profileFields(user),
      migratedFromEmailDoc: true,
      createdAt: serverTimestamp(),
    };
    this.writePrivateProfile(user);
    const legacyName = legacy.data().userName;
    const name = typeof legacyName === 'string' ? legacyName : '';
    if (!name) {
      // Ника в старом профиле нет — человек выберет его на шаге регистрации.
      await setDoc(this.userDoc(user), merged, { merge: true }).catch((e) =>
        console.warn('migration write failed', e),
      );
      return null;
    }
    merged.userName = name;
    merged.displayName = name;
    merged.userNameLower = nicknameKey(name);
    await this.writeProfileClaimingNickname(user, merged, name);
    return legacy.data();
  }

  /**
   * Транзакция: занимает Usernames/{ник} (если свободен) и пишет профиль Users/{uid}.
   * Если ник занят другим (или не подходит по формату) — nicknameConflict = true.
   * Ошибки не прерывают вход.
   */
  async writeProfileClaimingNickname(user, profile, nickname) {
    const validFormat = validateNickname(nickname) === null;
    const claimRef = doc(db, USERNAMES, nicknameKey(nickname));
    try {
      const conflict = await runTransaction(db, async (tx) => {
        let isConflict = true;
        let claimNow = false;
        if (validFormat) {
          const claim = await tx.get(claimRef);
          if (!claim.exists()) {
            claimNow = true;
            isConflict = false;
          } else {
            isConflict = claim.data().uid !== user.uid;
          }
        }
        if (claimNow) tx.set(claimRef, claimData(user, nickname));
        tx.set(
          this.userDoc(user),
          { ...profile, nicknameConflict: isConflict, nicknameClaimed: !isConflict },
          { merge: true },
        );
        return isConflict;
      });
      this.nicknameConflict = conflict;
    } catch (error) {
      console.warn('nickname claim failed', error);
    }
  }

  /**
   * Базовые поля ПУБЛИЧНОГО профиля Users/{uid}. Почты здесь нет: правила разрешают только
   * uid, userName, displayName, userNameLower, nicknameClaimed, nicknameConflict, createdAt,
   * migratedFromEmailDoc. Поля от тестовых сборок (email, providers, lastLoginAt) удаляются.
   */
  profileFields(user) {
    return {
      uid: user.uid,
      email: deleteField(),
      providers: deleteField(),
      lastLoginAt: deleteField(),
    };
  }

  /** Приватный документ Users/{uid}/private/profile — почта хранится только здесь. */
  privateDoc(user) {
    return doc(db, USERS, user.uid, PRIVATE, PRIVATE_PROFILE);
  }

  writePrivateProfile(user) {
    return setDoc(
      this.privateDoc(user),
      { email: user.email || null, providers: providerIds(user), lastLoginAt: serverTimestamp() },
      { merge: true },
    ).catch((e) => console.warn('private profile write failed', e));
  }

  /** Обновляет служебные поля Users/{uid} и приватный документ (merge); ник здесь не меняется. */
  async upsertUserProfile(user, _unused) {
    this.writePrivateProfile(user);
    await setDoc(this.userDoc(user), this.profileFields(user), { merge: true });
  }

  /** Регистрация ника: в одной транзакции занимаем Usernames/{ник} и пишем Users/{uid}. */
  async saveUsername(rawUsername) {
    const cb = this.callback;
    const user = auth.currentUser;
    if (!cb || !user) return;
    const username = String(rawUsername || '').trim();
    const formatError = validateNickname(username);
    if (formatError) {
      cb.onError(formatError);
      return;
    }

    cb.onShowLoading();
    const claimRef = doc(db, USERNAMES, nicknameKey(username));
    try {
      await runTransaction(db, async (tx) => {
        const claim = await tx.get(claimRef);
        if (claim.exists() && claim.data().uid !== user.uid) throw nickTakenError();
        if (!claim.exists()) tx.set(claimRef, claimData(user, username));
        tx.set(
          this.userDoc(user),
          {
            ...this.profileFields(user),
            userName: username,
            displayName: username,
            userNameLower: nicknameKey(username),
            nicknameClaimed: true,
            nicknameConflict: false,
            createdAt: serverTimestamp(),
          },
          { merge: true },
        );
      });
      this.nicknameConflict = false;
      this.writePrivateProfile(user);
      await this.updateDisplayName(user, username);
    } catch (error) {
      console.error('saveUsername', error);
      cb.onHideLoading();
      cb.onError(error && error.code === NICK_TAKEN ? 'Этот ник уже занят' : 'Ошибка сохранения в БД');
    }
  }

  /** Смена ника (например, если старый оказался занят): новый занимаем, старый освобождаем. */
  async changeNickname(rawNickname) {
    const cb = this.callback;
    const user = auth.currentUser;
    if (!cb || !user) return;
    const nickname = String(rawNickname || '').trim();
    const formatError = validateNickname(nickname);
    if (formatError) {
      cb.onError(formatError);
      return;
    }
    const oldName = this.currentUsername || '';
    const newKey = nicknameKey(nickname);
    const oldKey = oldName ? nicknameKey(oldName) : null;
    const newRef = doc(db, USERNAMES, newKey);
    const oldRef =
      oldKey && oldKey !== newKey && validateNickname(oldName) === null
        ? doc(db, USERNAMES, oldKey)
        : null;

    cb.onShowLoading();
    try {
      await runTransaction(db, async (tx) => {
        const claim = await tx.get(newRef);
        const oldClaim = oldRef ? await tx.get(oldRef) : null;
        if (claim.exists() && claim.data().uid !== user.uid) throw nickTakenError();
        if (!claim.exists()) tx.set(newRef, claimData(user, nickname));
        if (oldClaim && oldClaim.exists() && oldClaim.data().uid === user.uid) tx.delete(oldRef);
        tx.set(
          this.userDoc(user),
          {
            ...this.profileFields(user),
            userName: nickname,
            displayName: nickname,
            userNameLower: newKey,
            nicknameClaimed: true,
            nicknameConflict: false,
          },
          { merge: true },
        );
      });
    } catch (error) {
      console.error('changeNickname', error);
      cb.onHideLoading();
      cb.onError(error && error.code === NICK_TAKEN ? 'Этот ник уже занят' : 'Не удалось сменить ник');
      return;
    }
    this.nicknameConflict = false;
    this.currentUsername = nickname;
    updateProfile(user, { displayName: nickname }).catch((e) => console.warn('updateProfile', e));
    cb.onHideLoading();
    cb.onInfo('Ник изменён на «' + nickname + '»');
    cb.onUserAuthenticated(nickname, true);
  }

  async linkPassword(password) {
    const cb = this.callback;
    const user = auth.currentUser;
    if (!cb || !user || !user.email) return;

    cb.onShowLoading();
    try {
      const credential = EmailAuthProvider.credential(user.email, password);
      await linkWithCredential(user, credential);
      cb.onHideLoading();
      this.isFirstLoginAfterAppStart = false;
      if (auth.currentUser) await this.upsertUserProfile(auth.currentUser, null);
      await this.checkUserStatusAndRoute();
    } catch (error) {
      console.error('linkWithCredential failed', error);
      cb.onHideLoading();
      cb.onError('Ошибка привязки: ' + describeAuthError(error, 'Неизвестная ошибка'));
    }
  }

  async verifyPassword(password) {
    if (!this.checkCooldown()) return;
    const cb = this.callback;
    const user = auth.currentUser;
    if (!cb || !user || !user.email) return;

    cb.onShowLoading();
    try {
      const credential = EmailAuthProvider.credential(user.email, password);
      await reauthenticateWithCredential(user, credential);
      this.registerSuccess();
      cb.onHideLoading();
      this.isLoggedIn = true;
      this.isFirstLoginAfterAppStart = false;
      const name = user.displayName || this.currentUsername;
      cb.onUserAuthenticated(name, false);
    } catch (error) {
      this.registerFailure(error);
      console.error('verifyPassword', error);
      cb.onHideLoading();
      cb.onError('Неверный пароль защиты!');
    }
  }

  async signOut(onComplete) {
    this.resetSession();
    try {
      await firebaseSignOut(auth);
    } catch (error) {
      console.error('signOut', error);
    }
    if (typeof onComplete === 'function') onComplete();
    const cb = this.callback;
    if (cb) cb.onUnauthenticated();
  }

  routeAfterUserDocument(user, data) {
    const cb = this.callback;
    if (!cb) return;

    const userName = data && typeof data.userName === 'string' ? data.userName : '';
    if (userName) {
      this.currentUsername = userName;
      const hasPassword = hasEmailPasswordProvider(user);
      if (hasPassword && !this.isFirstLoginAfterAppStart) {
        cb.onPasswordVerificationRequired();
      } else {
        this.isLoggedIn = true;
        this.isFirstLoginAfterAppStart = false;
        cb.onUserAuthenticated(this.currentUsername, true);
      }
    } else {
      cb.onNewUserRegistration(false);
    }
  }

  async updateDisplayName(user, username) {
    try {
      await updateProfile(user, { displayName: username });
    } catch (error) {
      console.error('updateProfile', error);
    }
    this.currentUsername = username;
    const cb = this.callback;
    if (!cb) return;
    cb.onHideLoading();
    cb.onNewUserRegistration(true);
  }

  resetSession() {
    this.isLoggedIn = false;
    this.currentUsername = '';
    this.isFirstLoginAfterAppStart = false;
    this.nicknameConflict = false;
  }
}

export const authManager = new AuthManager();
