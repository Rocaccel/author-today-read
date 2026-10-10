/**
 * ATR — точка входа content script.
 *
 * Порядок подключения в manifest.json (важен!):
 *   storage.js → ui.js → dom.js → main.js
 * Каждый предыдущий модуль кладёт свой API в globalThis.ATR,
 * здесь мы только проверяем готовность и запускаем интеграцию.
 */
(function () {
  'use strict';

  const ATR = (globalThis.ATR = globalThis.ATR || {});

  function init() {
    if (!ATR.storage || !ATR.ui || !ATR.dom) {
      console.error('[ATR] модули не загружены, порядок подключения нарушен:', Object.keys(ATR));
      return;
    }
    // Вне /search* и /work* ничего не делаем (см. AGENTS.md §1.2).
    if (!ATR.dom.isEnabledPage()) return;
    ATR.dom.start();
  }

  // document_idle: DOM уже построен, но сайт может дописывать разметку —
  // дальнейшие изменения накрывает MutationObserver внутри ATR.dom.start().
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
