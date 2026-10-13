# Author.Today — отметки книг: для разработчиков

Пользовательская инструкция (установка из релиза, использование): **[README.md](README.md)**.
Полная спецификация проекта (единственный источник истины): **[AGENTS.md](AGENTS.md)**.

## Структура проекта

```
AGENTS.md              полная спецификация проекта (для разработчиков и агентов)
README.md              пользовательская инструкция
.env                   конфиг Firebase (GITIGNORE, заполняется данными Firebase)
package.json           тесты + npm run config
scripts/apply-config.js  .env → extension/background/config.json
tests/                 автотесты jsdom
extension/             ← грузится в Chrome как распакованное расширение
  manifest.json           MV3 (permissions: storage; options_ui; icons/action; host: rtdb)
  icons/                  PNG 16/32/48/128 (иконка тулбара, v0.2.3)
  content/storage.js      хранение в localStorage, схема v2 + миграция
  content/sync.js         синхронизация с Firebase (content ↔ background)
  content/ui.js           панель [+] [индикатор] [−]
  content/dom.js          вставка в DOM + MutationObserver/pjax
  content/main.js         точка входа
  content/styles.css      стили (light/dark)
  shared/phrase.js        кодовая фраза, userId, PBKDF2/AES-GCM
  shared/backup.js        экспорт/импорт отметок в JSON (бэкап, v0.2.4)
  options/                страница настроек (фраза, статус, синхронизация, статистика)
  background/service-worker.js  роутер сообщений + хранилище фразы + кэш статистики
  background/firebase.js  Realtime Database REST-клиент (GET/PATCH/sync)
  background/config.json    ГЕНЕРИРУЕТСЯ из .env (GITIGNORE)
```

Сборка не требуется: чистый JavaScript, файлы подключаются как есть.

## Тесты

Автотесты в jsdom (без браузера) — из корня проекта:

```
npm install   # один раз, ставит jsdom (только для тестов)
npm test
```

Проверяют: инжект панелей в список/таблицу, исключение плитки, семантику
кнопок, схему хранилища v2 и миграцию с v1, LWW-слияние с томбстоунами,
панель на странице книги, генерацию фразы, детерминированный userId,
шифрование AES-GCM (чужой ключ падает), протокол синхронизации
content ↔ background.

## Настройка синхронизации из исходников

В релизном архиве (README, Вариант А) конфиг Firebase **уже встроен** —
этот раздел нужен, только если вы запускаете расширение из исходников
и/или со своим облаком.

1. В [Firebase Console](https://console.firebase.google.com/) →
   **Build → Realtime Database → Create database** (если БД ещё нет —
   получите `databaseURL` вида
   `https://<проект>-default-rtdb.<регион>.firebasedatabase.app`).
2. Настройте правила базы: **Realtime Database → вкладка Rules** —
   данные зашифрованы, поэтому правила открыты:

   ```json
   {
     "rules": {
       "users": {
         "$userId": {
           "marks": {
             ".read": true,
             ".write": true
           }
         }
       }
     }
   }
   ```

   **Publish** (предупреждение консоли об открытом доступе — ожидаемо,
   контент шифрованный).
3. В папке проекта заполните файл **`.env`** (он в `.gitignore`, на GitHub не
   попадает): минимум `FIREBASE_DATABASE_URL`. Можно вставить и JS-блок
   `const firebaseConfig = {...}` из консоли целиком — скрипт разберёт.
4. Выполните в терминале:

   ```
   npm run config
   ```

   Это создаст `extension/background/config.json` (тоже в `.gitignore`).
5. Перезагрузите расширение в `chrome://extensions` → **Настройки** →
   вход по кодовой фразе (см. README, раздел «Синхронизация»).

Без конфига расширение работает локально — синхронизация просто выключена.
