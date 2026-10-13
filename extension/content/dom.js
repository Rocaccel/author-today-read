/**
 * ATR.dom — интеграция с DOM author.today: поиск точек вставки, вставка панелей,
 * наблюдение за динамическим контентом.
 *
 * Почему нужен MutationObserver:
 *  - сайт использует pjax — навигация/пагинация заменяют #pjax-container
 *    без перезагрузки страницы;
 *  - переключатель вида «список/плитка/таблица» в каталоге — client-side
 *    (Knockout switchView), DOM меняется вообще без pjax.
 * Без наблюдателя панели либо пропадали бы, либо не появлялись.
 *
 * Область применения (AGENTS.md §1.2): только /search*, /work* (строки/таблица)
 * и одиночная страница книги /work/NNN (панель внутри h1.book-title).
 * Плитка .bookcard сознательно не трогаем.
 */
(function () {
  'use strict';

  const ATR = (globalThis.ATR = globalThis.ATR || {});

  const SCAN_DEBOUNCE_MS = 150;

  // Регулярка книги: /work/659887 → "659887".
  // /work/genre/..., /work/series/... — НЕ книги (после /work/ не цифры).
  const WORK_LINK_RE = /^\/work\/(\d+)(?:[/?#]|$)/;

  /** Одиночная страница книги: /work/233831 (только цифровой id, без /genre и т.п.). */
  const BOOK_PAGE_RE = /^\/work\/(\d+)$/;

  /** Страница попадает под область применения? */
  function isEnabledPage() {
    const p = location.pathname;
    return p.startsWith('/search') || p.startsWith('/work');
  }

  /** Это страница книги (карточка), а не раздел каталога? */
  function isBookPage() {
    return BOOK_PAGE_RE.test(location.pathname);
  }

  /**
   * Ищет внутри точки вставки ссылку на книгу и её ID.
   * Возвращает { link, workId } либо null (ссылка не на книгу — пропускаем).
   */
  function findWorkLink(target) {
    const links = target.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      // Берём абсолютный путь даже для абсолютных URL (https://author.today/work/123)
      let path = href;
      try {
        path = new URL(href, location.origin).pathname;
      } catch (_) {
        /* относительный href — оставляем как есть */
      }
      const m = path.match(WORK_LINK_RE);
      if (m) return { link, workId: m[1] };
    }
    return null;
  }

  /**
   * Точки вставки:
   *  1) заголовок строки списка: .book-row ... .book-title
   *     (у плитки класс .bookcard-title — другой токен, селектор его не захватит;
   *      контейнер .book-row.book-row-sm с карточками тоже безопасен);
   *  2) первая ячейка строки таблицы: table.books-table tbody tr > td:first-child.
   */
  function findTargets() {
    const targets = [];
    document.querySelectorAll('.book-row .book-title').forEach((el) => targets.push(el));
    document
      .querySelectorAll('table.books-table tbody tr')
      .forEach((tr) => {
        const td = tr.querySelector('td');
        if (td) targets.push(td);
      });
    return targets;
  }

  /**
   * Идемпотентная вставка: если панель уже есть — только перерисовать её
   * (например, после pjax могло измениться хранилище в другой вкладке).
   * Иначе создаём панель и ставим СРАЗУ ПОСЛЕ ссылки на книгу, чтобы
   * элемент был рядом с названием (ТЗ п.1).
   */
  function inject(target) {
    const existing = target.querySelector('[data-atr-wid]');
    if (existing) {
      ATR.ui.render(existing);
      return;
    }
    const found = findWorkLink(target);
    if (!found) return; // не книга — ничего не вставляем

    const panel = ATR.ui.create(found.workId);
    found.link.after(panel); // рядом с названием, внутри .book-title / <td>
    ATR.ui.render(panel);
  }

  /**
   * Страница книги (AGENTS.md §2.5): панель — внутрь <h1 class="book-title">
   * в конец, в одну строку с названием. workId берём из location.pathname,
   * ссылок на книгу в заголовке нет. Идемпотентно по наличию [data-atr-wid]
   * внутри h1.
   */
  function injectBookPage() {
    const m = location.pathname.match(BOOK_PAGE_RE);
    if (!m) return;
    const h1 = document.querySelector('.book-page .book-meta-panel > h1.book-title');
    if (!h1) return; // разметка не найдена — не вставляем

    const existing = h1.querySelector('[data-atr-wid]');
    if (existing) {
      ATR.ui.render(existing);
      return;
    }
    const panel = ATR.ui.create(m[1]);
    h1.append(panel);
    ATR.ui.render(panel);
  }

  /** Полный проход по странице. Главная точка входа, безопасна для повторов. */
  function scan() {
    if (!isEnabledPage()) return;
    for (const target of findTargets()) inject(target);
    injectBookPage();
  }

  // --- Debounce: наблюдатель срабатывает пачками, сканируем один раз за паузу ---
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  /** Перерисовать уже вставленные панели (без вставки новых). */
  function renderExisting() {
    document.querySelectorAll('.atr-controls[data-atr-wid]').forEach(ATR.ui.render);
  }

  /** Запуск: первичный скан + наблюдатель + события сайта/хранилища. */
  function start() {
    scan();

    // 1) Динамический DOM: pjax, переключение вида, ленивая подгрузка.
    //    Игнорируем мутации внутри собственных панелей, чтобы не зациклиться.
    const observer = new MutationObserver((mutations) => {
      // Реакция, только если в пачке есть мутация ВНЕ наших панелей:
      // собственные вставки/перерисовки не должны порождать новые сканы.
      const hasForeign = mutations.some((m) => {
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        return !(el && el.closest && el.closest('.atr-controls'));
      });
      if (hasForeign) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 2) События pjax-библиотеки сайта — сканируем сразу, не дожидаясь debounce.
    document.addEventListener('pjax:end', scheduleScan);
    document.addEventListener('pjax:success', scheduleScan);

    // 3) Изменение отметки в этой же вкладке (storage.js шлёт событие).
    document.addEventListener('atr:changed', (e) => {
      if (e && e.detail && e.detail.workId) ATR.ui.renderAll(e.detail.workId);
      else renderExisting();
    });

    // 3а) GC (v0.2.1): background вычистил протухшие томбстоуны —
    //     перерисовываем затронутые панели (событие шлёт storage.applyGc).
    document.addEventListener('atr:gc', (e) => {
      const wids = e && e.detail && e.detail.wids;
      if (Array.isArray(wids)) for (const wid of wids) ATR.ui.renderAll(wid);
    });

    // 4) Изменение отметки в ДРУГОЙ вкладке: нативное событие `storage`.
    window.addEventListener('storage', (e) => {
      if (e.key === null || e.key === ATR.storage.KEY_V2) renderExisting();
    });
  }

  ATR.dom = { isEnabledPage, isBookPage, findWorkLink, findTargets, inject, injectBookPage, scan, start };
})();
