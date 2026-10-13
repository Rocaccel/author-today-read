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
scripts/perf.js          A/B-замер влияния расширения на скорость (npm run perf)
tests/                 автотесты jsdom
extension/             ← грузится в Chrome как распакованное расширение
  manifest.json           MV3 (permissions: storage; options_ui; icons/action; host: rtdb)
  icons/                  PNG 16/32/48/128 (иконка тулбара, v0.2.3)
  content/storage.js      хранение в localStorage, схема v2 + миграция
  content/sync.js         синхронизация с Firebase (content ↔ background)
  content/ui.js           панель [+] [индикатор] [−]
  content/dom.js          вставка в DOM + MutationObserver/pjax + тумблер «Скрыть отмечённые» (v0.2.5)
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
content ↔ background, ретраи/GC, статистику, бэкап JSON и тумблер
«Скрыть отмечённые» (секции [11]–[16]).

## Замер производительности (регулярно)

A/B-тест «влияет ли расширение на скорость страницы» — `scripts/perf.js`
(zero-dep: Node >= 22 + portable Chromium/Chrome):

```
npm run perf              # 5 прогонов × 2 URL → таблица + perf/last-report.md
npm run perf -- --quick   # быстрый путь: 3 прогона, только каталог
npm run perf -- --runs=10 # стабильнее медиана
```

Что делает: два запуска браузера (с `--load-extension` и без), холодные
навигации на `/work/genre/fantasy` и `/search?category=works` с отключённым
кэшем, сбор FCP/LCP/CLS/TTFB/DCL/load/long-tasks/CDP-длительностей,
медианы и дельты «с расширением − без». Дополнительно меряет изолированную
стоимость нашего кода (eval 5 content-файлов + холодный/tёплый `scan()`
в мс). Sanity-проверка: в конфиге «с расширением» на каталоге обязаны
появиться `.atr-controls` (иначе — автоповтор в оконном режиме, exit 2).

Результаты: `perf/last-report.md` (перезапись) и строка в `perf/history.md`
(история прогонов по коммитам — удобно ловить деградации между версиями).
Каталог `perf/` в `.gitignore`.

Интерпретация: расширение грузится на `document_idle` — FCP/LCP в пределах
шума сети это норма; смотреть на дельту **CLS** (инжект панелей сдвигает
текст после load) и **TaskDuration/ScriptDuration** (работа главного
потока). Разброс велик → `--runs=10`.

## Релиз (§9 одной командой)

`npm run release` (`scripts/release.ps1`, PowerShell 5.1) — полный §9:
проверки (чистое дерево, `main` синхронизирован, тега нет) → `databaseURL`
из `.env` (парсер — `npm run config`) → `dist/author-today-read-X.Y.Z.zip`
(пути через `/`, .NET CreateEntry) + `.crx` (стабильный ID через
`extension.pem`) → `git tag` → `git push origin main vX.Y.Z` →
`gh release create`.

- Только собрать ассеты без публикации: `npm run release -- -BuildOnly`.
- Заголовок/ноты: `-Title` / `-Notes` (дефолт нот — `git log` с прошлого
  тега; дефолт заголовка — первая `feat:`-запись с прошлого тега).
- Требует: `gh` CLI (авторизован), `extension.pem`, `.env` с
  `FIREBASE_DATABASE_URL` (без него релиз не работает «из коробки», §9.4).

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
