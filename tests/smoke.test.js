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

  // chrome-стаб для импорта service-worker.js (роутер ловим через addListener)
  let swListener = null;
  const swStore = {};
  globalThis.chrome = {
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

  delete globalThis.chrome;

  console.log(failures === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
