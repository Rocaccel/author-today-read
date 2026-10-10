# AGENTS.md — спецификация расширения «Author.Today — отметки книг»

Этот файл — **единственный источник истины** по проекту. Цель документа: любой
нейросеть/агент должна суметь **полностью воссоздать расширение с нуля**, только
прочитав этот файл (исходный `promt.md` удалён, все правки требований внесены сюда).

Папка проекта: `C:\Users\ser\Desktop\GitHub\author-today-readed`
Рабочая папка расширения: `extension/` (именно её грузят в Chrome как unpacked).

---

## 1. Что делает расширение

Chrome-расширение (Manifest V3) для сайта <https://author.today/>.
Рядом с названием каждой книги в списке появляются три элемента:

```
[ + ]  [ индикатор ]  [ − ]
```

- **`+`** — переключает отметку «прочитано/нравится» → `✅`.
- **`−`** — переключает отрицательную отметку → `❌`.
- **Индикатор** — `✅`, `❌` или пустое место (ничего не выведено).

Функциональные требования (со всеми согласованными правками):

1. Элементы управления добавляются **рядом с названием книги в строке** (в заголовке).
2. Хранение: **localStorage страницы — первичный кэш** (офлайн и работа без
   входа), **синхронизация между устройствами — Firebase** (Realtime Database REST)
   по кодовой фразе (v0.2.0, §8). Отметки хранятся ТОЛЬКО в localStorage;
   в `chrome.storage.local` лежат лишь кодовая фраза и статусы синхронизации
   (страница author.today их не читает).
3. Popup у расширения **не нужен** — индикаторы на страницах + options-страница
   (настройки/фраза/статус, §8.5).
4. Firebase — **реальный REST-клиент** (`background/firebase.js`, v0.2.0);
   конфиг подставляется из `.env` → `npm run config` (файлы в .gitignore,
   секретов в репо нет).
5. Стек — **чистый JavaScript без сборки** (никаких npm/vite/esbuild/TypeScript;
   firebase-SDK не используется — только REST API по fetch).
6. Подробные комментарии на русском в ключевых логических блоках (интеграция в DOM,
   обработчики кликов, хранение) — требование исходного ТЗ.

### 1.1. Семантика кнопок (переключатели с заменой)

| Текущее состояние | клик `+` | клик `−` |
|---|---|---|
| пусто (`null`) | `✅` (`"read"`) | `❌` (`"skip"`) |
| `✅` (`"read"`) | пусто (запись удаляется) | `❌` (`"skip"`) |
| `❌` (`"skip"`) | `✅` (`"read"`) | пусто (запись удаляется) |

Каждая кнопка **переключает свою** отметку и при этом **заменяет чужую**.
Повторное нажатие на кнопку в своём состоянии снимает отметку (запись из хранилища
удаляется полностью, а не обнуляется).

### 1.2. Область применения (страницы и виды)

Включаем индикаторы **только** на:

- путях `/search*` (поиск, включая `/search?category=works`)
- путях `/work*` (каталог: `/work/genre/...`, `/work/discounts/...` и т.п.)
- **одиночной странице книги** `/work/NNN` (только цифровой id;
  `/work/genre/...`, `/work/series/...` сюда НЕ входят) — панель ставится
  внутрь заголовка `h1.book-title` (см. §2.5)

и **только** в двух видах отображения (для каталога/поиска):

- **«Список/строки»** — элемент `.book-row` (не контейнер!),
- **«Таблица»** — `table.books-table`.

Вид **«плитка/tile»** (карточки `.bookcard`) — **сознательно исключён**, как и
все остальные страницы сайта (главная, библиотека, страница автора, выпадающий
поиск в шапке). Не расширять область без отдельного запроса пользователя.

---

## 2. DOM-карта author.today (проверено вживую 10.10.2026)

### 2.1. Вид «строки» (list)

```html
<div class="book-row">                     <!-- ЭТО элемент списка, не контейнер -->
  <div class="book-cover-wrapper">...</div>
  <div class="book-row-content">
    <div class="book-title">
      <a data-pjax href="/work/659887">Путь Строителя 18</a>
      <div class="pull-right work-list-actions">
        <library-button params="{workId: 659887, ...}"></library-button>
      </div>
    </div>
    <div class="book-author">...</div>
    ...
  </div>
</div>
```

**Точка вставки:** внутрь `.book-title`, сразу после ссылки `<a href="/work/NNN">`.

