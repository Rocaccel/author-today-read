/**
 * Интеграционный smoke-тест расширения в jsdom (без браузера):
 * инжект панелей, семантика кнопок, исключение плитки, pjax-перерисовка,
 * страница книги (панель внутри h1.book-title).
 *
 * Запуск из корня проекта:
 *   npm install   (один раз, ставит jsdom — только для тестов, расширение
 *                  от npm не зависит)
 *   npm test
 *
 * Покрытие соответствует AGENTS.md §6 (кроме ручных шагов в Chrome).
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

// WebCrypto нужен для shared/phrase.js (Node <19 crypto не глобальный)
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;

const EXT = path.join(__dirname, '..', 'extension');
const read = (p) => fs.readFileSync(path.join(EXT, p), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
<div id="pjax-container">
  <!-- шапка панели каталога: заголовок + переключатель вида (KO-кнопки) -->
  <div class="clearfix">
    <h1 class="panel-title pull-left">Книги в жанре Фэнтези</h1>
    <div class="panel-actions pull-right">
      <button data-bind="click: switchView.bind($data, 'list')" class="btn btn-only-icon mr-sm btn-default active"><i class="icon-list"></i></button>
      <button data-bind="click: switchView.bind($data, 'tile')" class="btn btn-only-icon mr-sm btn-only-brd"><i class="icon-grid"></i></button>
      <button data-bind="click: switchView.bind($data, 'table')" class="btn btn-only-icon btn-only-brd"><i class="icon-bars"></i></button>
    </div>
  </div>
  <!-- вид: строки -->
  <div class="book-row">
    <div class="book-cover-wrapper"></div>
    <div class="book-row-content">
      <div class="book-title">
        <a data-pjax href="/work/659887">Путь Строителя 18</a>
        <div class="pull-right work-list-actions"><library-button></library-button></div>
      </div>
    </div>
  </div>
  <!-- контейнер с плитками: панелей быть не должно -->
  <div class="book-shelf book-row book-row-sm">
    <div class="bookcard">
      <div class="bookcard-footer"><div class="bookcard-title"><a href="/work/644707">Бюджетное фэнтези</a></div></div>
    </div>
  </div>
  <!-- вид: таблица -->
  <table class="books-table table table-hover">
    <tbody>
      <tr><td><a data-pjax href="/work/463277">Стародавнее фэнтези</a></td><td><a href="/u/x/works">Автор</a></td></tr>
      <tr><td><a href="/work/genre/fantasy">Фэнтези (не книга)</a></td><td></td></tr>
    </tbody>
  </table>
</div>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ok  -', msg);
  else { failures++; console.error('  FAIL-', msg); }
}

/** Чтение хранилища схемы v2 конкретной jsdom-вкладки. */
const readMarks = (w) => JSON.parse(w.localStorage.getItem('atr.v2.marks') || '{}');

