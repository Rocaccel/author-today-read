# AGENTS.md — спецификация расширения «Author.Today — отметки книг»

Этот файл — **единственный источник истины** по проекту. Цель документа: любой
нейросеть/агент должна суметь **полностью воссоздать расширение с нуля**, только
прочитав этот файл.

Папка проекта: `C:\Users\ser\Desktop\GitHub\author-today-read`
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
   (настройки/фраза/статус, §8.5). Иконка в тулбаре есть (v0.2.3): тоже без
   попапа — клик по ней открывает Параметры (`chrome.action.onClicked` →
   `openOptionsPage`, §4.3).
4. Firebase — **реальный REST-клиент** (`background/firebase.js`, v0.2.0);
   конфиг подставляется из `.env` → `npm run config` (файлы в .gitignore,
   секретов в репо нет).
5. Стек — **чистый JavaScript без сборки** (никаких npm/vite/esbuild/TypeScript;
   firebase-SDK не используется — только REST API по fetch).
6. Подробные комментарии на русском в ключевых логических блоках (интеграция в DOM,
   обработчики кликов, хранение) — требование исходного ТЗ.

### 1.1. Семантика кнопок (переключатели с заменой)

| Текущее состояние | клик `+`                 | клик `−`                 |
| ----------------- | ------------------------ | ------------------------ |
| пусто (`null`)    | `✅` (`"read"`)           | `❌` (`"skip"`)           |
| `✅` (`"read"`)    | пусто (запись удаляется) | `❌` (`"skip"`)           |
| `❌` (`"skip"`)    | `✅` (`"read"`)           | пусто (запись удаляется) |

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

**Исключение — скрытие отмечённых (v0.2.5):** тумблер «Скрыть отмечённые»
(`.atr-hide-toggle`) живёт в шапке списка (`.panel-actions`, §2.6) и
появляется только там, где есть view-контролы (каталог/поиск с переключателем
вида); **в tile-виде тумблер скрывается**, но **область скрытия шире области
панелей**: при включённом pref карточки `.bookcard` привязываются к workId
(по ссылке `/work/NNN`, атрибут `data-atr-row`) и отмеченные скрываются
классом `.atr-marked` — панели `[+][−]` в плитку по-прежнему НЕ ставятся.
Состояние тумблера — отдельный ключ localStorage `atr.ui.hideMarked` (§3.1).

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

### 2.6. Шапка списка: переключатель вида и тумблер (проверено вживую 13.10.2026)

Шапка `#search-results` (и каталога, и поиска) — общий якорь для тумблера
v0.2.5 — `.panel-actions`:

**Каталог** `/work/genre/...` — client-side Knockout, три кнопки (§2.4.2),
активная имеет класс `active`:

```html
<div class="clearfix">
  <h1 class="panel-title pull-left">Книги в жанре Фэнтези</h1>
  <div class="panel-actions pull-right">
    <button data-bind="click: switchView.bind($data, 'list')" class="btn btn-only-icon mr-sm btn-default active"><i class="icon-list"></i></button>
    <button data-bind="click: switchView.bind($data, 'tile')"  class="btn btn-only-icon mr-sm btn-only-brd"><i class="icon-grid"></i></button>
    <button data-bind="click: switchView.bind($data, 'table')" class="btn btn-only-icon btn-only-brd"><i class="icon-bars"></i></button>
  </div>
</div>
```

**Поиск** `/search?category=works` — те же три вида, но НЕ кнопки, а
pjax-ссылки в своём `.panel-actions` (внутри `.panel-heading`):

```html
<div class="panel-heading">
  <span>Поиск произведений</span>
  <div class="panel-actions" data-pjax="">
    <a href="/search?category=works&q=...&view=list"  class="btn btn-only-icon btn-default mr-sm active" rel="nofollow">…</a>
    <a href="/search?category=works&q=...&view=table" class="btn btn-only-icon btn-default mr-sm" rel="nofollow">…</a>
    <a href="/search?category=works&q=...&view=tile"  class="btn btn-only-icon btn-default" rel="nofollow">…</a>
  </div>
</div>
```

Правила для тумблера (v0.2.5, content/dom.js):
- **якорь** — `.panel-actions` (единственная точка, общая для обоих вариантов);
- **guard** — на странице есть view-контролы:
  `[data-bind*="switchView"]` **или** `a[href*="view="]`; без них (главная,
  страница книги, `/search` без категории) тумблер не рисуется;
- **tile-вид** — активна KO-кнопка с `'tile'` в `data-bind` либо активная
  ссылка `view=tile` → тумблер получает `hidden` (скрытие при этом работает);
- `/search` без `category` (сетка без переключателя) и главная — guard не
  проходит, тумблера нет.

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
  «воскресло» бы на другом устройстве при следующем pull. **Исключение (GC,
  v0.2.1):** томбстоуны старше **90 дней** удаляются принудительно — но НИКОГДА
  не самим content: список приходит из background в `res.gc` → `storage.applyGc()`
  (самостоятельная чистка воскресила бы старую облачную отметку при pull), см. §8.
- `t` — epoch_ms последнего изменения (проставляется в `set`/`remove`).
- Снятие отметки = запись `{ m: null, t: now }` (в v0.1.0 было `delete`).
- Запись атомарная: прочитал весь объект → изменил одно поле → записал весь объект.
- Повреждённый JSON — не ронять: считать пустым объектом и залогировать в консоль.
- Кросс-табная синхронизация: событие `storage` (window) → перерисовка панелей
  (подписка в content/dom.js).
- **`atr.ui.hideMarked`** (v0.2.5): `'1'` — включён тумблер «Скрыть
  отмечённые», ключ отсутствует — выключен (дефолт). Отдельный
  UI-preference ключ страницы (НЕ отметки): читает/пишет только content
  (dom.js), новый независимый ключ — миграция не нужна; межвкладочная
  синхронизация — нативное событие `storage` (ветка этого ключа в dom.js).

### 3.2. Миграция v1 → v2

- Одноразовая, в `getAll()` (content/storage.js): нет ключа v2, но есть v1 →
  `{workId: mark}` превращается в `{workId: {m: mark, t: Date.now()}}`,
  значения вне `{read, skip}` отбрасываются; v2 записывается, **v1 удаляется**.

### 3.3. Фраза и статусы — `chrome.storage.local` (background)

- Ключи: `atr.sync.phrase` (нормализованная фраза), `atr.sync.userId`,
  `atr.sync.lastSync`, `atr.sync.lastError`,
  **`atr.sync.stats`** (`{read, skip, total, at}` — кэш счётчиков, v0.2.2;
  обновляется из content-вкладок при каждом `atr:sync:sync`, см. §4.2/§8.5),
  **`atr.sync.snapshot`** (`{entries, at}` — последний срез от content,
  v0.2.4; данные для «Экспорт JSON», пишется там же в `handleSync`),
  **`atr.sync.pendingImport`** (санитизованные entries из файла, v0.2.4;
  пишет options, применяет и удаляет content, см. §8.5),
  **`atr.sync.wipePending`** (timestamp старта полного вайпа, v0.2.6;
  пишет options/SW после успешного удаления облака, применяет и удаляет
  content — стирает localStorage страницы, см. §8.8),
  **`atr.sync.deviceId`** (uuid этого устройства, v0.2.6, §8.9;
  генерируется `crypto.randomUUID()` при первом sync/запросе списка,
  регистрирует устройство в `users/{userId}/devices/`; удаляется при
  тихом сбросе и вайпе — следующий вход создаёт НОВОЕ устройство).
- Фраза хранится ТОЛЬКО здесь (читает только расширение); в page localStorage
  не попадает — сайт author.today её не видит.
- Требует `"permissions": ["storage"]` в manifest.

### 3.4. Облако — Firebase Realtime Database (см. §8)

Путь `users/{userId}/marks/{workId}`, формат узла — §8.2.
Отметки в облаке всегда шифрованные; ключ — только от кодовой фразы.

---

## 4. Архитектура и состав файлов