> ОПАСНОСТЬ: на главной странице существует контейнер
> `<div class="book-shelf book-row book-row-sm">`, внутри которого лежат
> `.bookcard`. Это НЕ элементы списка. Отличие: у списка есть `.book-title`
> (одиночное) и `.book-row-content`; у плитки — `.bookcard-title`. Наша проверка
> «строка списка» = `элемент содержит .book-title`.

### 2.2. Вид «таблица» (table)

```html
<table class="books-table table table-hover">
  <thead><tr><th>Название</th><th>Автор</th>...</tr></thead>
  <tbody>
    <tr>
      <td>
        <a data-pjax href="/work/659887">Путь Строителя 18</a>
      </td>
      <td><a href="/u/.../works">Ковтунов Алексей</a></td>
      ...
    </tr>
  </tbody>
</table>
```

**Точка вставки:** первая `<td>` строки, сразу после ссылки на книгу.

### 2.3. Поиск `/search`

- `/search?q=...` (без `category`) — выдаёт сетку `.bookcard` **без переключателя
  вида**; по правилам §1.2 кнопки туда не ставим.
- `/search?category=works&q=...` — есть переключатель вида
  (`?view=list | ?view=table | ?view=tile`), разметка list/table **идентична
  каталогу** (§2.1, §2.2). Кнопки работают в list и table.

### 2.4. Особенности сайта, которые ломают простые реализации

1. **pjax.** Навигация и пагинация заменяют содержимое `#pjax-container` без
   перезагрузки страницы. После pjax старые DOM-узлы исчезают — нужны повторные
   сканы. Событие: `document` → `'pjax:end'` (и `'pjax:success'`).
2. **Переключатель вида (каталог)** — client-side Knockout (`switchView`), DOM
   меняется без pjax. Решение — `MutationObserver`.
3. **Тёмная тема.** Сайт переключает класс `dark` на `<html>` (плюс уважает
   `prefers-color-scheme`). Стили кнопок обязаны работать в обеих темах.
4. **ID книги** извлекается из href ссылки регуляркой `/\/work\/(\d+)/`.
   Ссылки вида `/work/genre/...`, `/work/series/...`, `/work/discounts/...` —
   НЕ являются книгой (нет цифрового id после `/work/`).
5. Рядом с заголовком уже живёт встроенная кнопка `library-button` (добавить в
   библиотеку) — наша панель не должна наезжать на неё (margin-left у ссылки
   заголовка, не float-right блок).

### 2.5. Страница книги `/work/NNN` (detail, проверено вживую 10.10.2026)

URL: `https://author.today/work/233831` — одиночная карточка книги
(`pathname === "/work/" + digits`, регулярка `BOOK_PAGE_RE = /^\/work\/(\d+)$/`;
`/work/genre/...` под неё НЕ подходит).

```html
<div class="book-page inner-content">
  <div class="panel book-panel" itemscope itemtype="http://schema.org/Book">
    <div class="panel-body">
      <div class="book-meta-panel">
        <h1 class="book-title" itemprop="name">Школа на краю империи</h1>
        <div class="book-authors">...</div>
        ...
```

**Точка вставки:** внутрь `<h1 class="book-title">` в **конец** — панель стоит
в одну строку сразу после текста названия (решение пользователя, 10.10.2026).
Селектор заголовка: `.book-page .book-meta-panel > h1.book-title`.
`workId` берётся **из `location.pathname`** (ссылки на книгу в заголовке нет).

Конфликта со списком нет: селектор list-вида `.book-row .book-title` требует
предка `.book-row`, а этот `h1` такого предка не имеет — `findTargets()` его
не находит, обработка идёт отдельной функцией `injectBookPage()`.

Панель внутри крупного `h1` гасится стилями
`.book-meta-panel > h1.book-title .atr-controls` (см. `styles.css`): кегль
кнопок/индикатора остаётся 13px, `margin-left: 10px`.

---

## 3. Спецификация хранения (v0.2.0: схема v2)

### 3.1. Локальный кэш — `window.localStorage` страницы author.today

- Content script работает в isolated world origin `https://author.today` —
  доступ к localStorage общий с страницей. Собственный ключ с префиксом `atr.`,
  конфликтов с ключом сайта `theme` нет.
- Ключ: **`atr.v2.marks`** (v0.2.0 — новая схема; `atr.v1.marks` мигрируется).
- Формат — объект отметок с метками времени (нужны для LWW-слияния с облаком):

