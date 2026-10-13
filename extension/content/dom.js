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
 * Панели в плитку .bookcard не ставим; в плитке работает только скрытие
 * отмечённых по тумблеру (v0.2.5) — без панелей, по атрибуту строки.
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
      tagRow(target, existing.dataset.atrWid);
      return;
    }
    const found = findWorkLink(target);
    if (!found) return; // не книга — ничего не вставляем

    const panel = ATR.ui.create(found.workId);
    found.link.after(panel); // рядом с названием, внутри .book-title / <td>
    ATR.ui.render(panel);
    tagRow(target, found.workId); // строка получает точку скрытия (v0.2.5)
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

  // --- Тумблер «Скрыть отмечённые» (v0.2.5, AGENTS.md §1.2/§3.1) ---
  //
  // Состояние — отдельный ключ localStorage страницы (общий для вкладок,
  // межвкладочная синхронизация через нативное событие `storage`).
  // Новый независимый UI-ключ: миграция не нужна, по умолчанию выключен.

  const KEY_PREF = 'atr.ui.hideMarked';
  const PREF_ON = '1';
  const TXT_HIDE = 'Скрыть отмечённые';
  const TXT_SHOW = 'Показать все';

  /** Тумблер включён? */
  function isPrefOn() {
    return localStorage.getItem(KEY_PREF) === PREF_ON;
  }

  /**
   * На странице есть переключатель вида list/table/tile?
   * Каталог — KO-кнопки `switchView` (§2.4.2), поиск — pjax-ссылки `?view=`
   * (§2.3): оба живут в `.panel-actions`. Тумблер имеет смысл только там,
   * где вообще есть список/таблица; иначе (главная, страница книги,
   * /search без категории) — не рисуем.
   */
  function hasViewControls() {
    const pa = document.querySelector('.panel-actions');
    if (!pa) return false;
    return !!pa.querySelector('[data-bind*="switchView"], a[href*="view="]');
  }

  /** Текущий вид — плитка? (активная KO-кнопка либо активная pjax-ссылка). */
  function isTileView() {
    const ko = document.querySelector('[data-bind*="switchView"][class~="active"]');
    if (ko) return (ko.getAttribute('data-bind') || '').includes('tile');
    const link = document.querySelector('.panel-actions a[href*="view="][class~="active"]');
    if (link) return (link.getAttribute('href') || '').includes('view=tile');
    return false;
  }

  /** Обновляет состояние тумблера: текст, aria-pressed, видимость (в tile скрыт). */
  function updateToggle(btn) {
    const on = isPrefOn();
    // textContent менять только при реальном отличии — иначе MutationObserver
    // увидит замену текстового узла и пойдёт по кругу (скан → textContent → скан).
    const text = on ? TXT_SHOW : TXT_HIDE;
    if (btn.textContent !== text) btn.textContent = text;
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Показать отмечённые книги' : 'Скрывать отмечённые книги';
    // В tile-виде тумблер не показываем (скрытие при этом продолжает работать).
    btn.hidden = isTileView();
  }

  /** Переключает pref и сразу пересчитывает скрытие. */
  function togglePref() {
    if (isPrefOn()) localStorage.removeItem(KEY_PREF);
    else localStorage.setItem(KEY_PREF, PREF_ON);
    const btn = document.querySelector('[data-atr-toggle]');
    if (btn) updateToggle(btn);
    applyHideFilter();
  }

  /** Идемпотентная вставка тумблера в шапку списка (.panel-actions). */
  function injectHideToggle() {
    if (!hasViewControls()) return;
    const pa = document.querySelector('.panel-actions');
    const existing = pa.querySelector('[data-atr-toggle]');
    if (existing) {
      updateToggle(existing);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'atr-hide-toggle';
    btn.dataset.atrToggle = '1'; // маркер идемпотентности (data-atr-toggle)
    btn.addEventListener('click', togglePref);
    pa.append(btn);
    updateToggle(btn);
  }

  /**
   * Ставит атрибут data-atr-row="wid" на строку списка/таблицы —
   * точку применения скрытия. Вызывается из inject() при вставке панели.
   */
  function tagRow(target, wid) {
    const row = target.closest('.book-row') || target.closest('tr');
    if (row) row.dataset.atrRow = String(wid);
  }

  /**
   * Тегирует карточки плитки .bookcard (wid — из ссылки /work/NNN).
   * Панели в плитку НЕ ставим (§1.2) — только невидимый атрибут для скрытия.
   */
  function tagTileCards() {
    document.querySelectorAll('.bookcard').forEach((card) => {
      if (card.dataset.atrRow) return;
      const found = findWorkLink(card);
      if (found) card.dataset.atrRow = found.workId;
    });
  }

  /**
   * Применяет скрытие: pref включён → строки с активной отметкой получают
   * класс `.atr-marked` (display:none, styles.css); pref выключен → класс
   * снимается. Опциональный wid ограничивает проход одной книгой
   * (быстрый путь из ui.renderAll при клике/pull/GC).
   */
  function applyHideFilter(wid) {
    const on = isPrefOn();
    const limit = wid === undefined ? null : String(wid);
    document.querySelectorAll('[data-atr-row]').forEach((row) => {
      if (limit !== null && row.dataset.atrRow !== limit) return;
      row.classList.toggle('atr-marked', on && ATR.storage.get(row.dataset.atrRow) !== null);
    });
  }

  /** Полный проход по странице. Главная точка входа, безопасна для повторов. */
  function scan() {
    if (!isEnabledPage()) return;
    injectHideToggle();
    for (const target of findTargets()) inject(target);
    injectBookPage();
    tagTileCards();
    applyHideFilter();
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
    //    Также сюда же приходит смена pref «Скрыть отмечённые» (v0.2.5) —
    //    он лежит в localStorage страницы, событие летит в остальные вкладки.
    window.addEventListener('storage', (e) => {
      if (e.key === null || e.key === ATR.storage.KEY_V2) {
        renderExisting();
        applyHideFilter(); // отметка могла прийти/уйти из другой вкладки
      } else if (e.key === KEY_PREF) {
        const btn = document.querySelector('[data-atr-toggle]');
        if (btn) updateToggle(btn);
        applyHideFilter();
      }
    });
  }

  ATR.dom = {
    isEnabledPage, isBookPage, findWorkLink, findTargets, inject, injectBookPage,
    scan, start,
    // v0.2.5 — тумблер «Скрыть отмечённые»:
    isPrefOn, hasViewControls, isTileView, injectHideToggle, tagTileCards, applyHideFilter
  };
})();