```
author-today-read/
├── AGENTS.md                    ← этот файл (спецификация)
├── README.md                    ← пользовательская инструкция (установка, использование, вход по фразе)
├── DEVELOPMENT.md               ← для разработчиков: структура, тесты, настройка синхронизации из исходников
├── LICENSE                      ← 0BSD (текст лицензии)
├── .env                         ← конфиг Firebase (GITIGNORE, заполняет пользователь)
├── package.json                 ← тесты + `npm run config` (jsdom devDependency)
├── scripts/
│   ├── apply-config.js          ← .env → extension/background/config.json (npm run config)
│   ├── perf.js                  ← A/B-замер влияния расширения на скорость страницы (npm run perf)
│   └── release.ps1              ← релиз §9 одной командой: zip/crx/тег/gh release (npm run release)
├── tests/
│   └── smoke.test.js            ← автотесты jsdom (инжект, семантика, v2, LWW, фраза, крипто, sync)
└── extension/                   ← содержимое расширения (грузится в Chrome)
    ├── manifest.json            ← MV3: permissions storage, host_permissions rtdb, options_ui, icons/action
    ├── icons/                   ← PNG 16/32/48/128 (v0.2.3, бинарные ассеты — §7)
    ├── content/
    │   ├── storage.js           ← модуль хранения (localStorage, схема v2 + миграция + mergeRemote)
    │   ├── sync.js              ← синхронизация: content ↔ background через chrome.runtime
│   ├── ui.js                ← создание/обновление панели [+] [индикатор] [−]
│   ├── dom.js               ← сканирование DOM, вставка, MutationObserver, pjax,
│   │                           тумблер «Скрыть отмечённые» (v0.2.5)
│   ├── main.js              ← точка входа (sync.init + dom.start)
│   └── styles.css           ← стили панели и тумблера (light + dark)
    ├── shared/
    │   ├── phrase.js            ← ES-модуль: кодовая фраза, userId, PBKDF2/AES-GCM (options + background)
    │   └── backup.js            ← ES-модуль: экспорт/импорт отметок в JSON (v0.2.4, только options)
    ├── options/
    │   ├── options.html         ← страница настроек (chrome://extensions → Настройки)
    │   ├── options.js           ← генерация/ввод фразы, статус, ручная синхронизация, выход, смена фразы (v0.2.6)
    │   └── options.css
    └── background/
        ├── service-worker.js    ← ES-модуль: роутер сообщений + хранилище фразы + кэш статистики + action-клик
        ├── firebase.js          ← Realtime Database REST-клиент (GET/PATCH/DELETE .json, sync, rotate)
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

| функция                | сигнатура                                         | что делает                                                                                                              |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `getAll()`             | `() → Object`                                     | весь объект `{wid: {m, t}}` (после миграции v1; повреждённый JSON → `{}`)                                               |
| `get(workId)`          | `(string) → "read"\|"skip"\|null`                 | текущая отметка (томбстоун/нет записи → null)                                                                           |
| `getStamp(workId)`     | `(string) → number`                               | epoch_ms последнего изменения, 0 если нет записи                                                                        |
| `set(workId, mark)`    | `(string, "read"\|"skip") → void`                 | запись `{m, t: Date.now()}`                                                                                             |
| `remove(workId)`       | `(string) → void`                                 | **томбстоун** `{m: null, t}` (не `delete`); уже томбстоун → no-op                                                       |
| `toggle(workId, mark)` | `(string, "read"\|"skip") → "read"\|"skip"\|null` | семантика §1.1; после изменения шлёт `document` событие `'atr:changed'` с `{detail:{workId}}`                           |
| `mergeRemote(remote)`  | `(Object) → string[]`                             | LWW-слияние облачных данных: принимает запись, если её `t` **больше** локального; возвращает список изменившихся workId |
| `applyGc(wids)`        | `(string[]) → string[]`                           | **GC (v0.2.1):** жёсткое удаление записей БЕЗ томбстоуна (иначе цикл); список приходит ТОЛЬКО из `res.gc` background; шлёт `document` событие `'atr:gc'` `{detail:{wids}}` (слушает dom.js для перерисовки; `atr:changed` НЕ шлём — пушить после gc нечего) |
| `wipeAll()`            | `() → string[]`                                   | **Полный вайп (v0.2.6, §8.8):** жёсткое удаление `atr.v2.marks` + `atr.v1.marks` (без томбстоунов) → возвращает снятые workId → шлёт `document` событие `'atr:wipe'` `{detail:{wids}}` (слушает dom.js: снять pref `atr.ui.hideMarked`, обновить тумблер, перерисовать; **`atr:changed` НЕ шлём** — пушить нечего, фраза уже удалена) |

Константы: `ATR.storage.KEY_V2 = 'atr.v2.marks'`, `KEY_V1 = 'atr.v1.marks'`,
`MARK_READ = 'read'`, `MARK_SKIP = 'skip'`.

**`content/sync.js` → `ATR.sync`**

| функция         | что делает                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isSupported()` | есть ли `chrome.runtime.sendMessage` (в тестах может отсутствовать)                                                                                                                                                                                                                                       |
| `init()`        | подписка на `'atr:changed'` (debounce push 1.5 с), `focus` окна (pull не чаще 30 с), **`online` окна (немедленный повтор после восстановления сети, v0.2.1)** + первый `syncNow()` при загрузке страницы (**после применения отложенного импорта, затем вайпа** — цепочка `applyPendingImport → applyWipePending → syncNow`, v0.2.4/0.2.6) + слушатель `chrome.storage.onChanged`: ветка `atr.sync.pendingImport` (v0.2.4), **ветка `atr.sync.phrase` (v0.2.6): сохранение/смена фразы в options (вход, ротация) → немедленный `syncNow()`; `newValue: undefined` (выход) → ничего** и **ветка `atr.sync.wipePending` (v0.2.6): вкладка немедленно стирает свой localStorage (`applyWipePending`)** |
| `syncNow()`     | один round-trip: шлёт `{type:'atr:sync:sync', entries: getAll()}` → принимает `res.pull` → `storage.mergeRemote()` → `ui.renderAll(wid)` (БЕЗ события `atr:changed`, чтобы не зациклить push) + `storage.applyGc(res.gc)` (v0.2.1). Одновременно только один запрос (inFlight + pending). Исходы: **ok** → сброс backoff; **skip** (нет конфига/фразы) → не ретраится; **fail** (сеть/SW) → `scheduleRetry()`; **retry-soon** (v0.2.6: SW ответил guard'ом ротации «идёт смена кодовой фразы» — storage-событие обогнало снятие флага) → `schedulePush()` (повтор ~1.5 с, НЕ backoff) |
| `applyPendingImport()` | **Импорт из файла (v0.2.4):** читает `atr.sync.pendingImport` из `chrome.storage.local` → `storage.mergeRemote()` (LWW по `t`: более новые локальные не затираются, томбстоуны переносятся) → рендер изменившихся → удаление ключа → `syncNow()` (push). Идемпотентно (in-flight + удалённый ключ); работает и без `chrome.storage` в стабах (guard) |
| `applyWipePending()`   | **Полный вайп (v0.2.6, §8.8):** читает `atr.sync.wipePending` из `chrome.storage.local` → `storage.wipeAll()` (стирание localStorage + событие `'atr:wipe'`) → удаление ключа → `syncNow()` (без сети: фразы уже нет → skip, но кэш `atr.sync.stats` обнуляется нулями). Идемпотентно (in-flight `wipeInFlight` + удалённый ключ); работает и без `chrome.storage` в стабах (guard) |
| `scheduleRetry()` / `resetRetry()` | **Ретраи (v0.2.1):** backoff `5с → 15с → 1м → 5м → 15м` (потолок, дальше каждые 15 м; таблица `retryDelays`, тестовый хук `__setRetryDelays`). Один ожидающий таймер (идемпотентно); успех обнуляет. Цепочка живёт, пока открыта вкладка — данные всегда в localStorage, смерть вкладки не теряет их |

**`shared/phrase.js` (ES-модуль, options + background)**

| экспорт                                                       | что делает                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `WORDLIST`, `PHRASE_WORDS=15`, `MIN_WORDS=12`, `MAX_WORDS=30` | встроенный список из 128 слов и лимиты                            |
| `generatePhrase(n?)`                                          | 15 случайных слов через `crypto.getRandomValues`                  |
| `normalizePhrase(s)`                                          | lowercase + trim + схлопывание пробелов                           |
| `validatePhrase(s)`                                           | null если ок, иначе текст ошибки (12–30 слов)                     |
| `deriveUserId(phrase)`                                        | `hex(SHA-256(normalize(phrase)))` — userId, путь в БД             |
| `deriveKey(phrase)`                                           | PBKDF2-SHA256(соль `"atr.sync.v1"`, 100k) → AES-GCM-256 CryptoKey |
| `encryptMark(key, mark)`                                      | `{v, iv, ct}` (base64); iv — 12 случайных байт                    |
| `decryptMark(key, payload)`                                   | обратно `"read"\|"skip"\|null`; неверный ключ → исключение        |

**`background/firebase.js` (ES-модуль, реальный REST-клиент)**

| функция                         | что делает                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadConfig()`                  | кэшированный `fetch(chrome.runtime.getURL('background/config.json'))` (`.ok ? json : {}`, catch → пустой конфиг) → `{config, ready}` (ready = `!!databaseURL`; файла может не быть)                                                                                                                                                                             |
| `__setConfigForTest(config)`    | тестовый хук (npm test): подменяет кэш `configPromise` напрямую, минуя fetch config.json (прецедент — `__setRetryDelays` в content/sync.js; нужен, потому что `loadConfig` кэширует `ready:false` после [14]) |
| `initFirebase(config)` → клиент | `isReady()` (databaseURL), `pullDocs(userId)` (GET `{db}/users/{uid}/marks.json`; пустое дерево → `null` → `[]`), `sync(userId, phrase, localEntries, deviceId)` → **`{pull, pushed, skipped, gc, devices}`**: расшифровывает облако, пушит локальное новее облака одним `PATCH`, возвращает облачное новее локального + список `gc` протухших томбстоунов (v0.2.1, §8); marks и devices читаются параллельно (`Promise.all`), список устройств при ошибке → `null` (старые правила — sync не падает, §8.9); **`{reset: true}`** при `devices[deviceId].deleted === 1` — ранний возврат ДО push/GC: `{pull:{}, pushed:0, skipped:0, gc:[], devices, reset:true}` (§8.9); `deleteDocs(userId, wids)` — PATCH с `{wid: null}` (удаление узлов); **`rotate(...)`** (v0.2.6, §8.7) → `{migrated, skipped}`: LWW-слияние → перешифровка → **один PATCH** на новый путь → **только после успеха PATCH** `DELETE users/{oldUid}/marks.json` → затем best-effort перенос `devices` (GET старого → PATCH нового → DELETE старого; сбой/403 → `console.warn`, ротация НЕ проваливается, §8.9); ошибка HTTP — исключение со свойством `status` |
| `GC_TOMBSTONE_MS` (экспорт)     | `90 * 24 * 60 * 60 * 1000` — срок жизни томбстоунов (v0.2.1); живые отметки GC не трогает никогда                                                                                                                                                                                                                                                             |
| `clearCloud(userId)`           | **Полный вайп (v0.2.6, §8.8):** один `DELETE {db}/users/{uid}/marks.json` — удаляет узел `marks` целиком; затем best-effort `DELETE …/devices.json` (сбой → `console.warn`, вайп не проваливается — чужие устройства просто увидят пометку позже); идемпотентен; HTTP-ошибка marks → исключение `wipe-cloud: HTTP …` — вызывающий НЕ трогает локальные данные |
| `getDevices(userId)`           | **Список устройств (v0.2.6, §8.9):** GET `{db}/users/{uid}/devices.json` → `{deviceId: {name, platform, createdAt, lastSeen, deleted?}}`; пустое дерево → `{}`; ошибка → исключение `devices-get: HTTP …` (свойство `status`) |
| `putDevice(userId, deviceId, data)` | **PATCH по ПУТИ узла** `{db}/users/{uid}/devices/{deviceId}.json` — тело мержится в существующий узел (частичный `{name}` НЕ затирает `platform/createdAt/deleted`; PATCH вложенным объектом `{id:{...}}` затёр бы узел — поэтому API работает только через `deviceUrl`) |
| `deleteDevice(userId, deviceId)` | DELETE `{db}/users/{uid}/devices/{deviceId}.json` — удаляет узел устройства целиком (не «пометку deleted»); идемпотентен (узла нет → ok); ошибка → `devices-delete: HTTP …` |

**`background/service-worker.js` (роутер `chrome.runtime.onMessage`)**

| сообщение          | вход → выход                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `atr:status`       | `→ {ok, configReady, hasPhrase, phrase, userId, lastSync, lastError, stats, ready}` (`phrase` — для кнопок Показать/Копировать в options, §8.5; **`stats`** — `{read, skip, total, at}`, дефолт нули, v0.2.2)                             |
| `atr:phrase:set`   | `{phrase}` → валидация, `deriveUserId`, сохранение в `chrome.storage.local` → `{ok, userId}` / `{ok:false, error}`                                                                                                                         |
| `atr:phrase:clear` | `→ {ok}` (удаляет фразу/userId/ошибку)                                                                                                                                                                                                     |
| `atr:phrase:rotate` | `{phrase}` (v0.2.6) → `rotating=true` синхронно до первого await → drain незавершённых sync (новые `atr:sync:sync` в это время отклоняются guard'ом до инкремента счётчика) → проверки: конфиг (`ready`), есть текущая фраза, валидность новой, не совпадает ли с текущей → `firebase.rotate(...)` → **ТОЛЬКО после успеха** сохранение новой фразы/userId/`lastSync` в `chrome.storage.local` → `{ok, userId, migrated, skipped}` / `{ok:false, error}` (при сбое хранилище и старый путь не тронуты — повтор безопасен) |
| `atr:sync:sync`    | `{entries}` → **сначала кэш статистики и снапшота** (v0.2.2/0.2.4: `computeStats(entries)` → `atr.sync.stats` + `entries` → `atr.sync.snapshot`, ТОЛЬКО если `sender.tab` — options со своим `entries:{}` ничего не трогает; до проверок конфига/фразы) → **регистрация устройства** (v0.2.6, §8.9): `getDeviceId()` (uuid из `atr.sync.deviceId`) + `putDevice` `{name: deviceNameFromUA(), platform, createdAt, lastSeen}` — best-effort, heartbeat не чаще 30 мин (`DEVICE_SEEN_THROTTLE_MS`); затем **детект тихого сброса**: свой `devices[deviceId].deleted === 1` → `performRemoteReset(client, userId, deviceId, floor=1)` → `{ok:true, reset:true}` (контент повторно НЕ ретраит, §8.9); далее полный round-trip → `{ok, pull, pushed, skipped, gc}` либо `{ok:false, skip:true, reason:'config'\|'phrase'}` (не ошибка!) либо `{ok:false, error}` (сеть/правила, текст сохраняется в `atr.sync.lastError`; content ретраит с backoff, §4.2) |
| `atr:data:wipe`     | **Полный вайп (v0.2.6, §8.8):** `opLabel='wipe'` синхронно до первого await → drain незавершённых sync (новые `atr:sync:sync` отклоняются guard'ом «идёт удаление данных») → **порядок операции:** есть конфиг? (`no-config`) → `clearCloud` при готовности и фразе (`no-phrase` — пропуск облака; сбой → `{ok:false, error}`, локальное НЕ тронуто) → удаление 8 ключей (`phrase`, `userId`, `lastSync`, `lastError`, `stats`, `snapshot`, `pendingImport`, `deviceId`) → установка `atr.sync.wipePending` → `{ok, cloudDeleted, reason}`; catch → `lastError` + `{ok:false, error}`, флаг не ставится |
| `atr:devices:list`  | **v0.2.6, §8.9:** `→ {ok:true, devices:[{id, name, platform, createdAt, lastSeen, own, removed?}], ownId}` — `getDevices`, удалённые (`deleted`) отфильтрованы (своя строка идёт с `removed:true`), `own = id === ownId`, сортировка по `lastSeen` (новые выше); свой `deleted: 1` → `{ok:false, reset:true}` (`performRemoteReset`, floor=0); ошибка → `{ok:false, error}`, при HTTP 403 — текст «…правила БД…» |
| `atr:devices:rename` | `{id, name}` → guard `busyGuard()` (тексты «идёт смена кодовой фразы»/«идёт удаление данных») → валидация: нет `id`/фразы/конфига, trim + схлопывание пробелов, длина 1–40 (иначе `{ok:false, error}`); `getDevices` → устройства нет либо `deleted` → «не найдено» (без PATCH — узел не создаётся из ничего) → `putDevice(userId, id, {name})` → `{ok:true}`; 403 → ошибка со словом «правила» |
| `atr:devices:remove` | `{id}` → guard `busyGuard()` → нет фразы/конфига → ошибка; **свой id → `{ok:false, error}` без сетевых запросов** («своё устройство удалить нельзя» — сброс выполняется только тихо через `atr:sync:sync`); чужое → `putDevice(userId, id, {deleted:1})` (частичный PATCH не затирает `name/createdAt`); уже `deleted` → `{ok:true}` без PATCH (идемпотентно); 403 → ошибка с подсказкой про правила БД |

`computeStats(entries)` — экспорт service-worker.js: `{read, skip, total, at}`;
томбстоуны (`m:null`) и мусор не считаются, `total = read + skip`.
Роутер передаёт хендлерам `(msg, sender)` — `sender.tab` отличает
content-вкладку от options-страницы.

`options/options.js` — чистый UI: `generatePhrase/validatePhrase/normalizePhrase`
из shared + те же 9 сообщений (`atr:status`, `atr:phrase:set`, `atr:phrase:clear`,
`atr:phrase:rotate`, `atr:sync:sync`, `atr:data:wipe`, `atr:devices:list`,
`atr:devices:rename`, `atr:devices:remove`); локальных данных не хранит.

**`shared/backup.js` (ES-модуль, только options; v0.2.4, §8.5)**

| экспорт              | что делает                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `BACKUP_FORMAT/BACKUP_VERSION` | `'atr.marks'` / `1` — метка и версия файла                                                               |
| `serializeMarks(entries)` | срез `{wid:{m,t}}` → строка JSON файла `{format, version, exportedAt, count, entries}` (санитизованный, томбстоуны включены) |
| `parseBackup(text)`  | файл → `{entries, count}` либо `{error}` (человекочитаемый текст); отбраковывает чужой формат, версию >1 и записи с невалидными `m`/`t`/`wid` |

**`content/ui.js` → `ATR.ui`**

| функция             | сигнатура                | что делает                                                                                                                    |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `create(workId)`    | `(string) → HTMLElement` | возвращает `<span class="atr-controls" data-atr-wid="ID">` с кнопками `[+] [span.atr-status] [−]` и навешенными обработчиками |
| `render(root)`      | `(HTMLElement) → void`   | читает отметку и обновляет текст индикатора/классы кнопок у конкретной панели                                                 |
| `renderAll(workId)` | `(string) → void`        | обновляет все панели этого workId (на странице может быть одна, но перестраховка) **+** вызов `ATR.dom.applyHideFilter(workId)` с guard — пересчёт скрытия строки при включённом тумблере (v0.2.5; путь клика/pull/импорта/GC, где нет полного `scan`) |

Поведение кнопок: `click → event.preventDefault(); event.stopPropagation(); →
ATR.storage.toggle(...) → ATR.ui.renderAll(workId)`. `stopPropagation` обязателен —
на строках таблицы/списка бывают свои обработчики кликов.

**`content/dom.js` → `ATR.dom`**

| функция                | что делает                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isEnabledPage()`      | `true`, если `location.pathname` начинается с `/search` или `/work`                                                                                                                                      |
| `isBookPage()`         | `true`, если `location.pathname` матчится с `/^\/work\/(\d+)$/` (одиночная страница книги, §2.5)                                                                                                         |
| `findWorkLink(target)` | ищет внутри `target` ссылку на книгу (`/work/(\d+)`, умеет абсолютные URL); возвращает `{ link, workId }` или null                                                                                       |
| `findTargets()`        | `NodeList` точек вставки: `.book-row .book-title` (только элементы-строки!) и `table.books-table tbody td:first-child`                                                                                   |
| `inject(target)`       | идемпотентно: если внутри уже есть `[data-atr-wid]` — выйти; иначе создать панель (`ATR.ui.create`) и вставить **сразу после ссылки на книгу**; после вставить `ATR.ui.render`; строка (`.book-row`/`tr`) дополнительно получает атрибут `data-atr-row="wid"` — точку скрытия (v0.2.5) |
| `injectBookPage()`     | страница книги (§2.5): `workId` из `location.pathname`; идемпотентно (проверка `[data-atr-wid]` **внутри h1**) иначе `ATR.ui.create` → `h1.append(panel)` → `ATR.ui.render`; если `h1` не найден — выйти |
| `isPrefOn()`           | `() → boolean` — включён ли pref `atr.ui.hideMarked` в localStorage страницы (v0.2.5, §3.1) |
| `hasViewControls()`    | `() → boolean` — на странице есть view-контролы (`.panel-actions` + KO-кнопки/pjax-ссылки, §2.6); guard для тумблера |
| `isTileView()`         | `() → boolean` — текущий вид «плитка» (активная KO-кнопка `'tile'` либо активная ссылка `view=tile`) |
| `injectHideToggle()`   | идемпотентная вставка `<button class="atr-hide-toggle" data-atr-toggle>` в `.panel-actions`; клик → `togglePref()` (переключение pref + мгновенный `applyHideFilter`); в tile-виде получает `hidden` |
| `tagTileCards()`       | тегирует карточки `.bookcard` атрибутом `data-atr-row="wid"` (wid из ссылки `/work/NNN`) — без панелей, только для скрытия (v0.2.5) |
| `applyHideFilter(wid?)`| pref включён → строки/карточки с активной отметкой получают класс `.atr-marked` (`display:none`); выключен → класс снят везде; аргумент `wid` ограничивает проход одной книгой (точечный вызов из `ui.renderAll`) |
| `scan()`               | полный проход: `injectHideToggle()` → `findTargets()` + `inject()` **плюс** `injectBookPage()` → `tagTileCards()` → `applyHideFilter()`; главный вход |
| `start()`              | первичный `scan()` + `MutationObserver` на `document.body` (childList, subtree) с debounce ~150 мс + слушатели `'pjax:end'`, `'pjax:success'` (document), `'atr:changed'` (document), `'atr:gc'` (document, v0.2.1 — перерисовка после GC), `storage` (window: ветка `atr.v2.marks`/`null` → `renderExisting()` + `applyHideFilter()`; ветка `atr.ui.hideMarked` → обновление тумблера + `applyHideFilter()`, v0.2.5) |

Идемпотентность — ключевое: повторные `scan()` **не должны дублировать** панели
(проверка `target.querySelector('[data-atr-wid]')`).

### 4.3. Структура manifest.json (v0.2.6)

```json
{
  "manifest_version": 3,
  "name": "Author.Today — отметки книг",
  "version": "0.2.6",
  "description": "Отметки ✅/❌ рядом с названиями книг в списках, таблицах и на странице книги. Синхронизация между устройствами через Firebase по кодовой фразе.",
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "action": {
    "default_icon": { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png" },
    "default_title": "Author.Today — отметки книг (открыть параметры)"
  },
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

**Иконки (v0.2.3, добавлены по явному запросу пользователя):** PNG 16/32/48/128
в `extension/icons/`, источник — SVG-мастер «книга с галочкой на зелёном тайле»
(`#2E9E5F`, генерировался скиллом logo-design; мастер не в репо — при
изменении цвета/формы спросить пользователя). `action` без попапа: клик →
Параметры (`chrome.action.onClicked` в service-worker.js). Правило: эти бинарные
ассеты не пересоздавать и не добавлять новые без запроса (§7).

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
- **Тумблер «Скрыть отмечённые» (v0.2.5)** — `<button type="button"
  class="atr-hide-toggle" data-atr-toggle aria-pressed>` в `.panel-actions`
  шапки списка: текст-переключатель «Скрыть отмечённые» ⇄ «Показать все»,
  своё правило в `styles.css` (не зависимо от классов сайта; светлая тема —
  серый баттон, тёмная — `html.dark .atr-hide-toggle`, активное состояние
  `aria-pressed="true"` — акцентный зелёный `#2E9E5F`, тот же что у иконки
  расширения); `title` по состоянию; в tile-виде — атрибут `hidden`
  (+ страховка `.atr-hide-toggle[hidden]{display:none!important}`).