```json
{
  "659887": { "m": "read", "t": 1760160000000 },
  "463277": { "m": "skip", "t": 1760160123456 },
  "644707": { "m": null,  "t": 1760160234567 }
}
```

- `m ∈ {"read", "skip", null}`: `read`/`skip` — отметка; **`null` — томбстоун**
  (снятие отметки). Томбстоуны НЕ удаляются из объекта: без них удаление
  «воскресло» бы на другом устройстве при следующем pull.
- `t` — epoch_ms последнего изменения (проставляется в `set`/`remove`).
- Снятие отметки = запись `{ m: null, t: now }` (в v0.1.0 было `delete`).
- Запись атомарная: прочитал весь объект → изменил одно поле → записал весь объект.
- Повреждённый JSON — не ронять: считать пустым объектом и залогировать в консоль.
- Кросс-табная синхронизация: событие `storage` (window) → перерисовка панелей
  (подписка в content/dom.js).

### 3.2. Миграция v1 → v2

- Одноразовая, в `getAll()` (content/storage.js): нет ключа v2, но есть v1 →
  `{workId: mark}` превращается в `{workId: {m: mark, t: Date.now()}}`,
  значения вне `{read, skip}` отбрасываются; v2 записывается, **v1 удаляется**.

### 3.3. Фраза и статусы — `chrome.storage.local` (background)

- Ключи: `atr.sync.phrase` (нормализованная фраза), `atr.sync.userId`,
  `atr.sync.lastSync`, `atr.sync.lastError`.
- Фраза хранится ТОЛЬКО здесь (читает только расширение); в page localStorage
  не попадает — сайт author.today её не видит.
- Требует `"permissions": ["storage"]` в manifest.

### 3.4. Облако — Firebase Realtime Database (см. §8)

Путь `users/{userId}/marks/{workId}`, формат узла — §8.2.
Отметки в облаке всегда шифрованные; ключ — только от кодовой фразы.

---

## 4. Архитектура и состав файлов

```
author-today-readed/
├── AGENTS.md                    ← этот файл (спецификация)
├── README.md                    ← инструкция по установке и настройке Firebase
├── .env                         ← конфиг Firebase (GITIGNORE, заполняет пользователь)
├── package.json                 ← тесты + `npm run config` (jsdom devDependency)
├── scripts/
│   └── apply-config.js          ← .env → extension/background/config.json (npm run config)
├── tests/
│   └── smoke.test.js            ← автотесты jsdom (инжект, семантика, v2, LWW, фраза, крипто, sync)
└── extension/                   ← содержимое расширения (грузится в Chrome)
    ├── manifest.json            ← MV3: permissions storage, host_permissions rtdb, options_ui
    ├── content/
    │   ├── storage.js           ← модуль хранения (localStorage, схема v2 + миграция + mergeRemote)
    │   ├── sync.js              ← синхронизация: content ↔ background через chrome.runtime
    │   ├── ui.js                ← создание/обновление панели [+] [индикатор] [−]
    │   ├── dom.js               ← сканирование DOM, вставка, MutationObserver, pjax
    │   ├── main.js              ← точка входа (sync.init + dom.start)
    │   └── styles.css           ← стили панели (light + dark)
    ├── shared/
    │   └── phrase.js            ← ES-модуль: кодовая фраза, userId, PBKDF2/AES-GCM (options + background)
    ├── options/
    │   ├── options.html         ← страница настроек (chrome://extensions → Настройки)
    │   ├── options.js           ← генерация/ввод фразы, статус, ручная синхронизация, выход
    │   └── options.css
    └── background/
        ├── service-worker.js    ← ES-модуль: роутер сообщений + хранилище фразы
        ├── firebase.js          ← Realtime Database REST-клиент (GET/PATCH .json + sync)
        └── config.json          ← ГЕНЕРИРУЕТСЯ из .env (GITIGNORE, в свежем клоне отсутствует)
```

### 4.1. Правила сборки/подключения

- **Никакой сборки.** Content script — пять *классических* скриптов,
  подключаются в manifest **строго в порядке**:
  `storage.js → sync.js → ui.js → dom.js → main.js`.
  Все они выполняются в одном isolated world и общаются через глобальное
  пространство `globalThis.ATR`:

```js
// каждая content-файла заворачивается так:
(function () {
  'use strict';
  const ATR = (globalThis.ATR = globalThis.ATR || {});
  // ... свой функционал кладём в ATR
})();
```

