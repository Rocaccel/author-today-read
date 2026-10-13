/**
 * ATR.ui — создание и обновление панели управления рядом с названием книги.
 *
 * Структура панели:
 *   <span class="atr-controls" data-atr-wid="659887">
 *     <button class="atr-btn atr-plus"  type="button">+</button>
 *     <span class="atr-status">✅|❌|</span>
 *     <button class="atr-btn atr-minus" type="button">−</button>
 *   </span>
 *
 * Каждая кнопка — переключатель своей отметки (см. ATR.storage.toggle):
 * повторное нажатие снимает отметку, нажатие при чужой отметке — заменяет её.
 */
(function () {
  'use strict';

  const ATR = (globalThis.ATR = globalThis.ATR || {});
  const S = () => ATR.storage; // ленивый доступ: storage.js подключается первым

  /** Текст индикатора для состояния отметки. */
  function statusText(mark) {
    if (mark === S().MARK_READ) return '✅';
    if (mark === S().MARK_SKIP) return '❌';
    return ''; // нейтральное состояние — пустое место
  }

  /**
   * Создаёт панель для книги. Обработчики навешиваются здесь же —
   * панель всегда принадлежит одной книге (workId).
   */
  function create(workId) {
    const wid = String(workId);

    const root = document.createElement('span');
    root.className = 'atr-controls';
    root.dataset.atrWid = wid; // маркер идемпотентности для content/dom.js

    const btnPlus = document.createElement('button');
    btnPlus.type = 'button';
    btnPlus.className = 'atr-btn atr-plus';
    btnPlus.textContent = '+';
    btnPlus.title = 'Отметить (повторный клик снимает отметку)';

    const status = document.createElement('span');
    status.className = 'atr-status';
    status.setAttribute('aria-live', 'polite');

    const btnMinus = document.createElement('button');
    btnMinus.type = 'button';
    btnMinus.className = 'atr-btn atr-minus';
    btnMinus.textContent = '−';
    btnMinus.title = 'Отметить минусом (повторный клик снимает отметку)';

    /**
     * Обработчик клика — ключевой логический блок:
     *  1) глушим всплытие, чтобы не сработали обработчики строки/ссылки;
     *  2) переключаем отметку в localStorage;
     *  3) перерисовываем все панели этой книги на странице.
     * (Событие 'atr:changed' из storage тоже вызовет перерисовку —
     *  renderAll здесь нужен для мгновенного отклика.)
     */
    function handleClick(event, mark) {
      event.preventDefault();
      event.stopPropagation();
      S().toggle(wid, mark);
      renderAll(wid);
    }

    btnPlus.addEventListener('click', (e) => handleClick(e, S().MARK_READ));
    btnMinus.addEventListener('click', (e) => handleClick(e, S().MARK_SKIP));

    root.append(btnPlus, status, btnMinus);
    return root;
  }

  /** Обновляет внешний вид одной панели по текущему состоянию в хранилище. */
  function render(root) {
    if (!root || !root.isConnected) return;
    const wid = root.dataset.atrWid;
    const mark = S().get(wid);

    const status = root.querySelector('.atr-status');
    const btnPlus = root.querySelector('.atr-plus');
    const btnMinus = root.querySelector('.atr-minus');
    if (status) status.textContent = statusText(mark);

    if (btnPlus) {
      const active = mark === S().MARK_READ;
      btnPlus.classList.toggle('atr-active', active);
      btnPlus.setAttribute('aria-pressed', String(active));
    }
    if (btnMinus) {
      const active = mark === S().MARK_SKIP;
      btnMinus.classList.toggle('atr-active', active);
      btnMinus.setAttribute('aria-pressed', String(active));
    }
  }

  /** Перерисовывает все панели книги с данным workId (их обычно одна). */
  function renderAll(workId) {
    const nodes = document.querySelectorAll(
      '.atr-controls[data-atr-wid="' + String(workId) + '"]'
    );
    nodes.forEach(render);
    // v0.2.5: если включён тумблер «Скрыть отмечённые» — обновить скрытие
    // строки этой книги (клик, pull из облака, импорт, GC — везде, где
    // нет полного scan). ATR.dom появляется позже ui.js — доступ через guard.
    if (ATR.dom && typeof ATR.dom.applyHideFilter === 'function') {
      ATR.dom.applyHideFilter(workId);
    }
  }

  ATR.ui = { create, render, renderAll };
})();