- **Скрытие**: класс `.atr-marked` на строке/карточке при включённом pref →
  `display:none !important` (одно правило для list/table/tile).

---

## 6. Чеклист проверки (прогнать перед сдачей)

0. **Автотесты** (нужен Node.js): из корня проекта `npm install` (один раз) →
   `npm test`. Тест `tests/smoke.test.js` в jsdom проверяет: инжект в строку и
   таблицу, отсутствие панелей в плитке и на чужих страницах, полную семантику
   кнопок (§1.1), схему хранилища v2 и миграцию v1→v2, LWW-слияние с томбстоунами,
   страницу книги (панель внутри `h1.book-title`), генерацию/валидацию фразы,
   детерминированный userId, round-trip AES-GCM (чужой ключ падает), sync-протокол
   content↔background (chrome-стаб), ретраи и GC (секции [12]–[13]), статистику
   ([14]), бэкап JSON ([15]), тумблер «Скрыть отмечённые» ([16], v0.2.5),
   ротацию фразы ([17], v0.2.6): отказы до сети, drain/guard, миграция
   LWW + перешифровка, порядок PATCH → DELETE, сбой PATCH → повтор,
   реакция открытой вкладки на сохранение/смену фразы (17г), полный
   вайп ([18], v0.2.6): no-config/no-phrase, откат при сбое DELETE,
   guard «удаление данных», 8 ключей + флаг, content-стирание (init и
   onChanged), событие `atr:wipe`, идемпотентность, и устройства с тихим
   сбросом ([19], v0.2.6): URL/PATCH-мерж devices, `{reset:true}` без
   push, ранний возврат до GC, 403-деградация, регистрация + heartbeat
   30 мин, список/фильтр/ownId, rename/remove валидация и отказ self-delete,
   перенос devices при ротации, чистка `deviceId` при вайпе, content не
   ретраит `reset:true`.
   Все проверки должны быть `ok`, итог «ВСЕ ТЕСТЫ ПРОЙДЕНЫ».
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
18. **Ретраи (v0.2.1)**: отключить сеть (DevTools → Offline) → кликнуть отметку →
    в консоли «синхронизация не удалась, будет повтор» → повторы идут с backoff;
    включить сеть → событие `online` шлёт sync немедленно (без ожидания);
    «нет конфига/фразы» (`skip`) повторов НЕ порождает. Автотест — секция [13].
