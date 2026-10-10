/**
 * ATR.sync — синхронизация отметок с Firebase (content-часть).
 *
 * Принципы (см. AGENTS.md §8):
 *   - localStorage остаётся первичным кэшем: офлайн и без фразы всё работает;
 *   - сеть выполняется ТОЛЬКО в background service worker (CORS расширения),
 *     сюда приходят только готовые данные через chrome.runtime.sendMessage;
 *   - синхронизация = один round-trip `atr:sync:sync`:
 *       content присылает весь локальный срез {wid: {m, t}},
 *       background сравнивает с облаком (LWW по t), пушит более новые
 *       локальные записи, возвращает более новые облачные — content сливает.
 *   - тишина при ошибке: нет конфига/фразы/сети — просто работаем локально
 *     (детали доступны на options-странице, там lastError).
 */
(function () {
  'use strict';

  const ATR = (globalThis.ATR = globalThis.ATR || {});

  const PUSH_DEBOUNCE_MS = 1500; // пауза после последнего клика перед push
  const FOCUS_DEBOUNCE_MS = 2000; // окно получило фокус — сверяемся с облаком
  const FOCUS_MIN_INTERVAL_MS = 30000; // но не чаще раза в 30 секунд

  let pushTimer = null;
  let focusTimer = null;
  let lastFocusSync = 0;
  let inFlight = false; // одновременно только один sync
  let pendingAfterFlight = false; // «запросили пока летит» — повторим после

  /** Расширение загружено как контент-скрипт (есть chrome.runtime)? */
  function isSupported() {
    return typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
  }

  /**
   * Полная синхронизация: отправляем локальный срез, получаем облачные
   * правки, сливаем (LWW живёт в storage.mergeRemote), перерисовываем.
   */
  async function syncNow() {
    if (!isSupported()) return;
    if (inFlight) {
      pendingAfterFlight = true;
      return;
    }
    inFlight = true;
    try {
      const entries = ATR.storage.getAll();
      const res = await chrome.runtime.sendMessage({ type: 'atr:sync:sync', entries });
      if (res && res.ok && res.pull && ATR.storage) {
        const changed = ATR.storage.mergeRemote(res.pull);
        // Перерисовка без события 'atr:changed', чтобы не зациклить push.
        if (changed.length && ATR.ui) {
          for (const wid of changed) ATR.ui.renderAll(wid);
        }
      }
      // res.ok=false (нет конфига/фразы/сеть) — тихо работаем локально.
    } catch (err) {
      // SW мог заснуть/расширение обновилось — не критично, молчим.
      console.debug('[ATR] синхронизация пропущена:', err && err.message);
    } finally {
      inFlight = false;
      if (pendingAfterFlight) {
        pendingAfterFlight = false;
        schedulePush();
      }
    }
  }

  /** Debounced push: серия кликов по кнопкам → одна синхронизация. */
  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      syncNow();
    }, PUSH_DEBOUNCE_MS);
  }

  /** Окно в фокусе: подтянуть изменения с других устройств. */
  function onWindowFocus() {
    const now = Date.now();
    if (now - lastFocusSync < FOCUS_MIN_INTERVAL_MS) return;
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      focusTimer = null;
      lastFocusSync = Date.now();
      syncNow();
    }, FOCUS_DEBOUNCE_MS);
  }

  /**
   * Инициализация (вызывается из main.js после загрузки всех модулей):
   *  1) первый pull при открытии страницы;
   *  2) push после каждого локального изменения (событие из storage.js);
   *  3) периодическая сверка при возврате фокуса на вкладку.
   */
  function init() {
    if (!isSupported()) return;

    document.addEventListener('atr:changed', () => schedulePush());
    window.addEventListener('focus', onWindowFocus);

    syncNow();
  }

  ATR.sync = { isSupported, init, syncNow };
})();
