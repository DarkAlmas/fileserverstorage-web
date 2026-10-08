/**
 * Порт auth/AuthManager.java: Google Sign-In, документ Users, доп. пароль.
 */
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  linkWithCredential,
  reauthenticateWithCredential,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { auth, db } from './firebase.js';

export function hasEmailPasswordProvider(user) {
  return (user.providerData || []).some((info) => info.providerId === EmailAuthProvider.PROVIDER_ID);
}

export class AuthManager {
  constructor() {
    this.callback = null;
    this.isLoggedIn = !!auth.currentUser;
    this.currentUsername = '';
    this.isFirstLoginAfterAppStart = true;
  }

  setCallback(callback) {
    this.callback = callback;
  }

  getCurrentUsername() {
    return this.currentUsername || null;
  }

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

  async checkUserStatusAndRoute() {
    const cb = this.callback;
    if (!cb) return;

    const user = auth.currentUser;
    if (!user || !user.email) {
      this.resetSession();
      cb.onUnauthenticated();
      return;
    }

    if (this.isLoggedIn && this.currentUsername) {
      cb.onUserAuthenticated(this.currentUsername, true);
      return;
    }

    cb.onShowLoading();
    try {
      const snapshot = await getDoc(doc(db, 'Users', user.email));
      cb.onHideLoading();
      this.routeAfterUserDocument(user, snapshot);
    } catch (error) {
      console.error('checkUserStatusAndRoute', error);
      cb.onHideLoading();
      cb.onError('Ошибка проверки данных сервера');
    }
  }

  async saveUsername(username) {
    const cb = this.callback;
    const user = auth.currentUser;
    if (!cb || !user || !user.email) return;

    cb.onShowLoading();
    try {
      const snap = await getDocs(
        query(collection(db, 'Users'), where('userName', '==', username)),
      );
      if (!snap.empty) {
        cb.onHideLoading();
        cb.onError('Этот ник уже занят');
        return;
      }
      await setDoc(doc(db, 'Users', user.email), {
        userName: username,
        uid: user.uid,
      });
      await this.updateDisplayName(user, username);
    } catch (error) {
      console.error('saveUsername', error);
      cb.onHideLoading();
      cb.onError(error && error.message && error.message.includes('ник')
        ? 'Ошибка проверки ника'
        : 'Ошибка сохранения в БД');
    }
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
      await this.checkUserStatusAndRoute();
    } catch (error) {
      console.error('linkWithCredential failed', error);
      cb.onHideLoading();
      cb.onError('Ошибка привязки: ' + (error && error.message ? error.message : 'Неизвестная ошибка'));
    }
  }

  async verifyPassword(password) {
    const cb = this.callback;
    const user = auth.currentUser;
    if (!cb || !user || !user.email) return;

    cb.onShowLoading();
    try {
      const credential = EmailAuthProvider.credential(user.email, password);
      await reauthenticateWithCredential(user, credential);
      cb.onHideLoading();
      this.isLoggedIn = true;
      this.isFirstLoginAfterAppStart = false;
      const name = user.displayName || this.currentUsername;
      cb.onUserAuthenticated(name, false);
    } catch (error) {
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

  routeAfterUserDocument(user, documentSnap) {
    const cb = this.callback;
    if (!cb) return;

    if (documentSnap && documentSnap.exists() && documentSnap.data().userName) {
      const username = documentSnap.data().userName || '';
      this.currentUsername = username;
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
  }
}

export const authManager = new AuthManager();