19. **GC томбстоунов (v0.2.1)**: снять отметку → в БД узел перезаписан
    (`updatedAt` свежий, узел НЕ удалён — томбстоун свежий); записи старше
    90 дней удаляются из БД (PATCH `{wid:null}`) и из localStorage через
    `applyGc`; живые отметки GC не трогает. Автотесты — секция [12].
20. **Статистика (v0.2.2)**: options → блок «Статистика» виден всегда (без
    фразы/конфига); после кликов на author.today счётчики ✅/❌ совпадают с
    отмеченными книгами; синк из options (свой `entries:{}`) счётчики НЕ
    обнуляет; без visited-сайта — нули (кэш пуст) и нет строки свежести;
    после визита — под счётчиками «Данные на HH:MM» (v0.2.6, из `stats.at`).
    Автотест — секция [14].
21. **Иконки (v0.2.3)**: `extension/icons/` содержит 16/32/48/128; в
    `chrome://extensions` расширение показывает зелёную книжку с галочкой
    (видно и в тёмном тулбаре, 16 px читается); клик по иконке открывает
    Параметры; манифест без ошибок (icons/action валидны).
22. **Бэкап (v0.2.4)**: Параметры → «Бэкап» → «Экспорт JSON» — скачивается
    файл с `count` отметок (нужен хотя бы один визит author.today — там
    снапшот); «Импорт JSON» с этим файлом → статус «Импортировано N» →
    открыть сайт → отметки на месте (новее файла не затёрты), ушёл push;
    битый/чужой файл → понятная ошибка, ничего не меняется. Автотесты —
    секция [15].