async function main() {
  const dom = new JSDOM(HTML, {
    url: 'https://author.today/work/genre/fantasy',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const { document } = window;

  // Загрузка content-скриптов в порядке из manifest.json
  for (const f of ['content/storage.js', 'content/ui.js', 'content/dom.js', 'content/main.js']) {
    window.eval(read(f));
  }
  if (!document.querySelector('.atr-controls')) {
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }
  await sleep(50);

  console.log('\n[1] Инжект в список и таблицу, исключение плитки');
  const listPanel = document.querySelector('.book-title .atr-controls[data-atr-wid="659887"]');
  assert(listPanel, 'панель в .book-title строки списка');
  const titleLink = document.querySelector('.book-title a[href="/work/659887"]');
  assert(titleLink.nextElementSibling === listPanel, 'панель стоит сразу после ссылки на книгу');
  const tablePanel = document.querySelector('table.books-table td .atr-controls[data-atr-wid="463277"]');
  assert(tablePanel, 'панель в первой <td> таблицы');
  const tiles = document.querySelectorAll('.bookcard .atr-controls');
  assert(tiles.length === 0, 'в плитке .bookcard панелей нет');
  const panels = document.querySelectorAll('.atr-controls');
  assert(panels.length === 2, 'всего 2 панели (строка + таблица), дублей нет: ' + panels.length);

  console.log('\n[2] Семантика кнопок (переключатели с заменой)');
  const status = listPanel.querySelector('.atr-status');
  const plus = listPanel.querySelector('.atr-plus');
  const minus = listPanel.querySelector('.atr-minus');
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert(status.textContent === '', 'нейтральное состояние: пусто');
  click(plus);
  assert(status.textContent === '✅', '+ из пусто → ✅');
  assert(readMarks(window)['659887'].m === 'read' && typeof readMarks(window)['659887'].t === 'number', 'в хранилище v2: {m:"read", t}');
  click(plus);
  const afterRemove = readMarks(window);
  assert(status.textContent === '' && afterRemove['659887'].m === null, '+ при ✅ → пусто, томбстоун {m:null}');
  click(minus);
  assert(status.textContent === '❌', '− из пусто → ❌');
  click(minus);
  assert(status.textContent === '', '− при ❌ → пусто');
  click(minus);
  click(plus);
  assert(status.textContent === '✅', '+ при ❌ → заменяет на ✅');
  click(plus);
  click(minus);
  assert(status.textContent === '❌', '− при ✅ → заменяет на ❌');
  click(minus);
  assert(plus.classList.contains('atr-active') === false, 'кнопка + неактивна в пустом состоянии');
  click(plus);
  assert(plus.classList.contains('atr-active') && plus.getAttribute('aria-pressed') === 'true', 'aria-pressed=true у активной +');

  console.log('\n[3] Панель таблицы живёт отдельно, хранилище общее');
  const tStatus = tablePanel.querySelector('.atr-status');
  click(tablePanel.querySelector('.atr-plus'));
  assert(tStatus.textContent === '✅', 'книга из таблицы получила ✅');
  const marks = readMarks(window);
  assert(marks['463277'].m === 'read', 'отметка книги 463277 в хранилище v2');

  console.log('\n[4] pjax: новая разметка после события pjax:end');
  const container = document.getElementById('pjax-container');
  container.innerHTML = `
    <div class="book-row"><div class="book-row-content">
      <div class="book-title"><a href="/work/111111">Новая книга</a></div>
    </div></div>
    <table class="books-table"><tbody>
      <tr><td><a href="/work/222222">Новая таблица</a></td></tr>
    </tbody></table>`;
  document.dispatchEvent(new window.Event('pjax:end'));
  await sleep(300); // debounce 150 мс
  assert(document.querySelector('[data-atr-wid="111111"]'), 'панель появилась после pjax (строка)');
  assert(document.querySelector('[data-atr-wid="222222"]'), 'панель появилась после pjax (таблица)');
  assert(!document.querySelector('[data-atr-wid="659887"]'), 'старая панель исчезла вместе со старым DOM');

  console.log('\n[5] Переключение вида на плитку (client-side, без pjax)');
  container.innerHTML = `
    <div class="book-row book-row-sm">
      <div class="bookcard"><div class="bookcard-footer">
        <div class="bookcard-title"><a href="/work/333333">Плитка</a></div>
      </div></div>
    </div>`;
  await sleep(300); // MutationObserver → скан
  assert(document.querySelectorAll('.atr-controls').length === 0, 'в плитке панели не появляются');

  console.log('\n[6] Страница вне области применения (/home/library)');
  const dom2 = new JSDOM(HTML, { url: 'https://author.today/home/library', runScripts: 'outside-only', pretendToBeVisual: true });
  for (const f of ['content/storage.js', 'content/ui.js', 'content/dom.js', 'content/main.js']) {
    dom2.window.eval(read(f));
  }
  await sleep(50);
  assert(dom2.window.document.querySelectorAll('.atr-controls').length === 0, 'на /home/library панелей нет');
  assert(dom2.window.ATR.dom.isBookPage() === false, 'isBookPage()=false вне страницы книги');
  assert(window.ATR.dom.isBookPage() === false, 'isBookPage()=false на /work/genre/fantasy (раздел каталога)');

  console.log('\n[7] Страница книги /work/NNN: панель внутри h1.book-title');
  const BOOK_HTML = `<!DOCTYPE html><html><body>
<div class="book-page inner-content">
  <div class="panel book-panel">
    <div class="panel-body">
      <div class="book-meta-panel">
        <h1 class="book-title" itemprop="name">Школа на краю империи</h1>
        <div class="book-authors">Автор</div>
      </div>
    </div>
  </div>
</div>
</body></html>`;
  const dom3 = new JSDOM(BOOK_HTML, { url: 'https://author.today/work/233831', runScripts: 'outside-only', pretendToBeVisual: true });
  // Отметка, поставленная ранее в списке каталога, должна быть видна на странице книги
  dom3.window.localStorage.setItem('atr.v1.marks', JSON.stringify({ '233831': 'read' }));
  for (const f of ['content/storage.js', 'content/ui.js', 'content/dom.js', 'content/main.js']) {
    dom3.window.eval(read(f));
  }
  await sleep(50);
  const h1 = dom3.window.document.querySelector('h1.book-title');
  const bookPanel = h1 && h1.querySelector('.atr-controls[data-atr-wid="233831"]');
  assert(dom3.window.ATR.dom.isBookPage() === true, 'isBookPage()=true на /work/233831');
  assert(bookPanel, 'панель вставлена внутрь h1.book-title');
  assert(h1.lastElementChild === bookPanel, 'панель — последний элемент заголовка (после текста)');
  const bStatus = bookPanel.querySelector('.atr-status');
  assert(bStatus.textContent === '✅', 'отметка из списка (read) видна на странице книги');
  assert(dom3.window.document.querySelectorAll('.atr-controls').length === 1, 'ровно одна панель');
  dom3.window.ATR.dom.scan();
  assert(h1.querySelectorAll('.atr-controls').length === 1, 'повторный scan() не дублирует панель');
  // Снимаем отметку на странице книги — томбстоун в схеме v2
  bookPanel.querySelector('.atr-plus').dispatchEvent(new dom3.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert(bStatus.textContent === '', '+ при ✅ снимает отметку и на странице книги');
  assert(readMarks(dom3.window)['233831'].m === null, 'в v2 записалаcь {m:null} (томбстоун)');
  assert(dom3.window.localStorage.getItem('atr.v1.marks') === null, 'ключ v1 после миграции удалён');

  console.log('\n[8] Страница книги без разметки заголовка — без панели и без ошибок');
  const dom4 = new JSDOM('<!DOCTYPE html><html><body><div class="book-page"></div></body></html>', {
    url: 'https://author.today/work/999999',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  for (const f of ['content/storage.js', 'content/ui.js', 'content/dom.js', 'content/main.js']) {
    dom4.window.eval(read(f));
  }
  await sleep(50);
  assert(dom4.window.document.querySelectorAll('.atr-controls').length === 0, 'без h1.book-title панель не вставляется');

  console.log('\n[9] Схема v2: миграция с v1 и слияние LWW');
  const dom5 = new JSDOM(HTML, { url: 'https://author.today/work/genre/fantasy', runScripts: 'outside-only', pretendToBeVisual: true });
  dom5.window.localStorage.setItem('atr.v1.marks', JSON.stringify({ '659887': 'read', '463277': 'skip', bad: 'zzz' }));
  for (const f of ['content/storage.js', 'content/sync.js', 'content/ui.js', 'content/dom.js', 'content/main.js']) {
    dom5.window.eval(read(f));
  }
  await sleep(50);
  const S5 = dom5.window.ATR.storage;
  assert(dom5.window.localStorage.getItem('atr.v1.marks') === null, 'ключ v1 удалён после миграции');
  assert(S5.get('659887') === 'read' && S5.get('463277') === 'skip', 'отметки читаются после миграции v1→v2');
  assert(S5.get('bad') === null, 'невалидное значение из v1 отброшено');
  assert(typeof S5.getStamp('659887') === 'number', 'у мигрированной отметки появилась метка времени');

  const now = Date.now();
  const changed1 = S5.mergeRemote({ '111': { m: 'read', t: now + 10000 }, '659887': { m: 'skip', t: now + 10000 } });
  assert(changed1.length === 2, 'облачные записи новее локальных — приняты');
  assert(S5.get('659887') === 'skip', 'LWW: более новая облачная отметка победила');
  const changed2 = S5.mergeRemote({ '659887': { m: 'read', t: S5.getStamp('659887') - 5000 } });
  assert(changed2.length === 0 && S5.get('659887') === 'skip', 'LWW: более старая облачная запись отклонена');
  S5.mergeRemote({ '111': { m: null, t: now + 20000 } });
  assert(S5.get('111') === null, 'облачный томбстоун (m:null) удаляет отметку локально');
  const changed3 = S5.mergeRemote({ '222': { m: 'zzz', t: now } });
  assert(changed3.length === 1 && S5.get('222') === null, 'невалидный m из облака не ломает чтение');

  console.log('\n[10] Кодовая фраза: генерация, userId, шифрование');
  const phrase = await import(pathToFileURL(path.join(EXT, 'shared', 'phrase.js')).href);
  const gen = phrase.generatePhrase();
  assert(gen.split(' ').length === phrase.PHRASE_WORDS, `генерация даёт ${phrase.PHRASE_WORDS} слов`);
  assert(gen.split(' ').every((w) => phrase.WORDLIST.includes(w)), 'все слова из встроенного списка');
  assert(phrase.validatePhrase(gen) === null, 'сгенерированная фраза валидна');
  assert(phrase.validatePhrase('one two three') !== null, 'короткая фраза отклоняется');
  assert(phrase.normalizePhrase('  Alpha   BETA  ') === 'alpha beta', 'нормализация регистра и пробелов');

  const id1 = await phrase.deriveUserId('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi');
  const id1b = await phrase.deriveUserId('ALPHA   beta  gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi');
  const id2 = await phrase.deriveUserId('один два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать');
  assert(id1 === id1b, 'userId детерминирован (регистр/пробелы не важны)');
  assert(/^[0-9a-f]{64}$/.test(id1), 'userId — hex длиной 64 (SHA-256)');
  assert(id1 !== id2, 'разные фразы — разные userId');

  const key1 = await phrase.deriveKey('моя очень секретная фраза из пятнадцати слов совсем секретная');
  const enc1 = await phrase.encryptMark(key1, 'read');
  assert((await phrase.decryptMark(key1, enc1)) === 'read', 'шифр/дешифр round-trip: read');
  const enc2 = await phrase.encryptMark(key1, null);
  assert((await phrase.decryptMark(key1, enc2)) === null, 'round-trip: томбстоун (null)');
  const key2 = await phrase.deriveKey('чужая совершенно другая фраза из пятнадцати слов другая другая');
  let wrongKeyFailed = false;
  try {
    await phrase.decryptMark(key2, enc1);
  } catch (_) {
    wrongKeyFailed = true;
  }
  assert(wrongKeyFailed, 'дешифрование чужой фразой падает (AES-GCM)');

  console.log('\n[11] Синхронизация: content ↔ background (chrome-стаб)');
  const dom6 = new JSDOM(HTML, { url: 'https://author.today/work/genre/fantasy', runScripts: 'outside-only', pretendToBeVisual: true });
  const sentMsgs = [];
  dom6.window.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        sentMsgs.push(msg);
        if (msg.type === 'atr:sync:sync') {
          return { ok: true, pull: { '999999': { m: 'read', t: Date.now() + 50000 } }, pushed: 0 };
        }
        return { ok: true };
      }
    }
  };
  for (const f of ['content/storage.js', 'content/sync.js', 'content/ui.js', 'content/dom.js', 'content/main.js']) {
    dom6.window.eval(read(f));
  }
  await sleep(100);
  assert(
    sentMsgs.some((m) => m.type === 'atr:sync:sync' && m.entries),
    'при старте страницы отправлен atr:sync:sync с локальным срезом'
  );
  assert(dom6.window.ATR.storage.get('999999') === 'read', 'облачная отметка из pull слита в localStorage');
  assert(dom6.window.ATR.storage.getStamp('999999') > 0, 'у слитой отметки сохранена облачная метка времени');

  // Локальный клик → debounce 1.5 с → повторный sync (push)
  const p6 = dom6.window.document.querySelector('.book-title .atr-controls[data-atr-wid="659887"]');
  p6.querySelector('.atr-plus').dispatchEvent(new dom6.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(1800);
  const syncMsgs = sentMsgs.filter((m) => m.type === 'atr:sync:sync');
  assert(syncMsgs.length >= 2, 'после клика отправлен повторный sync (debounce push)');
  assert(syncMsgs[1] && syncMsgs[1].entries['659887'] && syncMsgs[1].entries['659887'].m === 'read', 'в push ушла новая отметка');

  console.log('\n[12] GC томбстоунов: storage.applyGc + firebase.sync (мок fetch)');

  // --- storage.applyGc: жёсткое удаление без создания томбстоуна ---
  let gcEventDetail = null;
  dom5.window.document.addEventListener('atr:gc', (e) => {
    gcEventDetail = e.detail;
  });
  const S5b = dom5.window.ATR.storage;
  S5b.set('777', 'read');
  S5b.applyGc(['777', 'нет-такой']);
  assert(S5b.getAll()['777'] === undefined, 'applyGc жёстко удалил запись (без томбстоуна)');
  assert(gcEventDetail && gcEventDetail.wids.includes('777'), 'applyGc отправил событие atr:gc');

  // --- firebase.sync: GC-логика (реальный WebCrypto, мокнутый fetch) ---
  const realFetch = globalThis.fetch;
  const fb = await import(pathToFileURL(path.join(EXT, 'background', 'firebase.js')).href);
  const gcPhrase = 'моя очень секретная фраза из пятнадцати слов совсем секретная';
  const gcKey = await phrase.deriveKey(gcPhrase);
  const GC_MS = fb.GC_TOMBSTONE_MS;
  const DAY = 24 * 60 * 60 * 1000;
  assert(GC_MS === 90 * DAY, 'GC_TOMBSTONE_MS = 90 дней');

  let cloud = {};
  const fetchLog = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    fetchLog.push({ method, body: opts.body ? JSON.parse(opts.body) : null });
    if (method === 'GET') {
      return { ok: true, json: async () => (Object.keys(cloud).length ? cloud : null) };
    }
    return { ok: true, json: async () => null };
  };
  const client = fb.initFirebase({ databaseURL: 'https://fake-rtdb.example.test' });
  const UID = 'a'.repeat(64);
  const encDoc = async (mark, t) => ({ updatedAt: t, ...(await phrase.encryptMark(gcKey, mark)) });

  // A: свежий томбстоун — пушится как обычная запись, gc пуст
  cloud = {};
  fetchLog.length = 0;
  let r = await client.sync(UID, gcPhrase, { '1': { m: null, t: Date.now() - 3600000 } });
  assert(r.gc.length === 0, 'A: свежий томбстоун не попал в gc');
  assert(r.pushed === 1, 'A: свежий томбстоун запушен в облако');
  const pushA = fetchLog.find((c) => c.method === 'PATCH');
  assert(pushA && pushA.body['1'] !== null && typeof pushA.body['1'] === 'object', 'A: в БД ушёл объект, а не null');

  // B: протухший локальный томбстоун — gc + удаление узла, без пуша
  cloud = {};
  fetchLog.length = 0;
  r = await client.sync(UID, gcPhrase, { '2': { m: null, t: Date.now() - GC_MS - 2 * DAY } });
  assert(r.gc.length === 1 && r.gc[0] === '2', 'B: протухший локальный томбстоун в gc');
  assert(r.pushed === 0, 'B: протухший томбстоун не пушится');
  const patchB = fetchLog.filter((c) => c.method === 'PATCH');
  assert(patchB.length === 1 && patchB[0].body['2'] === null, 'B: PATCH с null — узел удалён из БД');

  // C: протухший облачный томбстоун новее локальной отметки — no-resurrect
  cloud = { '3': await encDoc(null, Date.now() - GC_MS - 2 * DAY) };
  fetchLog.length = 0;
  r = await client.sync(UID, gcPhrase, { '3': { m: 'read', t: Date.now() - GC_MS - 10 * DAY } });
  assert(!r.pull['3'], 'C: протухший облачный томбстоун не отдан в pull');
  assert(r.gc.includes('3'), 'C: wid протухшего облачного томбстоуна в gc');
  assert(r.pushed === 0, 'C: локальная отметка старше удаления — не пушится (нет воскрешения)');
  const patchC = fetchLog.filter((c) => c.method === 'PATCH');
  assert(patchC.length === 1 && patchC[0].body['3'] === null, 'C: узел удалён из БД');

  // D: локальная запись НОВЕЕ протухшего облачного томбстоуна — пуш побеждает GC
  cloud = { '4': await encDoc(null, Date.now() - GC_MS - 2 * DAY) };
  fetchLog.length = 0;
  r = await client.sync(UID, gcPhrase, { '4': { m: 'skip', t: Date.now() - 1000 } });
  assert(r.gc.length === 0, 'D: перекрытие протухшего томбстоуна свежей отметкой — gc пуст');
  const patchD = fetchLog.filter((c) => c.method === 'PATCH');
  assert(patchD.length === 1 && patchD[0].body['4'] !== null, 'D: ушла в БД свежая отметка, удаление отменено');

  // E: живая облачная запись новее локального протухшего томбстоуна — чинит pull
  cloud = { '5': await encDoc('read', Date.now() - 1000) };
  fetchLog.length = 0;
  r = await client.sync(UID, gcPhrase, { '5': { m: null, t: Date.now() - GC_MS - 5 * DAY } });
  assert(r.pull['5'] && r.pull['5'].m === 'read', 'E: живая облачная запись отдана в pull (merge поправит локальную)');
  assert(r.gc.length === 0, 'E: живое содержимое облака не удаляется');
  assert(fetchLog.filter((c) => c.method === 'PATCH').length === 0, 'E: PATCH не отправлялся вообще');

  // F: старые ЖИВЫЕ отметки GC не трогает (истёк только томбстоун)
  cloud = { '6': await encDoc('read', Date.now() - 400 * DAY) };
  fetchLog.length = 0;
  r = await client.sync(UID, gcPhrase, { '6': { m: 'skip', t: Date.now() - 400 * DAY - 1000 } });
  assert(r.gc.length === 0, 'F: 400-дневная живая отметка не попадает в gc');
  assert(r.pull['6'] && r.pull['6'].m === 'read', 'F: живая отметка отдана в pull');
  assert(fetchLog.filter((c) => c.method === 'PATCH').length === 0, 'F: живые записи не удаляются из БД');

  globalThis.fetch = realFetch;

  console.log('\n[13] Ретраи синхронизации: backoff, сброс, skip, событие online');

  /** Ждать условия не дольше ms (опрос каждые 20 мс). */
  async function waitFor(cond, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (cond()) return true;
      await sleep(20);
    }
    return cond();
  }

  /**
   * Фикстура с управляемым chrome-стабом. Порядок eval как в manifest,
   * но __setRetryDelays вызывается ДО main.js (иначе init успеет
   * запланировать первый ретрай с дефолтными 5 с).
   */
  function makeRetryDom(modeBox, delays) {
    const d = new JSDOM(HTML, { url: 'https://author.today/work/genre/fantasy', runScripts: 'outside-only', pretendToBeVisual: true });
    const calls = [];
    d.window.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          calls.push(msg);
          if (msg.type !== 'atr:sync:sync') return { ok: true };
          if (modeBox.mode === 'throw') throw new Error('SW недоступен');
          if (modeBox.mode === 'fail') return { ok: false, error: 'network down' };
          if (modeBox.mode === 'skip') return { ok: false, skip: true, reason: 'config' };
          return { ok: true, pull: {}, pushed: 0, gc: [] };
        }
      }
    };
    d.window.eval(read('content/storage.js'));
    d.window.eval(read('content/sync.js'));
    d.window.ATR.sync.__setRetryDelays(delays);
    for (const f of ['content/ui.js', 'content/dom.js', 'content/main.js']) d.window.eval(read(f));
    return { d, calls };
  }

  // 13а: fail → повтор → throw → повтор → ok → сброс, дальше тихо
  const boxA = { mode: 'fail' };
  const A = makeRetryDom(boxA, [80, 120]);
  assert(await waitFor(() => A.calls.length >= 1), '13а: первый sync уходит при загрузке (и падает)');
  assert(await waitFor(() => A.calls.length >= 2), '13а: после неудачи выполнен повтор с backoff (80 мс)');
  boxA.mode = 'throw';
  assert(await waitFor(() => A.calls.length >= 3), '13а: исключение sendMessage тоже ретраится (120 мс)');
  boxA.mode = 'ok';
  assert(await waitFor(() => A.calls.length >= 4), '13а: после восстановления связи повтор выполнен');
  await sleep(350);
  assert(A.calls.length === 4, '13а: успех сбросил backoff — новых вызовов нет');

  // 13б: skip (нет конфига/фразы) — не сбой, повторов нет
  const boxB = { mode: 'skip' };
  const B = makeRetryDom(boxB, [50]);
  assert(await waitFor(() => B.calls.length >= 1), '13б: sync при загрузке');
  await sleep(150);
  assert(B.calls.length === 1, '13б: skip не порождает повторов (это не ошибка)');

  // 13с: событие online — немедленный повтор мимо backoff
  const boxC = { mode: 'fail' };
  const C = makeRetryDom(boxC, [10000]);
  assert(await waitFor(() => C.calls.length >= 1), '13с: ошибка → повтор отложен (10 с)');
  await sleep(50);
  assert(C.calls.length === 1, '13с: до срабатывания backoff повторов нет');
  boxC.mode = 'ok';
  C.d.window.dispatchEvent(new C.d.window.Event('online'));
  assert(await waitFor(() => C.calls.length >= 2), '13с: online выполнил синхронизацию немедленно');
  await sleep(150);
  assert(C.calls.length === 2, '13с: после успеха лишних вызовов нет');

  console.log('\n[14] Статистика в параметрах: computeStats + кэш в background (v0.2.2)');

  // chrome-стаб для импорта service-worker.js (роутер ловим через addListener);
  // в [17] поднимем его снова — хендлеру ротации нужен chrome.storage
  let swListener = null;
  const swStore = {};
  const swChromeStub = {
    runtime: {
      onMessage: { addListener: (fn) => { swListener = fn; } },
      onInstalled: { addListener: () => {} },
      openOptionsPage: () => {},
      // в тесте config.json не читается (fetch file:// отклоняется) → skip
      getURL: (p) => 'file:///' + p.replace(/\\/g, '/')
    },
    action: { onClicked: { addListener: () => {} } },
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in swStore) out[k] = swStore[k];
          return out;
        },
        set: async (obj) => { Object.assign(swStore, obj); },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete swStore[k];
        }
      }
    }
  };
  globalThis.chrome = swChromeStub;
  const sw = await import(pathToFileURL(path.join(EXT, 'background', 'service-worker.js')).href);
  assert(typeof swListener === 'function' && typeof sw.computeStats === 'function', 'роутер сообщений и computeStats доступны');

  const st14 = sw.computeStats({
    '1': { m: 'read', t: 1 },
    '2': { m: 'read', t: 1 },
    '3': { m: 'skip', t: 1 },
    '4': { m: null, t: 1 },
    '5': { m: 'zzz' },
    '6': 'мусор'
  });
  assert(
    st14.read === 2 && st14.skip === 1 && st14.total === 3,
    'computeStats: read/skip посчитаны, томбстоун и мусор не считаются'
  );

  const callSw = (msg, sender) => new Promise((resolve) => {
    swListener(msg, sender, resolve);
  });

  let st = await callSw({ type: 'atr:status' }, {});
  assert(st.ok && st.stats && st.stats.total === 0 && st.stats.at === null, 'atr:status без кэша — нулевая статистика');

  const syncRes = await callSw(
    {
      type: 'atr:sync:sync',
      entries: { '1': { m: 'read', t: 1 }, '2': { m: 'read', t: 1 }, '3': { m: 'skip', t: 1 }, '4': { m: null, t: 1 } }
    },
    { tab: { id: 7 } }
  );
  assert(syncRes.skip === true, 'синк без конфига — skip (в тесте нет config.json)');
  assert(
    swStore['atr.sync.stats'] && swStore['atr.sync.stats'].read === 2 && swStore['atr.sync.stats'].total === 3,
    'content-вкладка (sender.tab) обновила кэш статистики до проверки конфига'
  );

  await callSw({ type: 'atr:sync:sync', entries: {} }, {});
  assert(swStore['atr.sync.stats'].total === 3, 'options (без sender.tab) с entries:{} не обнуляет счётчики');

  st = await callSw({ type: 'atr:status' }, {});
  assert(
    st.stats.read === 2 && st.stats.skip === 1 && st.stats.total === 3 && !!st.stats.at,
    'atr:status отдаёт закэшированную статистику'
  );

  console.log('\n[15] Бэкап: экспорт/импорт JSON (v0.2.4)');

  // 15а: shared/backup.js — сериализация и валидация
  const backup = await import(pathToFileURL(path.join(EXT, 'shared', 'backup.js')).href);
  const ser = backup.serializeMarks({
    '1': { m: 'read', t: 100 },
    '2': { m: null, t: 200 },
    'bad': { m: 'zzz' },
    '3': { m: 'skip', t: 'x' }
  });
  const serData = JSON.parse(ser);
  assert(serData.format === 'atr.marks' && serData.version === 1 && serData.count === 2, 'serializeMarks: формат/версия/count');
  assert(serData.entries['1'].m === 'read' && serData.entries['2'].m === null, 'serializeMarks: томбстоуны включены');
  assert(!('bad' in serData.entries) && !('3' in serData.entries), 'serializeMarks: мусор отброшен');

  const pOk = backup.parseBackup(ser);
  assert(pOk.count === 2 && pOk.entries['1'].t === 100, 'parseBackup: round-trip');
  assert(!!backup.parseBackup('не json').error, 'parseBackup: битый JSON → ошибка');
  assert(!!backup.parseBackup('{"format":"other"}').error, 'parseBackup: чужой формат → ошибка');
  assert(!!backup.parseBackup(JSON.stringify({ format: 'atr.marks', version: 99, entries: {} })).error, 'parseBackup: неподдерживаемая версия → ошибка');
  const pMixed = backup.parseBackup(
    JSON.stringify({ format: 'atr.marks', version: 1, entries: { '9': { m: 'read', t: 5 }, 'x': 1, '10': { m: 'nope', t: 5 } } })
  );
  assert(pMixed.count === 1 && pMixed.entries['9'] && pMixed.entries['9'].m === 'read', 'parseBackup: невалидные записи отбракованы');

  // 15б: снапшот в background (данные для экспорта)
  await callSw({ type: 'atr:sync:sync', entries: { '77': { m: 'skip', t: 9 } } }, { tab: { id: 8 } });
  assert(
    swStore['atr.sync.snapshot'] && swStore['atr.sync.snapshot'].entries['77'].m === 'skip' && !!swStore['atr.sync.snapshot'].at,
    'content-вкладка кэшировала снапшот для экспорта'
  );
  await callSw({ type: 'atr:sync:sync', entries: {} }, {});
  assert(swStore['atr.sync.snapshot'].entries['77'], 'options (без sender.tab) снапшот не затирает');

  // 15в: content применяет отложенный импорт (LWW, ключ удаляется, уходит push)
  const dom15 = new JSDOM(HTML, { url: 'https://author.today/work/genre/fantasy', runScripts: 'outside-only', pretendToBeVisual: true });
  const importStore = {};
  const removed15 = [];
  const sent15 = [];
  dom15.window.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        sent15.push(msg);
        if (msg.type === 'atr:sync:sync') return { ok: true, pull: {}, pushed: 1 };
        return { ok: true };
      }
    },
    storage: {
      local: {
        get: async (k) => (k in importStore ? { [k]: importStore[k] } : {}),
        set: async (obj) => { Object.assign(importStore, obj); },
        remove: async (k) => { removed15.push(k); delete importStore[k]; }
      },
      onChanged: { addListener: () => {} }
    }
  };
  dom15.window.eval(read('content/storage.js'));
  dom15.window.eval(read('content/sync.js'));

  dom15.window.ATR.storage.set('659887', 'read'); // локальная отметка НОВЕЕ файла
  const localT15 = dom15.window.ATR.storage.getStamp('659887');
  importStore['atr.sync.pendingImport'] = {
    '659887': { m: 'skip', t: 1760000000000 }, // старее локальной — не должно затереть
    '777777': { m: 'read', t: 1760000000001 }, // новая — применяется
    '888888': { m: null, t: 1760000000002 } // томбстоун файла — переносится
  };
  await dom15.window.ATR.sync.applyPendingImport();
  assert(dom15.window.ATR.storage.get('777777') === 'read', 'импорт: новая отметка применена');
  assert(dom15.window.ATR.storage.getStamp('777777') === 1760000000001, 'импорт: метка времени файла сохранена');
  assert(
    dom15.window.ATR.storage.get('659887') === 'read' && dom15.window.ATR.storage.getStamp('659887') === localT15,
    'импорт: более новая локальная отметка не затёрта (LWW)'
  );
  assert(dom15.window.ATR.storage.getStamp('888888') > 0, 'импорт: томбстоун файла перенесён');
  assert(removed15.includes('atr.sync.pendingImport'), 'импорт: ключ удалён после применения');
  assert(await waitFor(() => sent15.some((m) => m.type === 'atr:sync:sync')), 'импорт: ушёл push');
  await dom15.window.ATR.sync.applyPendingImport();
  assert(removed15.filter((k) => k === 'atr.sync.pendingImport').length === 1, 'импорт: повторный вызов — no-op');

  delete globalThis.chrome;

  console.log('\n[16] Тумблер «Скрыть отмечённые» (v0.2.5)');

  const dom16 = new JSDOM(HTML, { url: 'https://author.today/work/genre/fantasy', runScripts: 'outside-only', pretendToBeVisual: true });
  const w16 = dom16.window;
  const d16 = w16.document;
  for (const f of ['content/storage.js', 'content/ui.js', 'content/dom.js', 'content/main.js']) {
    w16.eval(read(f));
  }
  await sleep(50);

  const tog16 = d16.querySelector('.panel-actions [data-atr-toggle]');
  assert(tog16, 'тумблер вставлен в .panel-actions рядом с переключателем вида');
  assert(d16.querySelectorAll('[data-atr-toggle]').length === 1, 'тумблер ровно один');
  assert(
    tog16.textContent === 'Скрыть отмечённые' && tog16.getAttribute('aria-pressed') === 'false',
    'выключено: текст «Скрыть отмечённые», aria-pressed=false'
  );
  assert(tog16.hidden === false, 'в list-виде тумблер виден');
  w16.ATR.dom.scan();
  assert(d16.querySelectorAll('[data-atr-toggle]').length === 1, 'повторный scan() не дублирует тумблер');

  const S16 = w16.ATR.storage;
  const click16 = (el) => el.dispatchEvent(new w16.MouseEvent('click', { bubbles: true, cancelable: true }));
  S16.toggle('659887', 'read');
  S16.toggle('463277', 'skip');
  S16.toggle('644707', 'read');
  const rowList = d16.querySelector('.book-row[data-atr-row="659887"]');
  const rowTable = d16.querySelector('tr[data-atr-row="463277"]');
  const card16 = d16.querySelector('.bookcard[data-atr-row="644707"]');
  assert(rowList && rowTable, 'строки списка и таблицы претеглены data-atr-row');
  assert(card16, 'карточка плитки претеглена data-atr-row (без панели)');
  assert(d16.querySelectorAll('.atr-marked').length === 0, 'pref выключен — ничего не скрыто');

  click16(tog16);
  assert(w16.localStorage.getItem('atr.ui.hideMarked') === '1', 'клик включил pref в localStorage');
  assert(tog16.textContent === 'Показать все' && tog16.getAttribute('aria-pressed') === 'true', 'текст и aria-pressed переключились');
  assert(rowList.classList.contains('atr-marked'), 'отмеченная строка списка скрыта');
  assert(rowTable.classList.contains('atr-marked'), 'отмеченная строка таблицы скрыта');
  assert(card16.classList.contains('atr-marked'), 'отмеченная карточка плитки скрыта (скрытие работает в tile)');

  // Снятие/возврат отметки: путь atr:changed → ui.renderAll → applyHideFilter
  S16.toggle('659887', 'read'); // read → снятие (томбстоун)
  assert(!rowList.classList.contains('atr-marked'), 'снятие отметки возвращает строку (событие atr:changed)');
  S16.toggle('659887', 'read'); // снова read
  assert(rowList.classList.contains('atr-marked'), 'повторная отметка снова скрывает строку');

  // Вид tile: тумблер скрывается, скрытие продолжает работать
  const ko16 = d16.querySelectorAll('[data-bind*="switchView"]');
  ko16[0].classList.remove('active');
  ko16[1].classList.add('active');
  w16.ATR.dom.scan();
  assert(tog16.hidden === true, 'в tile-виде тумблер скрыт');
  assert(card16.classList.contains('atr-marked'), 'в tile-виде скрытие по-прежнему работает');
  ko16[1].classList.remove('active');
  ko16[0].classList.add('active');
  w16.ATR.dom.scan();
  assert(tog16.hidden === false, 'возврат в list — тумблер снова виден');

  click16(tog16);
  assert(w16.localStorage.getItem('atr.ui.hideMarked') === null, 'повторный клик выключил pref (ключ удалён)');
  assert(tog16.textContent === 'Скрыть отмечённые' && tog16.getAttribute('aria-pressed') === 'false', 'состояние кнопки вернулось');
  assert(d16.querySelectorAll('.atr-marked').length === 0, 'pref выключен — все строки показаны');

  // pref=1 до загрузки — строки скрыты сразу, тумблер сразу в состоянии «Показать все»
  const dom17 = new JSDOM(HTML, { url: 'https://author.today/work/genre/fantasy', runScripts: 'outside-only', pretendToBeVisual: true });
  const w17 = dom17.window;
  w17.localStorage.setItem('atr.ui.hideMarked', '1');
  w17.localStorage.setItem('atr.v2.marks', JSON.stringify({ '659887': { m: 'read', t: Date.now() } }));
  for (const f of ['content/storage.js', 'content/ui.js', 'content/dom.js', 'content/main.js']) {
    w17.eval(read(f));
  }
  await sleep(50);
  const row17 = w17.document.querySelector('.book-row[data-atr-row="659887"]');
  assert(row17 && row17.classList.contains('atr-marked'), 'pref=1 применяется сразу при загрузке страницы');
  const tog17 = w17.document.querySelector('[data-atr-toggle]');
  assert(tog17 && tog17.textContent === 'Показать все', 'тумблер сразу в состоянии «Показать все»');

  // Страница книги: view-контролов нет — тумблер не появляется
  const dom18 = new JSDOM(BOOK_HTML, { url: 'https://author.today/work/233831', runScripts: 'outside-only', pretendToBeVisual: true });
  for (const f of ['content/storage.js', 'content/ui.js', 'content/dom.js', 'content/main.js']) {
    dom18.window.eval(read(f));
  }
  await sleep(50);
  assert(dom18.window.document.querySelectorAll('[data-atr-toggle]').length === 0, 'на странице книги тумблера нет (нет view-контролов)');

  console.log('\n[17] Ротация кодовой фразы (v0.2.6): перешифровка, переезд, порядок записи');

  // chrome-стаб из [14] снова нужен: хендлер ротации работает с chrome.storage
  globalThis.chrome = swChromeStub;
  // Конфиг: config.json в тесте не читается — подменяем кэш loadConfig напрямую
  fb.__setConfigForTest({ databaseURL: 'https://fake-rtdb.example.test' });

  const rotOld = 'старая очень секретная фраза для ротации из пятнадцати слов лежит тут давно';
  const rotNew = 'совсем новая незнакомая фраза для ротации из пятнадцати слов здесь и сейчас';
  const rotThird = 'третья уже ненужная фраза для полной замены из пятнадцати слов ещё тут лежит';
  assert(
    !phrase.validatePhrase(rotOld) && !phrase.validatePhrase(rotNew) && !phrase.validatePhrase(rotThird),
    '17: тестовые фразы валидны (12 слов)'
  );
  const rotOldUid = await phrase.deriveUserId(rotOld);
  const rotNewUid = await phrase.deriveUserId(rotNew);
  const rotThirdUid = await phrase.deriveUserId(rotThird);
  const rotOldKey = await phrase.deriveKey(rotOld);
  const rotNewKey = await phrase.deriveKey(rotNew);
  const rotThirdKey = await phrase.deriveKey(rotThird);
  const encFor = async (key, mark, t) => ({ updatedAt: t, ...(await phrase.encryptMark(key, mark)) });

  // Фейковая RTDB: маршрутизация по /users/{uid}/marks.json + журнал запросов
  const rotCloud = { users: {} };
  const rotLog = []; // {method, uid, body}
  let rotFailPatch = false; // сбой PATCH → ротация обязана откатиться
  let rotSlowMs = 0; // искусственно медленные запросы (тест drain)
  rotCloud.users[rotOldUid] = {
    '1': await encFor(rotOldKey, 'read', 1000),
    '2': await encFor(rotOldKey, 'skip', 2000),
    '3': await encFor(rotOldKey, 'read', 500), // старее снапшота — проиграет (LWW)
    '4': await encFor(rotThirdKey, 'read', 3000) // чужой ключ — не расшифровать (skipped)
  };
  rotCloud.users[rotNewUid] = {
    '1': await encFor(rotNewKey, 'skip', 999), // LWW: проигрывает записи старого пути (t=1000)
    '6': await encFor(rotNewKey, 'read', 100) // есть только на новом пути — переживает ротацию
  };

  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const matched = /\/users\/([^/]+)\/marks\.json$/.exec(String(url));
    if (!matched) throw new Error('неожиданный URL ротации: ' + url);
    const uid = matched[1];
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (rotSlowMs) await sleep(rotSlowMs);
    rotLog.push({ method, uid, body });
    if (method === 'GET') return { ok: true, json: async () => rotCloud.users[uid] || null };
    if (method === 'PATCH') {
      if (rotFailPatch) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      const target = (rotCloud.users[uid] = rotCloud.users[uid] || {});
      for (const [k, v] of Object.entries(body)) {
        if (v === null) delete target[k];
        else target[k] = v;
      }
      return { ok: true, json: async () => null };
    }
    if (method === 'DELETE') {
      delete rotCloud.users[uid];
      return { ok: true, json: async () => null };
    }
    throw new Error('неподдерживаемый метод: ' + method);
  };

  // --- 17а: отказы ДО сети — хранилище и облако не тронуты ---
  swStore['atr.sync.phrase'] = rotOld;
  swStore['atr.sync.userId'] = rotOldUid;

  fb.__setConfigForTest({});
  let rotR = await callSw({ type: 'atr:phrase:rotate', phrase: rotNew }, {});
  assert(rotR.ok === false && /нет конфига/.test(rotR.error), '17а: без конфига ротация отклонена');
  fb.__setConfigForTest({ databaseURL: 'https://fake-rtdb.example.test' });

  delete swStore['atr.sync.phrase'];
  rotR = await callSw({ type: 'atr:phrase:rotate', phrase: rotNew }, {});
  assert(rotR.ok === false && /нет текущей фразы/.test(rotR.error), '17а: без текущей фразы — отказ');
  swStore['atr.sync.phrase'] = rotOld;

  rotR = await callSw({ type: 'atr:phrase:rotate', phrase: 'one two three' }, {});
  assert(rotR.ok === false && /Слишком короткая/.test(rotR.error), '17а: короткая новая фраза отклонена');

  rotR = await callSw({ type: 'atr:phrase:rotate', phrase: rotOld }, {});
  assert(rotR.ok === false && /совпадает/.test(rotR.error), '17а: совпадение с текущей фразой — отказ');
  assert(rotLog.length === 0, '17а: отказы не породили ни одного сетевого запроса');
  assert(swStore['atr.sync.phrase'] === rotOld, '17а: фраза в хранилище не изменилась');

  // --- 17б: drain (sync уже в полёте) + guard (sync во время ротации) + миграция ---
  // Снапшот для LWW намеренно пишет сам sync (saveStatsFrom): {'5' чит, '3' томбстоун}
  rotSlowMs = 120;
  const rotSyncP = callSw(
    { type: 'atr:sync:sync', entries: { '5': { m: 'read', t: 700 }, '3': { m: null, t: 900 } } },
    { tab: { id: 3 } }
  );
  const rotPromise = callSw({ type: 'atr:phrase:rotate', phrase: rotNew }, {});
  const rotGuard = await callSw({ type: 'atr:sync:sync', entries: {} }, {});
  assert(rotGuard.ok === false && /смена кодовой фразы/.test(rotGuard.error), '17б: sync во время ротации отклонён (guard)');
  const [rotSyncRes, rotRes] = await Promise.all([rotSyncP, rotPromise]);
  rotSlowMs = 0;
  assert(rotSyncRes.ok === true, '17б: sync, начавшийся до ротации, дождался drain и завершился');
  assert(
    rotRes.ok && rotRes.migrated === 5 && rotRes.skipped === 1,
    `17б: миграция ok, переехало ${rotRes.migrated}, пропущено ${rotRes.skipped} (ожидалось 5 и 1)`
  );
  assert(swStore['atr.sync.phrase'] === rotNew && swStore['atr.sync.userId'] === rotNewUid, '17б: новая фраза и userId сохранены');
  assert(rotCloud.users[rotOldUid] === undefined, '17б: старый путь в БД удалён');
  assert(rotCloud.users[rotNewUid] && Object.keys(rotCloud.users[rotNewUid]).length === 5, '17б: на новом пути ровно 5 записей');

  const rotMigrated = {};
  for (const [wid, doc] of Object.entries(rotCloud.users[rotNewUid] || {})) {
    rotMigrated[wid] = { m: await phrase.decryptMark(rotNewKey, doc), t: doc.updatedAt };
  }
  assert(rotMigrated['1'] && rotMigrated['1'].m === 'read' && rotMigrated['1'].t === 1000, '17б: перешифровано новым ключом, LWW: 1000 > 999');
  assert(rotMigrated['2'] && rotMigrated['2'].m === 'skip' && rotMigrated['2'].t === 2000, '17б: skip-отметка переехала');
  assert(rotMigrated['3'] && rotMigrated['3'].m === null && rotMigrated['3'].t === 900, '17б: томбстоун из снапшота победил (LWW 900 > 500)');
  assert(rotMigrated['5'] && rotMigrated['5'].m === 'read' && rotMigrated['5'].t === 700, '17б: запись из снапшота переехала');
  assert(rotMigrated['6'] && rotMigrated['6'].m === 'read' && rotMigrated['6'].t === 100, '17б: запись нового пути (повтор запуска) сохранена');
  assert(!('4' in rotMigrated), '17б: запись с чужим ключом не переехала (skipped)');

  const rotDelIdx = rotLog.findIndex((e) => e.method === 'DELETE' && e.uid === rotOldUid);
  const rotPatchNewIdx = rotLog.reduce((acc, e, i) => (e.method === 'PATCH' && e.uid === rotNewUid ? i : acc), -1);
  assert(rotPatchNewIdx > -1 && rotDelIdx > rotPatchNewIdx, '17б: PATCH нового пути строго ДО DELETE старого');
  assert(rotLog.filter((e) => e.method === 'DELETE' && e.uid === rotOldUid).length === 1, '17б: старый путь удалён ровно один раз');
  assert(rotLog.every((e, i) => e.uid !== rotOldUid || i <= rotDelIdx), '17б: после DELETE к старому пути обращений нет');

  // --- 17в: сбой PATCH → ничего не сохранено → повтор успешен (NEW → THIRD) ---
  rotFailPatch = true;
  rotR = await callSw({ type: 'atr:phrase:rotate', phrase: rotThird }, {});
  assert(rotR.ok === false && /rotate-push/.test(rotR.error), '17в: сбой PATCH возвращает ошибку rotate-push');
  assert(swStore['atr.sync.phrase'] === rotNew && swStore['atr.sync.userId'] === rotNewUid, '17в: хранилище не изменилось (фраза/userId прежние)');
  assert(rotCloud.users[rotThirdUid] === undefined, '17в: путь новой фразы не создан');
  assert(rotCloud.users[rotNewUid] && Object.keys(rotCloud.users[rotNewUid]).length === 5, '17в: старый путь не удалён, записи целы');
  assert(/rotate-push/.test(swStore['atr.sync.lastError'] || ''), '17в: ошибка сохранена в lastError');
  assert(rotLog.filter((e) => e.method === 'DELETE' && e.uid === rotNewUid).length === 0, '17в: DELETE старого пути не выполнялся');

  rotFailPatch = false;
  rotR = await callSw({ type: 'atr:phrase:rotate', phrase: rotThird }, {});
  assert(rotR.ok && rotR.migrated === 5, '17в: повтор после сбоя прошёл успешно (5 записей)');
  assert(swStore['atr.sync.phrase'] === rotThird && swStore['atr.sync.userId'] === rotThirdUid, '17в: новая фраза сохранена после успеха');
  assert(swStore['atr.sync.lastError'] === null, '17в: lastError очищен');
  assert(rotCloud.users[rotNewUid] === undefined && !!rotCloud.users[rotThirdUid], '17в: переезд завершён, старый путь удалён');
  const rotFinal1 = await phrase.decryptMark(rotThirdKey, rotCloud.users[rotThirdUid]['1']);
  assert(rotFinal1 === 'read', '17в: запись расшифровывается уже третьим ключом');

  // --- 17г: сохранение/смена фразы → открытая вкладка сразу синхронизируется ---
  // content слушает chrome.storage.onChanged: ветка ключа atr.sync.phrase
  // (пишут atr:phrase:set и atr:phrase:rotate) → немедленный syncNow().
  const dom17g = new JSDOM(HTML, { url: 'https://author.today/work/genre/fantasy', runScripts: 'outside-only', pretendToBeVisual: true });
  const sent17 = [];
  let changeListener17 = null;
  let raceNextSync17 = false; // имитация гонки: SW отклонил sync guard'ом ротации
  dom17g.window.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        sent17.push(msg);
        if (msg.type === 'atr:sync:sync') {
          if (raceNextSync17) {
            raceNextSync17 = false;
            return { ok: false, error: 'идёт смена кодовой фразы' };
          }
          return { ok: true, pull: {}, pushed: 0 };
        }
        return { ok: true };
      }
    },
    storage: {
      onChanged: { addListener: (fn) => { changeListener17 = fn; } },
      local: { get: async () => ({}) }
    }
  };
  dom17g.window.eval(read('content/storage.js'));
  dom17g.window.eval(read('content/sync.js'));
  dom17g.window.ATR.sync.init();
  assert(await waitFor(() => sent17.some((m) => m.type === 'atr:sync:sync')), '17г: init при загрузке страницы шлёт sync');
  sent17.length = 0;
  assert(typeof changeListener17 === 'function', '17г: слушатель chrome.storage.onChanged установлен');

  // вход (atr:phrase:set) или ротация (atr:phrase:rotate) изменили ключ фразы
  changeListener17({ 'atr.sync.phrase': { newValue: 'новая сохранённая фраза для теста' } }, 'local');
  assert(await waitFor(() => sent17.some((m) => m.type === 'atr:sync:sync')), '17г: смена фразы → вкладка сразу шлёт sync');
  sent17.length = 0;

  // «Выйти» (newValue: undefined) — лишний sync не порождаем
  changeListener17({ 'atr.sync.phrase': { oldValue: 'фраза', newValue: undefined } }, 'local');
  await sleep(30);
  assert(!sent17.some((m) => m.type === 'atr:sync:sync'), '17г: удаление фразы (выход) sync не порождает');

  // чужая область storage — игнорируется
  changeListener17({ 'atr.sync.phrase': { newValue: 'x' } }, 'sync');
  await sleep(30);
  assert(!sent17.some((m) => m.type === 'atr:sync:sync'), '17г: событие вне storage.local игнорируется');

  // гонка: ответ SW «идёт смена кодовой фразы» → короткий повтор (schedulePush
  // ~1.5 с), а НЕ backoff (с backoff-задержкой 60 с повтор не успел бы за 3 с)
  dom17g.window.ATR.sync.__setRetryDelays([60000]);
  raceNextSync17 = true;
  dom17g.window.ATR.sync.syncNow();
  assert(
    await waitFor(() => sent17.filter((m) => m.type === 'atr:sync:sync').length >= 2, 3000),
    '17г: guard-отказ ротации повторён коротким таймером, а не backoff'
  );

  globalThis.fetch = realFetch;

  console.log(failures === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