- Background — **ES-модуль** (`"type": "module"` в manifest). Импортирует
  `./firebase.js` и `../shared/phrase.js` (общий с options). `config.json`
  читается **fetch(chrome.runtime.getURL('background/config.json'))** — файла
  может не быть в свежем клоне (он в .gitignore), fetch отклоняется → catch →
  пустой конфиг; расширение обязано работать без него (синхронизация просто
  выключена, `isReady() === false`). **ЗАПРЕЩЁН динамический `import()`**
  внутри ServiceWorkerGlobalScope — спецификация HTML его не разрешает
  (w3c/ServiceWorker#1356), в реальном Chrome всегда падает (в Node/тестах —
  работает, поэтому баг не ловится тестами; исторически привёл к багу v0.2.0).
  Options-странице конфиг не нужен — статус приходит по `atr:status`.
- Options-страница — `<script type="module">`, тоже импортирует `../shared/phrase.js`.
- `permissions`: `["storage"]` (chrome.storage.local для фразы/статусов).
  `host_permissions`: `["https://*.firebasedatabase.app/*"]` (fetch из background).

### 4.2. Контракты модулей (сигнатуры, которые обязаны соблюдаться)

**`content/storage.js` → `ATR.storage`** (схема v2, §3.1)

| функция | сигнатура | что делает |
|---|---|---|
| `getAll()` | `() → Object` | весь объект `{wid: {m, t}}` (после миграции v1; повреждённый JSON → `{}`) |
| `get(workId)` | `(string) → "read"\|"skip"\|null` | текущая отметка (томбстоун/нет записи → null) |
| `getStamp(workId)` | `(string) → number` | epoch_ms последнего изменения, 0 если нет записи |
| `set(workId, mark)` | `(string, "read"\|"skip") → void` | запись `{m, t: Date.now()}` |
| `remove(workId)` | `(string) → void` | **томбстоун** `{m: null, t}` (не `delete`); уже томбстоун → no-op |
| `toggle(workId, mark)` | `(string, "read"\|"skip") → "read"\|"skip"\|null` | семантика §1.1; после изменения шлёт `document` событие `'atr:changed'` с `{detail:{workId}}` |
| `mergeRemote(remote)` | `(Object) → string[]` | LWW-слияние облачных данных: принимает запись, если её `t` **больше** локального; возвращает список изменившихся workId |

Константы: `ATR.storage.KEY_V2 = 'atr.v2.marks'`, `KEY_V1 = 'atr.v1.marks'`,
`MARK_READ = 'read'`, `MARK_SKIP = 'skip'`.

**`content/sync.js` → `ATR.sync`**

| функция | что делает |
|---|---|
| `isSupported()` | есть ли `chrome.runtime.sendMessage` (в тестах может отсутствовать) |
| `init()` | подписка на `'atr:changed'` (debounce push 1.5 с), `focus` окна (pull не чаще 30 с) + первый `syncNow()` при загрузке страницы |
| `syncNow()` | один round-trip: шлёт `{type:'atr:sync:sync', entries: getAll()}` → принимает `res.pull` → `storage.mergeRemote()` → `ui.renderAll(wid)` (БЕЗ события `atr:changed`, чтобы не зациклить push). Одновременно только один запрос (inFlight + pending). Ошибки/`skip` — молча, локальная работа продолжается |

**`shared/phrase.js` (ES-модуль, options + background)**

| экспорт | что делает |
|---|---|
| `WORDLIST`, `PHRASE_WORDS=15`, `MIN_WORDS=12`, `MAX_WORDS=30` | встроенный список из 128 слов и лимиты |
| `generatePhrase(n?)` | 15 случайных слов через `crypto.getRandomValues` |
| `normalizePhrase(s)` | lowercase + trim + схлопывание пробелов |
| `validatePhrase(s)` | null если ок, иначе текст ошибки (12–30 слов) |
| `deriveUserId(phrase)` | `hex(SHA-256(normalize(phrase)))` — userId, путь в БД |
| `deriveKey(phrase)` | PBKDF2-SHA256(соль `"atr.sync.v1"`, 100k) → AES-GCM-256 CryptoKey |
| `encryptMark(key, mark)` | `{v, iv, ct}` (base64); iv — 12 случайных байт |
| `decryptMark(key, payload)` | обратно `"read"\|"skip"\|null`; неверный ключ → исключение |