23. **Тумблер «Скрыть отмечённые» (v0.2.5)**: в шапке списка рядом с
    переключателем вида кнопка «Скрыть отмечённые» (в списке и таблице; на
    странице книги/главной/без переключателя — нет); клик → отмеченные
    строки/карточки исчезают, текст становится «Показать все», состояние
    помнится после перезагрузки (`localStorage` `atr.ui.hideMarked`) и
    общее для вкладок; снятие отметки возвращает строку; переключение на
    плитку → кнопка исчезает, но отмеченные карточки остаются скрытыми;
    повторный клик → всё показывается, ключ удаляется. Автотесты —
    секция [16].
24. **Смена фразы (v0.2.6)**: Параметры → «Сменить фразу» (кнопка видна только
    с фразой И настроенным конфигом) → «Сгенерировать» → чекбокс →
    «Сменить и войти» → статус обновился: новый userId (64 hex), фраза в
    блоке «Кодовая фраза» — новая. В Firebase-консоли: узел старого
    `users/{старый hash}/marks` **удалён**, новый `users/{новый hash}/marks`
    содержит ВСЕ прежние записи (расшифровываются только новой фразой);
    доступ по старой фразе пропадает. Сбой (нет сети) → ошибка в форме,
    фраза/userId прежние, повтор работает. Второе устройство: ввести новую
    фразу → те же отметки тянутся. Если вкладка author.today уже открыта —
    она подтягивает отметки сразу после смены (и после входа), без ожидания
    фокуса/перезагрузки. Автотесты — секция [17].
25. **Вайп (v0.2.6)**: Параметры → «Удаление данных» → «Удалить все данные…»
    → без чекбокса кнопка не срабатывает (ошибка) → чекбокс → «Удалить всё
    безвозвратно» → плашка с итогом. Проверить: в Firebase-консоли узел
    `users/{hash}/marks` **удалён**; `localStorage` на author.today пуст
    (`atr.v2.marks` нет) — открытая вкладка стирается сразу (без
    перезагрузки), тумблер «Скрыть отмечённые» сброшен; options показывает
    login-block, статистика `0/0/0`, бэкап «Нет данных»; фраза удалена
    («Выйти»/ротация недоступны — вход заново). Варианты: без конфига или
    без фразы → итог «Облако не тронуто…», локальное стёрто; сбой сети →
    ошибка в форме, фраза/отметки на месте, повтор работает. Автотесты —
    секция [18].
26. **Устройства и тихий сброс (v0.2.6)**: Параметры → «Устройства» (видна
    только с фразой и конфигом) → в списке есть строка текущего устройства
    с бейджем «Это устройство», платформа и время; на втором устройстве с
    той же фразой (или после входа в другой вкладке/браузере) появляется
    вторая строка. Переименовать чужую строку → имя обновилось (в
    Firebase-консоли узел `devices/{id}` содержит новое `name`, прежние
    поля не затёрты). «Удалить» на чужой → подтверждение → строка уходит
    (`deleted: 1`); удалённое устройство при следующем sync **тихо**:
    локальные отметки стёрты (открытая вкладка — сразу), фраза удалена,
    options показывает плашку «Данные удалены другим устройством…»;
    `atr.sync.deviceId` удалён — повторный вход регистрирует устройство
    заново. Кнопок удаления у своей строки нет; `atr:devices:remove` своего
    id из консоли → отказ без запроса. Старые правила БД (без `devices`) →
    карточка показывает ошибку с подсказкой про правила, sync/ротация/вайп
    работают. Автотесты — секция [19].

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
- **Бинарные ассеты** (картинки/PNG/иконки) — только по явному запросу
  пользователя. Уже добавлены: `extension/icons/*` (v0.2.3, запрос получен);
  новые/пересозданные ассеты — только после нового запроса.

---

## 8. Синхронизация с Firebase (v0.2.0; доработки: ретраи + GC v0.2.1, ротация, вайп и устройства v0.2.6)

### 8.1. Архитектура

```
[страница author.today]                       [background SW]          [Realtime Database]
content/storage.js (кэш v2)  atr:sync:sync   service-worker.js   GET/PATCH .json
content/sync.js ──────────────────────────►  firebase.js  ─────────────────►  users/{uid}/marks/*
        ▲                                       │ sha256/pbkdf2/aes           users/{uid}/devices/* (v0.2.6)
        └── merge LWW (pull) ◄─────────────────┘ из chrome.storage.local
                 options/options.js ── те же 9 сообщений ──►
```

- **Список устройств и тихий сброс (v0.2.6, §8.9)**: параллельно с marks
  читается `users/{uid}/devices` — свежий `sync` регистрирует/обновляет своё
  устройство, а увидев `deleted: 1` у своего `deviceId`, тихо стирает локальные
  данные («как после установки») без всплывашек.

- **Сеть только в background** (CORS расширения, `host_permissions`); content
  шлёт готовый срез `{wid:{m,t}}` и получает готовый pull.
- **Один round-trip `atr:sync:sync`**: pull облака → сравнение по `t` (LWW) →
  push локального новее → вернуть облачное новее локального → `mergeRemote`.
