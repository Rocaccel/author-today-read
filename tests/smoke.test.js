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
const { JSDOM } = require('jsdom');

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
  assert(JSON.parse(window.localStorage.getItem('atr.v1.marks'))['659887'] === 'read', 'в хранилище read');
  click(plus);
  assert(status.textContent === '' && !('659887' in JSON.parse(window.localStorage.getItem('atr.v1.marks'))), '+ при ✅ → пусто, ключ удалён');
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
  const marks = JSON.parse(window.localStorage.getItem('atr.v1.marks'));
  assert(marks['463277'] === 'read', 'отметка книги 463277 в хранилище');

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
  // Снимаем отметку на странице книги — запись удалена из хранилища
  bookPanel.querySelector('.atr-plus').dispatchEvent(new dom3.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert(bStatus.textContent === '', '+ при ✅ снимает отметку и на странице книги');
  assert(!('233831' in JSON.parse(dom3.window.localStorage.getItem('atr.v1.marks'))), 'ключ удалён из atr.v1.marks');

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

  console.log(failures === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
