# File Server Storage (веб)

Статическая веб-версия Android-приложения **FileServerStorage**. Тот же Firebase-проект и тот же бакет Supabase Storage `user-files`. Сборки нет: достаточно HTML, CSS и JavaScript.

## Публикация на GitHub Pages

1. Создайте репозиторий и загрузите в него содержимое этой папки (файлы `index.html`, `.nojekyll`, каталоги `css/` и `js/`).
2. В GitHub откройте **Settings → Pages**.
3. В **Build and deployment** выберите **Deploy from a branch**.
4. Укажите ветку `main` (или `master`) и папку `/ (root)`.
5. Сохраните. Сайт появится по адресу `https://<user>.github.io/<repo>/`.

Файл `.nojekyll` нужен, чтобы GitHub Pages не обрабатывал сайт через Jekyll и отдавал файлы из `js/` как есть.

Все пути относительные, поэтому сайт работает и в корне домена, и в подкаталоге репозитория.

## Firebase: авторизованные домены

Вход через Google идёт из браузера, поэтому домен GitHub Pages нужно разрешить в Firebase.

1. Откройте [Firebase Console](https://console.firebase.google.com/) → проект **fileserverstorage-10052**.
2. **Authentication → Settings → Authorized domains**.
3. Добавьте `<user>.github.io` (без пути репозитория).

Для `signInWithPopup` также проверьте OAuth-клиент веб-приложения в Google Cloud Console (**APIs & Services → Credentials**): в **Authorized JavaScript origins** добавьте `https://<user>.github.io`.

## API-ключ: Android и Web

В `js/config.js` сейчас стоят значения из `app/google-services.json` Android-приложения (`project_id`, `apiKey`, `storageBucket`, `appId`) и `authDomain = <project_id>.firebaseapp.com`.

Если ключ Android ограничен только Android-приложениями, веб-вход и Firestore не заработают. Тогда:

1. В Firebase Console зарегистрируйте **Web app**.
2. Скопируйте его `apiKey` и `appId`.
3. Подставьте их в `js/config.js` в объект `firebaseConfig`.

Web Client ID приложения (`AuthManager.GOOGLE_WEB_CLIENT_ID`) указан в `js/config.js` для справки; `signInWithPopup` использует OAuth-настройки проекта Firebase.

## Что уже настроено на бэкенде

Сайт использует те же коллекции и те же правила, что и приложение:

- Firebase Auth (Google), Firestore: `Users` (id = email, поля `userName`, `uid`) и `Files`.
- Supabase URL, publishable-ключ и бакет `user-files` из `SupabaseManager.java`.
- Загрузка: `users/<Firebase UID>/<UUID>_<safeName>` с заголовками `Authorization: Bearer <Firebase ID token>` и `apikey`.

Локальный сервер и npm не нужны. Для проверки на компьютере можно открыть файлы через любой статический HTTP-сервер; `file://` для ES-модулей и Firebase Auth обычно не подходит.

## Структура

```
index.html      — одностраничный интерфейс
css/style.css   — тёмная/светлая тема
js/config.js    — Firebase и Supabase
js/firebase.js  — инициализация SDK
js/auth.js      — вход, Users, дополнительный пароль
js/storage.js   — Supabase Storage
js/files.js     — коллекция Files
js/app.js       — экраны и навигация
.nojekyll
```

Firebase JS SDK (модульный v10.14.1) подключается с `https://www.gstatic.com/firebasejs/10.14.1/`.