- Триггеры: загрузка любой страницы сайта, debounce 1.5 с после клика,
  фокус окна (не чаще 30 с), ручная кнопка в options, **событие `online`
  окна (немедленный повтор, v0.2.1)**, **сохранение/смена фразы в options
  — вход и ротация (v0.2.6): открытые вкладки подхватывают изменение ключа
  `atr.sync.phrase` через `chrome.storage.onChanged` и синхронизируются
  сразу, не дожидаясь фокуса/перезагрузки**.
- **Ретраи при ошибке (v0.2.1)**: сбой сети/правил/SW → повтор с backoff
  `5с → 15с → 1м → 5м → 15м` (потолок — каждые 15 мин), успех обнуляет;
  `skip` (нет конфига/фразы) — НЕ сбой, не ретраится. Цепочка per-вкладка.
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

users/{userId}/devices/{deviceId} → {          // v0.2.6, §8.9 — БЕЗ шифрования
  name:     string,    // «Chrome · Windows» или переименованное пользователем
  platform: string,    // данные UA
  createdAt: integer,  // время первой регистрации
  lastSeen:  integer,  // heartbeat (не чаще раза в 30 мин)
  deleted?: 1          // ПОМЕТКА удаления (единственное значение; нет поля = активно)
}
```

- `userId = hex(SHA-256(нормализованной фразы))` — детерминирован, одинаков
  на всех устройствах с одной фразой.
- Правила Realtime Database (пользователь настраивает в консоли:
  Realtime Database → вкладка Rules; сниппет в DEVELOPMENT.md):

```json
{
  "rules": {
    "users": {
      "$userId": {
        "marks": {
          ".read": true,
          ".write": true
        },
        "devices": {
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
    чужие workId не затрагивает (одна запись = один запрос);
  - **delete (GC, v0.2.1):** `PATCH` с `{workId: null, ...}` — в RTDB REST
    `null` удаляет узел (отдельным запросом, только если есть что удалять);
  - **delete узла (ротация, v0.2.6):** `DELETE {databaseURL}/users/{uid}/marks.json`
    — удаляет узел `marks` целиком. Идёт ТОЛЬКО на подузел `marks`: правила
    §8.2 дают `.write` именно на него, поэтому **правила БД менять не нужно**
    (на родительском `users/{uid}` delete получил бы 403);
  - **devices (v0.2.6, §8.9):** `GET/DELETE …/users/{uid}/devices.json`,
    `GET/DELETE …/users/{uid}/devices/{deviceId}.json`, `PATCH` **по пути
    узла устройства** с телом `{name}`, `{deleted:1}` и т.п. — RTDB мержит
    поля в существующий узел. При старых правилах (без `devices`) эти запросы
    получают 403: sync деградирует мягко, ротация/вайп не проваливаются.

### 8.2а. GC томбстоунов (v0.2.1)

- **Что удаляется:** только томбстоуны (`m:null`) старше **90 дней**
  (`GC_TOMBSTONE_MS`); живые отметки — никогда.
- **Где решается:** ТОЛЬКО в `background/firebase.js → sync()` — там видны и
  облако, и локальный срез. Content НИКОГДА не чистит сам (иначе следующий
  pull воскресил бы старую облачную отметку).
- **Алгоритм** (cutoff = now − 90д):
  1. расшифрованный облачный томбстоун старше cutoff → не отдаётся в `pull`,
     wid добавляется в `gc`, узел удаляется из БД (`deleteDocs`);
  2. локальный томбстоун старше cutoff → не пушится, wid в `gc`;
  3. локальная запись **новее** протухшего облачного томбстоуна → пушится
     по обычным правилам (перекрывает удаление), wid из `gc` убирается;
  4. локальная запись **старше** протухшего облачного томбстоуна → не пушится
     (иначе воскрешение), wid в `gc`;
  5. живая облачная запись новее локального протухшего томбстоуна → обычная
     жизнь: отдаётся в `pull`, merge чинит локальное, `gc` пуст.
- **Контракт:** ответ `atr:sync:sync` содержит `gc: [workId]` → content вызывает
  `storage.applyGc(wids)` — жёсткое удаление БЕЗ нового томбстоуна + событие
  `'atr:gc'` → dom.js перерисовывает панели.
- **Принятый риск:** устройство, молчащее дольше 90 дней, может затянуть и
  запушить свою старую отметку после удаления узла (отсутствие узла протокол
  читает как «данных нет», а не «удалено»). Порог 90 дней выбран пользователем;
  сокращать его без запроса нельзя.

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
  options-странице, страница author.today его не получает), **«Сменить фразу»**
  (v0.2.6: видна только при `configReady` — без конфига удалять нечего;
  открывает скрытую форму `#rotate-form` — «Сгенерировать» (чекбокс
  обязателен, как и при входе) либо своя фраза 12–30 слов → «Сменить и войти»
  → `atr:phrase:rotate`; ошибки инлайн в `#rotate-error`, успех — плашка
  «Фраза заменена. Введите её на остальных устройствах.» (`#rotate-done`),
  форма закрывается со сбросом полей; кнопки в `phrase-row`,
  `showRotateForm()/onRotateGenerate()/onRotateDo()` в options.js),
  «Синхронизировать
  сейчас» (`atr:sync:sync` с пустым `entries` — pull+проверка связи;
  дошлёт локальное только content-вкладка), «Выйти» (`atr:phrase:clear`).
  Фраза нужна в любой момент: потеря = потеря доступа к облаку (§8.6).
- **«Статистика»** (v0.2.2): карточка с тремя числами — `✅ Прочитано`,
  `❌ Пропущено`, `Всего отмечено` (+ muted-примечание). Видна **всегда**,
  даже без фразы и конфига: счётчики локальные. Данные — `atr:status` →
  поле `stats` (кэш `atr.sync.stats`, заполняет content при каждом sync,
  §3.3/§4.2). Рендер — `renderStats()` в `options.js` без условия на фразу.
  **Свежесть (v0.2.6)**: под счётчиками строка `#stat-at` «Данные на HH:MM»
  (иной день — «ДД.ММ HH:MM») из `stats.at` (`formatStatTime()`); без
  единого визита на author.today (`at: null`) — скрыта. Обновляется в тот же
  момент, что и счётчики (одно чтение `atr:status` в `refresh()`), поэтому
  числа и время свежести всегда согласованы.
- **«Бэкап»** (v0.2.4): карточка с кнопками `Экспорт JSON` / `Импорт JSON`,
  статусной строкой и (после импорта) `Открыть author.today`. Видна
  **всегда**, без фразы/конфига.
  - **Экспорт**: options читает `atr.sync.snapshot` из `chrome.storage.local`
    (кэширует background в `handleSync`, только от content-вкладок) →
    `serializeMarks()` → скачивание файла
    `author-today-marks-YYYY-MM-DD.json`. Свежесть = последний sync
    (~1.5 с после клика / при открытии страницы) — так и написано в статусе.
  - **Импорт**: `<input type=file>` → `parseBackup()` (валидация) → запись
    в `atr.sync.pendingImport` → options НЕ может писать в localStorage
    страницы, поэтому применяет content: `applyPendingImport()` при
    загрузке сайта и по `chrome.storage.onChanged` (§4.2) — слияние LWW
    по `t` (более новые локальные не затираются), затем push. Кнопка
    `Открыть author.today` (`chrome.tabs.create` — разрешения не требует)
    нужна, когда вкладки сайта нет. Импорт синхронизируется в облако
    обычным push (нужна настроенная фраза/конфиг; без них — просто
    локальное объединение).
- **«Устройства»** (v0.2.6, §8.9): карточка `#devices-block` между «Статистикой»
  и «Удаление данных», видна только при `hasPhrase && configReady` (рендер —
  `renderStatus()`); список `#devices-list` строк `.device-row`: имя (или
  «Устройство N» при пустом), muted `platform · последняя активность`,
  бейдж «Это устройство» (`device-badge`) у `own` и «Удалено» у `removed`.
  Загрузка — `loadDevices()` из `refresh()` (шлёт `atr:devices:list`), ошибка —
  `#devices-error` (в т.ч. подсказка про правила БД); увидев свой
  `{reset:true}` — `applyRemoteResetNotice()` (плашка `#wipe-done` с особым
  текстом «Данные удалены другим устройством…»). Кнопки чужой строки:
  **«Переименовать»** (инлайн-инпут, Enter/«Сохранить» → `atr:devices:rename`,
  автосброс 5 с, после успеха `refresh()`) и **«Удалить»** (двухшаговая:
  «Удалить» → «Удалить — точно?», автосброс 5 с → `atr:devices:remove`).
  Своё устройство — **без кнопок** (удаление себе запрещено и в UI, и в SW);
  после удаления чужого — `refresh()` (строка уходит, т.к. `deleted` фильтруется).
  При входе (`onLogin`) помимо `refresh()` уходит best-effort
  `atr:sync:sync {}` (регистрация устройства), затем `loadDevices(true)` —
  флаг `focusOwn` даёт автосброс inline-редактирования своей строки, но
  потребляется только когда строка реально показана.
- **«Удаление данных»** (v0.2.6, §8.8): карточка `#wipe-block` с muted-описанием
  и красной кнопкой `Удалить все данные…` (`#btn-wipe`) → раскрывает скрытую
  форму `#wipe-form`: предупреждение `alert-warning` (отметки необратимы;
  на других устройствах с той же фразой — сделать то же самое, иначе их
  отметки при следующей синхронизации воссоздадут облачный узел),
  обязательный чекбокс `#wipe-confirm-check` (без него инлайн-ошибка
  `#wipe-error`), кнопки `Удалить всё безвозвратно` (`#btn-wipe-do`) /
  `Отмена`. Вызов → `atr:data:wipe` → при успехе: форма закрывается,
  состояние фразы сбрасывается (`showWipeForm(false)`, выход из состояния
  «фраза есть», `refresh()` — login-block, нулевая статистика, `renderBackupStatus()`
  — «Нет данных для экспорта») и показывается плашка `#wipe-done` с итогом
  `wipeDoneText()` (облако+локальное; либо «Облако не тронуто: нет конфига/фразы»)
  и кнопкой `Открыть author.today` (`#btn-wipe-open-site`). Ошибки (в т.ч.
  guard «идёт удаление данных», сбой DELETE) — инлайн в `#wipe-error`, кнопка
  снова активна. Итог гасится при входе/ротации (`onLogin`/`onRotateDo`).
  Карточка видна **всегда** (вайп локального нужен и без входа — §8.8).

### 8.6. Сценарии

- **Первое устройство**: заполнить `.env` → `npm run config` → загрузить
  расширение → options → «Создать фразу» → сохранить фразу → кликать отметки,
  они уходят в облако (push после клика).
- **Второе устройство**: настроить тот же конфиг → ввести ту же фразу →
  открыть author.today → pull затянет отметки, дальше LWW.
- **Потеря фразы**: старая фраза неизвестна → облако нечитаемо. Хранить фразу
  в безопасном месте — единственный способ доступа.
- **Смена фразы при компрометации (v0.2.6, §8.7)**: options → «Сменить
  фразу» → новая фраза → все записи перешифрованы и перенесены, старая
  база удалена → **ввести новую фразу на остальных устройствах** (иначе они
  продолжат работать со старой базой: их локальные записи воссоздадут
  старый путь, новые отметки туда не попадут).

### 8.7. Ротация кодовой фразы (v0.2.6)

Смена кодовой фразы БЕЗ потери отметок: перешифровка + переезд на новый
`userId`, удаление старого узла. Реализация: `handlePhraseRotate`
(service-worker.js) → `firebase.rotate()`.

**Порядок шагов (критичен для безопасности при сбое):**

1. `rotating = true` **синхронно до первого await**; пока флаг поднят,
   `handleSync` отклоняет новые sync (`{ok:false, error:'идёт смена
   кодовой фразы'}`) guard'ом **до инкремента** `activeSyncs` — иначе
   параллельный push мог бы воскресить старый путь уже после DELETE.
2. **Drain**: `waitForDrain()` ждёт завершения sync, начатых ДО ротации
   (счётчик `activeSyncs`, таймаут 10 с → отказ «повторите попытку»).
3. Проверки **до сети**: конфиг (`ready` — без него ротация невозможна:
   старый путь недоступен и удалять нечего), текущая фраза есть, новая
   валидна (12–30 слов) и не совпадает с текущей (по фразе и по userId).
4. **`firebase.rotate(oldUserId, oldPhrase, newUserId, newPhrase, snapshot)`**:
   - **A** — GET старого пути → расшифровка СТАРЫМ ключом (битая запись →
     счётчик `skipped`, не фейл);
   - **B** — снапшот `atr.sync.snapshot.entries` (последний локальный срез
     от content): принимается только строго более новая запись
     (`entry.t > current.t`), томбстоуны `m:null` валидны;
   - **C** — GET нового пути → расшифровка НОВЫМ ключом (идемпотентность
     повторного запуска; конфликт — побеждает больший `t`);
   - перешифровка всего merged новым ключом → **один атомарный PATCH**
     на новый путь;
    - **только после успешного PATCH** — `DELETE` старого узла
      `users/{oldUid}/marks.json` (не `users/{oldUid}` — права только на
      `marks`, §8.2; правила БД не меняются);
    - затем **best-effort перенос устройств** (v0.2.6, §8.9): GET
      `users/{oldUid}/devices` → PATCH на новый userId (все поля, включая
      `deleted`) → DELETE старого узла; 403/сбой → `console.warn`,
      ротация НЕ проваливается;
    - возврат `{migrated, skipped}`.
5. **ТОЛЬКО после успешного rotate** — сохранение новой
   фразы/userId/`lastSync` в `chrome.storage.local` и сброс `lastError`.
6. `finally { rotating = false }`.

**Гарантии при сбое:** сбой на любом шаге (сеть, 403, drain-timeout)
оставляет и хранилище, и старый путь нетронутыми (PATCH не прошёл →
DELETE не выполнялся; DELETE не прошёл → фраза не сохранена) — ротацию
можно спокойно повторить. Ошибка попадает в `atr.sync.lastError` и в
форму options (`#rotate-error`).

**Не применяется:** GC (протухшие томбстоуны переезжают со своими
`updatedAt`, разберёт обычный sync нового пути, §8.2а) и
`pendingImport`/бэкап (не участвуют).

**Отказ без конфига** — осознанно: включать «режим без облака» при
компрометации нельзя (флаг-вайп «скомпрометировано» отклонён пользователем).

### 8.8. Полное удаление данных — вайп (v0.2.6)

Кнопка в options (§8.5) удаляет **всё**: облачные отметки (если доступно),
отметки в localStorage этого браузера, кодовую фразу и все статусы
расширения. Реализация: `handleDataWipe` (service-worker.js) →
`firebase.clearCloud()` → `storage.wipeAll()` + `applyWipePending()`
(content).

**Порядок операции (критичен — при сбое ничего не тронуто):**

1. `opLabel = 'wipe'` **синхронно до первого await** (общий guard с
   ротацией): пока поднят, `handleSync` отклоняет новые `atr:sync:sync`
   (`{ok:false, error:'идёт удаление данных'}`) — текст отличает вайп от
   ротации. Content такой исход НЕ ретраит как `retry-soon` (там ловится
   только строка ротации) — уйдёт обычный backoff, что верно: к моменту
   ответа фраза уже удалена и повтор станет `skip`.
2. **Drain**: `waitForDrain()` ждёт sync, начатых ДО вайпа (10 с → отказ).
3. **Проверка конфига**: нет → `reason: 'no-config'`, облако пропускается
   (удалять нечего/нет доступа), локальное чистится.
4. **`clearCloud(userId)`** — при готовном конфиге И фразе: один
   `DELETE users/{uid}/marks.json`; без фразы → `reason: 'no-phrase'`
   (облако не тронуто — расшифровать/подтвердить путь нечем); сбой →
   `{ok:false, error}` с `lastError` — **локальное НЕ тронуто**, флаг не
   ставится, повтор безопасен. Устройство при этом best-effort удаляется
   из списка (`DELETE users/{uid}/devices.json`, сбой → `console.warn`).
5. Удаление 8 ключей `chrome.storage.local`: `phrase`, `userId`,
   `lastSync`, `lastError`, `stats`, `snapshot`, `pendingImport`,
   `deviceId` (после вайпа следующий вход зарегистририрует НОВОЕ
   устройство, §8.9).
6. Установка **`atr.sync.wipePending`** (timestamp) — сигнал content.
7. Возврат `{ok, cloudDeleted, reason}`; `finally { opLabel = null }`.

**Применение на страницах (content/sync.js `applyWipePending`):**

- два входа: цепочка `init()` (`applyPendingImport → applyWipePending →
  syncNow`) — для вкладок, открывшихся ПОСЛЕ вайпа; и ветка
  `chrome.storage.onChanged` по ключу — для уже открытых;
- `storage.wipeAll()`: жёсткое удаление `atr.v2.marks` + `atr.v1.marks`
  → событие `'atr:wipe'` `{detail:{wids}}` → dom.js: снять pref
  `atr.ui.hideMarked`, обновить тумблер, перерисовать (`atr:changed` НЕ
  шлём — пушить нечего);
- удаление ключа-флага → `syncNow()`: фразы уже нет → SW ответит `skip`
  **без сети**, но `handleSync` до проверок запишет нулевую статистику в
  `atr.sync.stats` — кэш счётчиков обнуляется детерминированно;
- идемпотентность: in-flight `wipeInFlight` + уже удалённый флаг (повтор
  из onChanged — no-op).

**Свойства:** локальное стирается ВСЕГДА (даже без конфига/фразы);
облако — только когда есть конфиг и фраза; повтор после успеха —
`{ok, cloudDeleted:false, reason:'no-phrase'}`; guard ротации работает
параллельно (`opLabel` общий: ротация ↔ вайп не пересекаются).

**Принятый риск (аналог §8.6):** вкладки author.today, НЕ получившие флаг
(закрытые, но их localStorage ещё не стёрт? — нет: флаг хранится в
`chrome.storage`, открытие любой вкладки применит его при загрузке).
Реальный риск — **другие устройства**: их отметки при следующей
синхронизации снова уйдут в облако; поэтому UI прямо предупреждает
(§8.5), а итог предлагает открыть сайт.

### 8.9. Список устройств и тихий удалённый сброс (v0.2.6)

Каждое устройство с фразой регистрируется в `users/{uid}/devices/{deviceId}`
(§8.2). Устройство видит свой список в options и может **переименовать**
любую строку или **удалить чужое** — удалённое устройство при следующей
синхронизации **тихо стирает свои локальные данные и выходит из фразы**
(«как после установки»), без всплывашек и без подтверждений.

**Жизненный цикл `deviceId`:**

- ключ **`atr.sync.deviceId`** (§3.3) — uuid (`crypto.randomUUID()`),
  лениво создаётся `getDeviceId()` при первом sync или запросе списка;
- **регистрация** — в `handleSync`, best-effort: `putDevice` `{name:
  deviceNameFromUA(), platform, createdAt, lastSeen}`; heartbeat `lastSeen`
  не чаще раза в 30 мин (`DEVICE_SEEN_THROTTLE_MS`): свежий `lastSeen`
  → PATCH пропускается; старше → PATCH только `{lastSeen}`;
- **удаление ключа** — при тихом сбросе (ниже) и вайпе (§8.8): следующий
  вход = новое устройство в списке. Это же **защита от зацикливания**:
  уже сброшенное устройство не увидит свой флаг повторно;
- при **ротации фразы** (§8.7) `deviceId` НЕ меняется — узлы devices
  переезжают на новый userId (best-effort после успеха marks).

**Детект и тихий сброс:**

1. `firebase.sync()` читает marks и devices параллельно (`Promise.all`);
   список при ошибке → `null` (старые правила без `devices` → 403 → sync
   работает как раньше).
2. Ранний возврат `{pull:{}, pushed:0, skipped:0, gc:[], devices,
   reset:true}`, **ЕСЛИ** `devices[deviceId].deleted === 1` — **до push и
   GC** (чужие не получат наши данные). Повторная регистрация устройства
   в этом sync пропускается (узел уже помечен).
3. `handleSync` при `result.reset` → `performRemoteReset(client, userId,
   deviceId, floor=1)` → ответ контенту `{ok:true, reset:true}`.
4. **`performRemoteReset`** (service-worker.js): guard `opLabel='wipe'`
   (другая операция уже идёт → отказ, ничего не тронуто) →
   `waitForDrain(10000, floor)` — floor=1 из handleSync, чтобы sync НЕ
   ждал сам себя (deadlock), floor=0 из list → удаление 8 ключей (§8.8
   шаг 5, включая `deviceId`) → `set({atr.sync.wipePending: Date.now()})`
   → best-effort `deleteDevice` своего узла (самоочистка списка;
   `finally { opLabel = prevLabel }`. Возвращает `false`, если drain не
   дошёл — **ничего не тронуто**, вызывающий отвечает ошибкой («идёт
   удаление данных»).
5. Контент принимает `{ok:true, reset:true}` как обычный ok: `res.pull`
   пуст → слияний нет; `res.gc` пуст → GC не выполняется (guard'ы в
   sync.js, проверено тестом [19м]); затем флаг `wipePending` применяется
   как при вайпе (§8.8): стирает localStorage, снимает pref, шлёт sync →
   он уже `skip` (фраза удалена). **Контент НЕ ретраит** — новых сообщений
   в коде не появилось.

**Одноразовый сброс из options:** детект работает и в `atr:devices:list`
(без site-вкладок): свой флаг → `{ok:false, reset:true}` →
`performRemoteReset(floor=0)` → options показывает плашку `#wipe-done`
особым текстом («Данные удалены другим устройством…», `applyRemoteResetNotice`)
и сбрасывает состояние в UI.

**Ограничения (осознанно):**

- **своё устройство удалить нельзя**: кнопки в UI нет, `atr:devices:remove`
  своего id → отказ **без сетевых запросов**; сброс себе выполняется только
  тихо через sync (иначе потеряется смысл «тихого» сброса);
- восстановление удалённого устройства не предусмотрено (повторный вход =
  новое устройство, «Удалено» — не interactive);
- **правила БД** должны разрешать `devices` (§8.2): при старых правилах
  все devices-операции получают 403 — sync мягко деградирует, ротация/вайп
  не проваливаются, UI показывает подсказку «правила БД»; новые правила
  публикует пользователь в консоли Firebase (сниппет §8.2/DEVELOPMENT.md).

**Реестр сообщений (9, §4.2):** `atr:devices:list` →
`{ok, devices, ownId}` / `{ok:false, reset}` / `{ok:false, error}`;
`atr:devices:rename` `{id, name}` → `{ok}`; `atr:devices:remove` `{id}` →
`{ok}`. Все три под guard'ом `busyGuard()` (тексты ротации/вайпа) и с
текстом «правила» при 403.

---

## 9. Релизы

**Автоматизация:** `npm run release` (`scripts/release.ps1`, PowerShell 5.1)
выполняет пункты 1–5 одной командой. Ключи: `-BuildOnly` (только ассеты в
`dist/`, без тега/публикации), `-Title`/`-Notes` (заголовок/ноты релиза;
дефолт нот — `git log` с прошлого тега), `-Version` (иначе из
`manifest.json`), `-Chrome` (путь к chromium для `--pack-extension`).
Требования: авторизованный `gh` CLI, `extension.pem`, `.env` с
`FIREBASE_DATABASE_URL`; в режиме публикации — чистое дерево, `main`
синхронизирован с `origin/main`, тега ещё нет.

1. Работа в ветке → merge в `main` → тег `vX.Y.Z` на итоговом коммите →
   `git push origin main vX.Y.Z`.
2. ZIP: содержимое `extension/` **путями через `/`** (собирать через
   .NET `System.IO.Compression` — PowerShell 5.1 даёт `\`) **плюс**
   `background/config.json` **только с полем `databaseURL`** (остальные
   поля .env в ассет не класть — они не используются кодом). Каталог
   `dist/` в .gitignore.
3. CRX: из временной копии `extension/` (с тем же урезанным `config.json`)
   упаковать подписанный crx:
   `<chrome|chromium>.exe --pack-extension=<temp\author-today-read>
   --pack-extension-key=extension.pem` → `dist/author-today-read-X.Y.Z.crx`.
   Файл `.pem` — в `.gitignore` (`*.pem`), НИКОГДА не коммитить; один ключ
   = стабильный ID расширения на всех машинах.
4. `config.json` в git НЕ попадает (§7); в релизных ассетах (zip/crx) —
   обязательно: `databaseURL` не секрет (доступ определяют правила БД +
   шифрование фразой, `userId` = SHA-256 не угадать). Без этого поля
   установка из релиза даёт «синхронизация не настроена» — ассеты обязаны
   работать «из коробки».
5. Создание: `gh release create vX.Y.Z dist/author-today-read-X.Y.Z.zip
   dist/author-today-read-X.Y.Z.crx --title "vX.Y.Z — …" --notes "…"`.
   Перезаливка: `gh release upload vX.Y.Z <файлы> --clobber`.
6. Лицензия проекта — 0BSD (файл `LICENSE`, ссылка в конце README).