**`background/firebase.js` (ES-модуль, реальный REST-клиент)**

| функция | что делает |
|---|---|
| `loadConfig()` | кэшированный `fetch(chrome.runtime.getURL('background/config.json'))` (`.ok ? json : {}`, catch → пустой конфиг) → `{config, ready}` (ready = `!!databaseURL`; файла может не быть) |
| `initFirebase(config)` → клиент | `isReady()` (databaseURL), `pullDocs(userId)` (GET `{db}/users/{uid}/marks.json`; пустое дерево → `null` → `[]`), `sync(userId, phrase, localEntries)` → `{pull, pushed, skipped}`: расшифровывает облако, пушит локальное новее облака одним `PATCH` (RTDB мержит ветки), возвращает облачное новее локального. Ошибки HTTP — исключение со свойством `status` |

**`background/service-worker.js` (роутер `chrome.runtime.onMessage`)**

| сообщение | вход → выход |
|---|---|
| `atr:status` | `→ {ok, configReady, hasPhrase, phrase, userId, lastSync, lastError, ready}` (`phrase` — для кнопок Показать/Копировать в options, §8.5) |
| `atr:phrase:set` | `{phrase}` → валидация, `deriveUserId`, сохранение в `chrome.storage.local` → `{ok, userId}` / `{ok:false, error}` |
| `atr:phrase:clear` | `→ {ok}` (удаляет фразу/userId/ошибку) |
| `atr:sync:sync` | `{entries}` → полный round-trip с Realtime Database → `{ok, pull, pushed, skipped}` либо `{ok:false, skip:true, reason:'config'\|'phrase'}` (не ошибка!) либо `{ok:false, error}` (сеть/правила, текст сохраняется в `atr.sync.lastError`) |

`options/options.js` — чистый UI: `generatePhrase/validatePhrase/normalizePhrase`
из shared + те же 4 сообщения; локальных данных не хранит.

**`content/ui.js` → `ATR.ui`**

| функция | сигнатура | что делает |
|---|---|---|
| `create(workId)` | `(string) → HTMLElement` | возвращает `<span class="atr-controls" data-atr-wid="ID">` с кнопками `[+] [span.atr-status] [−]` и навешенными обработчиками |
| `render(root)` | `(HTMLElement) → void` | читает отметку и обновляет текст индикатора/классы кнопок у конкретной панели |
| `renderAll(workId)` | `(string) → void` | обновляет все панели этого workId (на странице может быть одна, но перестраховка) |

Поведение кнопок: `click → event.preventDefault(); event.stopPropagation(); →
ATR.storage.toggle(...) → ATR.ui.renderAll(workId)`. `stopPropagation` обязателен —
на строках таблицы/списка бывают свои обработчики кликов.

**`content/dom.js` → `ATR.dom`**

| функция | что делает |
|---|---|
| `isEnabledPage()` | `true`, если `location.pathname` начинается с `/search` или `/work` |
| `isBookPage()` | `true`, если `location.pathname` матчится с `/^\/work\/(\d+)$/` (одиночная страница книги, §2.5) |
| `findWorkLink(target)` | ищет внутри `target` ссылку на книгу (`/work/(\d+)`, умеет абсолютные URL); возвращает `{ link, workId }` или null |
| `findTargets()` | `NodeList` точек вставки: `.book-row .book-title` (только элементы-строки!) и `table.books-table tbody td:first-child` |
| `inject(target)` | идемпотентно: если внутри уже есть `[data-atr-wid]` — выйти; иначе создать панель (`ATR.ui.create`) и вставить **сразу после ссылки на книгу**; после вставить `ATR.ui.render` |
| `injectBookPage()` | страница книги (§2.5): `workId` из `location.pathname`; идемпотентно (проверка `[data-atr-wid]` **внутри h1**) иначе `ATR.ui.create` → `h1.append(panel)` → `ATR.ui.render`; если `h1` не найден — выйти |
| `scan()` | полный проход: `findTargets()` + `inject()` **плюс** `injectBookPage()`; главный вход |
| `start()` | первичный `scan()` + `MutationObserver` на `document.body` (childList, subtree) с debounce ~150 мс + слушатели `'pjax:end'`, `'pjax:success'` (document), `'atr:changed'` (document), `storage` (window) |

Идемпотентность — ключевое: повторные `scan()` **не должны дублировать** панели
(проверка `target.querySelector('[data-atr-wid]')`).

