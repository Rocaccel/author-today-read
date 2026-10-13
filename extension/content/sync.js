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
 *   - тишина при ошибке: нет конфига/фразы — просто работаем локально
 *     (детали доступны на options-странице, там lastError);
 *   - ретраи (v0.2.1): сбой сети/SW повторяется с backoff 5с→15с→1м→5м→15м,
 *     событие `online` повторяет немедленно; `skip` не ретраится;
 *   - GC (v0.2.1): res.gc → storage.applyGc (жёсткое удаление протухших
 *     томбстоунов, решает background — см. AGENTS.md §8.2а).
 */
(function () {
  'use strict';

  const ATR = (globalThis.ATR = globalThis.ATR || {});

  const PUSH_DEBOUNCE_MS = 1500; // пауза после последнего клика перед push
  const FOCUS_DEBOUNCE_MS = 2000; // окно получило фокус — сверяемся с облаком
  const FOCUS_MIN_INTERVAL_MS = 30000; // но не чаще раза в 30 секунд

  // Backoff для ретраев при ошибке сети/правил (v0.2.1):
  // 5 с → 15 с → 1 мин → 5 мин → 15 мин (потолок, дальше каждые 15 мин).
  // Цепочка живёт, пока открыта вкладка; данные всегда лежат в localStorage,
  // поэтому смерть вкладки — не потеря, просто следующий триггер дошлёт всё.
  let retryDelays = [5000, 15000, 60000, 300000, 900000];

  let pushTimer = null;
  let focusTimer = null;
  let lastFocusSync = 0;
  let inFlight = false; // одновременно только один sync
  let pendingAfterFlight = false; // «запросили пока летит» — повторим после
  let retryTimer = null; // ожидающий ретрай (только один)
  let retryIdx = 0; // позиция в retryDelays

  /** Расширение загружено как контент-скрипт (есть chrome.runtime)? */
  function isSupported() {
    return typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
  }

  /**
   * Полная синхронизация: отправляем локальный срез, получаем облачные
   * правки, сливаем (LWW живёт в storage.mergeRemote), перерисовываем.
   *
   * Исходы (v0.2.1, ретраи):
   *   ok   — успех → сброс backoff;
   *   skip — нет конфига/фразы → это не сбой, НЕ ретраим (ждём настройки);
   *   fail — сеть/правила/SW уснул → повтор с backoff (scheduleRetry).
   */
  async function syncNow() {
    if (!isSupported()) return;
    if (inFlight) {
      pendingAfterFlight = true;
      return;
    }
    inFlight = true;
    let outcome = 'fail';
    try {
      const entries = ATR.storage.getAll();
      const res = await chrome.runtime.sendMessage({ type: 'atr:sync:sync', entries });
      if (res && res.ok) {
        outcome = 'ok';
        if (res.pull && ATR.storage) {
          const changed = ATR.storage.mergeRemote(res.pull);
          // Перерисовка без события 'atr:changed', чтобы не зациклить push.
          if (changed.length && ATR.ui) {
            for (const wid of changed) ATR.ui.renderAll(wid);
          }
        }
        // GC (v0.2.1): background прислал список workId, которые можно жёстко
        // удалить локально (протухшие томбстоуны). Событие 'atr:gc' слушает
        // dom.js — перерисовка; 'atr:changed' НЕ шлём, пушить после gc нечего.
        if (res.gc && res.gc.length && ATR.storage && ATR.storage.applyGc) {
          ATR.storage.applyGc(res.gc);
        }
      } else if (res && res.ok === false && res.skip) {
        outcome = 'skip'; // нет конфига/фразы — ретрай бессмыслен
      } else {
        outcome = 'fail'; // ok:false c error — ошибка сети/правил
      }
    } catch (err) {
      // SW мог заснуть/расширение обновилось/нет сети — ретраим с backoff.
      outcome = 'fail';
      console.debug('[ATR] синхронизация не удалась, будет повтор:', err && err.message);
    } finally {
      inFlight = false;
      if (outcome === 'ok') resetRetry();
      else if (outcome === 'fail') scheduleRetry();
      if (pendingAfterFlight) {
        pendingAfterFlight = false;
        schedulePush();
      }
    }
  }

  /** Планирует один ретрай (идемпотентно: уже стоящий таймер не сдвигаем). */
  function scheduleRetry() {
    if (retryTimer) return;
    const delay = retryDelays[Math.min(retryIdx, retryDelays.length - 1)];
    retryIdx++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      syncNow();
    }, delay);
  }

  /** Успех — обнуляем backoff и отменяем ожидающий повтор. */
  function resetRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryIdx = 0;
  }

  /** Сеть вернулась — повторяем немедленно, не дожидаясь backoff. */
  function onOnline() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    syncNow();
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
   *  3) периодическая сверка при возврате фокуса на вкладку;
   *  4) немедленный повтор после восстановления сети (v0.2.1, событие online).
   */
  function init() {
    if (!isSupported()) return;

    document.addEventListener('atr:changed', () => schedulePush());
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('online', onOnline);

    syncNow();
  }

  ATR.sync = { isSupported, init, syncNow, scheduleRetry, resetRetry };
  // Тестовый хук: укорачивает интервалы backoff, чтобы тесты не ждали секунды.
  ATR.sync.__setRetryDelays = (arr) => {
    retryDelays = Array.isArray(arr) && arr.length ? arr.slice() : [5000];
  };
})();