### 4.3. Структура manifest.json (v0.2.0)

```json
{
  "manifest_version": 3,
  "name": "Author.Today — отметки книг",
  "version": "0.2.0",
  "description": "Отметки ✅/❌ рядом с названиями книг в списках, таблицах и на странице книги. Синхронизация между устройствами через Firebase по кодовой фразе.",
  "permissions": ["storage"],
  "host_permissions": ["https://*.firebasedatabase.app/*"],
  "content_scripts": [
    {
      "matches": ["https://author.today/*"],
      "js": ["content/storage.js", "content/sync.js", "content/ui.js", "content/dom.js", "content/main.js"],
      "css": ["content/styles.css"],
      "run_at": "document_idle"
    }
  ],
  "options_ui": { "page": "options/options.html", "open_in_tab": true },
  "background": { "service_worker": "background/service-worker.js", "type": "module" }
}
```

Иконки не обязательны — не генерировать, не добавлять (нет бинарных ассетов в репо).

---

## 5. Визуальные требования к панели

- Панель — inline-flex, вертикальное выравнивание по центру строки, `margin-left: 6px`
  от ссылки заголовка; не ломает существующий `pull-right` с `library-button`.
- Кнопки: ~20×20 px, лёгкая рамка, скругление 4 px, серый цвет в неактивном
  состоянии; `+` зеленеет при активной `read`-отметке, `−` краснеет при `skip`.
- Индикатор: `✅` / `❌` / пустая строка, `min-width` фиксирован, чтобы строки
  не «прыгали»; `user-select: none`.
- Hover-подсказки: `title="Отметить (повторный клик снимает)"` /
  `title="Отметить минусом (повторный клик снимает)"`.
- Доступность: кнопки — `<button type="button">`, `aria-pressed` по состоянию.
- Обе темы: обычная + `html.dark` (класс на `<html>`), фолбэк через
  `@media (prefers-color-scheme: dark)` внутри `html:not(.dark)` не нужен —
  достаточно веток `.dark`.
- Эмодзи индикатора рисуем текстом (`textContent = '✅'`), не картинками.

---

## 6. Чеклист проверки (прогнать перед сдачей)

0. **Автотесты** (нужен Node.js): из корня проекта `npm install` (один раз) →
   `npm test`. Тест `tests/smoke.test.js` в jsdom проверяет: инжект в строку и
   таблицу, отсутствие панелей в плитке и на чужих страницах, полную семантику
   кнопок (§1.1), схему хранилища v2 и миграцию v1→v2, LWW-слияние с томбстоунами,
   страницу книги (панель внутри `h1.book-title`), генерацию/валидацию фразы,
   детерминированный userId, round-trip AES-GCM (чужой ключ падает), sync-протокол
   content↔background (chrome-стаб). Все проверки должны быть `ok`, итог
   «ВСЕ ТЕСТЫ ПРОЙДЕНЫ».
1. `chrome://extensions` → режим разработчика → «Загрузить распакованное
   расширение» → папка `extension/`. Без ошибок в manifest.
2. Открыть `https://author.today/work/genre/fantasy` (вид «строки» по умолчанию):
   у каждого заголовка панель `[+] [ ] [−]`.
3. Клик `+` → `✅`; ещё раз `+` → пусто; `−` → `❌`; `−` → пусто; `+` при `❌` → `✅`.
4. Переключить вид на таблицу (`?view=table` или кнопку-«полоски»): панели в
   первой колонке каждой строки.
5. Переключить на плитку: панелей **нет** (проверить отсутствие).
6. Пагинация/фильтр каталога (pjax): после перехода панели на новой странице есть,
   дублей нет.
7. Перезагрузка страницы: отметки сохранились (localStorage, ключ `atr.v2.marks`).
8. Открыть ту же страницу во второй вкладке, поставить отметку в одной — во второй
   обновилась (событие `storage`).
9. Тёмная тема сайта: кнопки читаемы, рамки видимы.
10. **Страница книги** `/work/233831` (§2.5): панель `[+] [ ] [−]` стоит
    **внутри `h1.book-title`** сразу после текста названия; идемпотентна
    (повторный pjax — без дублей). Отметка **общая со списком**: поставить `✅`
    в списке каталога → на странице книги `✅` и наоборот (один localStorage).
11. Страница главная `/`, `/u/...`, разделы `/work/genre/...` (без панели на
    своём заголовке раздела) — панелей на их заголовках **нет**; у строк
    каталога панели остаются (область §1.2).
12. Console (F12): нет ошибок/спама; `localStorage.getItem('atr.v2.marks')` — валидный JSON.
13. Синтаксис: `node --check` для content/*.js и tests; для ES-модулей
    (shared/background/options) — `node --check` копии с расширением `.mjs`.
14. **Миграция**: открыть страницу со старыми данными `atr.v1.marks` → после
    загрузки ключ v1 удалён, `atr.v2.marks` содержит `{m, t}`, отметки читаются.
15. **Конфиг**: в `.env` заполнен `FIREBASE_DATABASE_URL` → `npm run config`
    создаёт `extension/background/config.json`; `git status` не показывает
    `.env` и `config.json` (в .gitignore).
16. **Options**: «Создать фразу» → чекбокс → вход; статус показывает userId
    (64 hex) и время; фраза замаскирована, «Показать» раскрывает/прячет,
    «Копировать» кладёт её в буфер («Скопировано»); без фразы контент-скрипт
    работает локально без ошибок.
17. **Синхронизация** (ручная, после настройки конфига): правила RTDB
    вставлены (Rules → Publish); два браузера с одной
    фразой → отметка в одном появляется в другом (дождаться push/pull: клик →
    ~1.5 с → открыть/фокус на второй вкладке); «Выйти» удаляет фразу с устройства,
    облачные данные остаются.

---

## 7. Запреты при доработках

- Не добавлять сборку, зависимости, TypeScript. (Единственное исключение —
  `jsdom` как **devDependency** для `tests/smoke.test.js`: он не попадает в
  расширение и не влияет на его работу.)
- **Секретов нет**: в репозитории не должно появиться реальных ключей Firebase
  или других токенов — конфиг живёт только в `.env`/`config.json` (gitignore).
- Не добавлять chrome.storage / сетевые запросы / реальный Firebase **без
  нового запроса пользователя**. (Запрос получен: v0.2.0 — `storage` только
  для фразы/статусов, сети только к `*.firebasedatabase.app` из background,
  конфиг через `.env` → `config.json`, оба файла в .gitignore — §8.4.)
- Не добавлять firebase-SDK/bundler — только REST API по `fetch` (§8.1).
- Не использовать динамический `import()` в background SW (ServiceWorkerGlobalScope):
  запрещён спецификацией HTML (w3c/ServiceWorker#1356) — только статические
  импорты и `fetch` (§4.1, §8.4).
- Не ставить панели в плитку `.bookcard` и на страницы вне `/search*` и `/work*`.
- Не модифицировать код самого сайта (никаких переопределений `app.*`, только
  наблюдение и добавление своих узлов с префиксом `atr-`).
- Не менять ключ хранилища без миграции (`atr.*` — версионировать; так была
  сделана миграция `atr.v1.marks` → `atr.v2.marks`, §3.2).
- **Секреты конфига**: `.env` и `extension/background/config.json` — в `.gitignore`,
  НИКОГДА не коммитить и не запушить (включая содержимое в других файлах).
  В репозитории допустимы только пустые заглушки и инструкции.

---

## 8. Синхронизация с Firebase (v0.2.0)

### 8.1. Архитектура

```
[страница author.today]                       [background SW]          [Realtime Database]
content/storage.js (кэш v2)  atr:sync:sync   service-worker.js   GET/PATCH .json
content/sync.js ──────────────────────────►  firebase.js  ─────────────────►  users/{uid}/marks/*
        ▲                                       │ sha256/pbkdf2/aes
        └── merge LWW (pull) ◄─────────────────┘ из chrome.storage.local
                 options/options.js ── те же 4 сообщения ──►
```

- **Сеть только в background** (CORS расширения, `host_permissions`); content
  шлёт готовый срез `{wid:{m,t}}` и получает готовый pull.
- **Один round-trip `atr:sync:sync`**: pull облака → сравнение по `t` (LWW) →
  push локального новее → вернуть облачное новее локального → `mergeRemote`.
- Триггеры: загрузка любой страницы сайта, debounce 1.5 с после клика,
  фокус окна (не чаще 30 с), ручная кнопка в options.
- **Тишина при ошибке**: нет конфига/фразы/сети → локальная работа продолжается
  без ошибок в консоль; детали — `atr.sync.lastError` (видны в options).
- Прочего фонового трафика нет: `chrome.alarms` не используется, popup нет.

### 8.2. Модель данных и правила

```
users/{userId}/marks/{workId} → {
  updatedAt: integer,   // ОТКРЫТО — по нему идёт LWW-слияние на клиенте
  v: "1", iv: string,   // ОТКРЫТО — версия схемы и nonce (base64)
  ct:  string           // шифротекст JSON {m: "read"|"skip"|null} (base64)
}
```

- `userId = hex(SHA-256(нормализованной фразы))` — детерминирован, одинаков
  на всех устройствах с одной фразой.
- Правила Realtime Database (пользователь настраивает в консоли:
  Realtime Database → вкладка Rules; сниппет в README):

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

- REST (без SDK, без сборки; ключ API не нужен — доступ определяют правила):
  - pull: `GET {databaseURL}/users/{uid}/marks.json` — пустое дерево отвечает
    `200 + null` → «данных нет»;
  - push: `PATCH {databaseURL}/users/{uid}/marks.json` с JSON-объектом
    `{workId: {updatedAt, v, iv, ct}, ...}` — RTDB мержит переданные ветки,
    чужие workId не затрагивает (одна запись = один запрос).

### 8.3. Криптография (shared/phrase.js)

- Фраза: 15 слов из встроенного списка 128 (`generatePhrase`) или своя
  (12–30 слов, `validatePhrase`); нормализация — lowercase/trim/пробелы.
- `userId = SHA-256(фраза)`; ключ = `PBKDF2-SHA256(фраза, "atr.sync.v1", 100000)`
  → AES-GCM-256; iv — 12 байт на запись.
- Свойство: **без фразы облако нечитаемо** — отсюда открытые правила §8.2.
- Чужая фраза на своём устройстве: расшифровка падает → запись попадает в
  счётчик `skipped` и не мешает остальным.

### 8.4. Конфигурация: `.env` → `config.json`

1. Пользователь заполняет `.env` (шаблон в корне): формат `KEY=VALUE` либо
   вставленный целиком JS-блок `const firebaseConfig = {...}` из
   Firebase-консоли (Project settings → SDK setup) — скрипт разбирает оба.
2. `npm run config` (`scripts/apply-config.js`) → `extension/background/config.json`
   (JSON-объект `{apiKey, projectId, databaseURL, ...}`).
3. Оба файла в `.gitignore`. Свежий клон без конфига — рабочее расширение:
   `loadConfig()` (firebase.js) делает `fetch(chrome.runtime.getURL(...))`,
   файл отсутствует → catch → пустой конфиг, `ready: false`.
   **Формат JSON, не ES-модуль**: динамический `import()` запрещён в SW (§4.1).
4. Минимум для работы: `FIREBASE_DATABASE_URL` (Realtime Database; готовность
   вычисляется как `!!config.databaseURL`).

### 8.5. Options-страница (`chrome://extensions` → «Настройки»)

- Нет конфига → предупреждение с инструкцией (§8.4).
- Нет фразы → «Создать фразу» (обязательный чекбокс «я сохранил») или ввод
  своей → «Сохранить и войти» (`atr:phrase:set`).
- Есть фраза → userId, последняя синхронизация, статус, блок «Кодовая фраза»
  (маска `•••• …` по умолчанию; кнопки **«Показать»** — раскрывает/прячет текст,
  **«Копировать»** — `navigator.clipboard.writeText`, фидбек «Скопировано» на
  1.5 с; фразу отдаёт `atr:status` → поле `phrase`; виден только на
  options-странице, страница author.today его не получает), «Синхронизировать
  сейчас» (`atr:sync:sync` с пустым `entries` — pull+проверка связи;
  дошлёт локальное только content-вкладка), «Выйти» (`atr:phrase:clear`).
  Фраза нужна в любой момент: потеря = потеря доступа к облаку (§8.6).

### 8.6. Сценарии

- **Первое устройство**: заполнить `.env` → `npm run config` → загрузить
  расширение → options → «Создать фразу» → сохранить фразу → кликать отметки,
  они уходят в облако (push после клика).
- **Второе устройство**: настроить тот же конфиг → ввести ту же фразу →
  открыть author.today → pull затянет отметки, дальше LWW.
- **Потеря/смена фразы**: старая фраза неизвестна → облако нечитаемо
  (можно только затереть запись новой фразой — LWW по времени перетрёт).
  Хранить фразу в безопасном месте — единственный способ доступа.
