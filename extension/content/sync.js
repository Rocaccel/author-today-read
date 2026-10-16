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

  // Импорт из файла (v0.2.4): options пишет санитизованный срез сюда
  // (options НЕ имеет доступа к localStorage страницы), content применяет.
  const PENDING_IMPORT_KEY = 'atr.sync.pendingImport';
  let importInFlight = false;

  // Ключ кодовой фразы в chrome.storage (K_PHRASE в service-worker): вход
  // (atr:phrase:set) и ротация (atr:phrase:rotate, v0.2.6) пишут его —
  // открытые вкладки подхватывают смену через chrome.storage.onChanged
  // и сразу синхронизируются, не дожидаясь фокуса/перезагрузки страницы.
  const PHRASE_KEY = 'atr.sync.phrase';

  // Полный вайп (v0.2.6): options удалил всю информацию — флаг просит content
  // стереть localStorage страницы (паттерн pendingImport: применяется и
  // удаляется; в открытых вкладках срабатывает сразу по onChanged).
  const WIPE_KEY = 'atr.sync.wipePending';
  let wipeInFlight = false;

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
   *   fail — сеть/правила/SW уснул → повтор с backoff (scheduleRetry);
   *   retry-soon — SW отклонил sync guard'ом ротации («идёт смена кодовой
   *     фразы», v0.2.6: событие смены фразы пришло раньше, чем ротация
   *     успела снять свой флаг) → это не сбой сети, повтор скоро
   *     (schedulePush ~1.5 с), НЕ backoff.
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
      } else if (res && res.ok === false && res.error === 'идёт смена кодовой фразы') {
        // Гонка (v0.2.6): storage-событие смены фразы обогнало завершение
        // ротации — guard отклонил sync. Не сетевой сбой: скоро повторим.
        outcome = 'retry-soon';
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
      else if (outcome === 'retry-soon') schedulePush(); // гонка с ротацией — быстрый повтор
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

  /**
   * Применить отложенный импорт из файла (v0.2.4): слияние LWW по t
   * (mergeRemote) — отметки новее файла не затираются; томбстоуны файла
   * тоже участвуют. Успешно применённый срез удаляется из chrome.storage
   * (повторные вкладки/idempotent), изменившиеся панели перерисовываются
   * (другие вкладки подхватывают через событие window 'storage'), уходит
   * push. Вызывается из init() и по chrome.storage.onChanged.
   */
  async function applyPendingImport() {
    if (importInFlight) return;
    if (!isSupported() || !chrome.storage || !chrome.storage.local) return;
    importInFlight = true;
    try {
      const data = await chrome.storage.local.get(PENDING_IMPORT_KEY);
      const entries = data && data[PENDING_IMPORT_KEY];
      if (!entries || typeof entries !== 'object') return;
      const changed = ATR.storage.mergeRemote(entries);
      if (changed.length && ATR.ui) {
        for (const wid of changed) ATR.ui.renderAll(wid);
      }
      await chrome.storage.local.remove(PENDING_IMPORT_KEY);
      if (changed.length) syncNow();
    } catch (err) {
      console.debug('[ATR] импорт не применён:', err && err.message);
    } finally {
      importInFlight = false;
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

  /**
   * Применить полный вайп (v0.2.6): стереть localStorage страницы
   * (storage.wipeAll) и удалить флаг. Идемпотентно (in-flight + удалённый
   * ключ). Вызывается из init() ДО первого syncNow и по
   * chrome.storage.onChanged (открытые вкладки чистятся сразу).
   */
  async function applyWipePending() {
    if (wipeInFlight) return;
    if (!isSupported() || !chrome.storage || !chrome.storage.local) return;
    wipeInFlight = true;
    try {
      const data = await chrome.storage.local.get(WIPE_KEY);
      if (!data || !data[WIPE_KEY]) return;
      if (ATR.storage && ATR.storage.wipeAll) ATR.storage.wipeAll();
      await chrome.storage.local.remove(WIPE_KEY);
      // Фраза уже удалена — sync вернёт skip БЕЗ сетевого запроса, но
      // обновит кэш статистики нулями (иначе счётчик мог бы остаться от
      // старых отметок: поздний ретрай другой вкладки записал бы их обратно).
      syncNow();
    } catch (err) {
      console.debug('[ATR] вайп не применён:', err && err.message);
    } finally {
      wipeInFlight = false;
    }
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
   *  1) первый pull при открытии страницы (после применения отложенного
   *     импорта, v0.2.4 — чтобы свежий push ушёл одним round-trip);
   *  2) push после каждого локального изменения (событие из storage.js);
   *  3) периодическая сверка при возврате фокуса на вкладку;
   *  4) немедленный повтор после восстановления сети (v0.2.1, событие online);
   *  5) отложенный импорт из Параметров (v0.2.4): проверка при загрузке +
   *     слушатель chrome.storage.onChanged для уже открытых вкладок;
   *  6) сохранение/смена фразы в Параметрах (v0.2.6): ветка того же
   *     слушателя по ключу atr.sync.phrase → немедленный syncNow()
   *     (вкладка подтягивает отметки сразу после входа и после ротации);
   *  7) полный вайп (v0.2.6): флаг atr.sync.wipePending → стирание
   *     localStorage (applyWipePending) — при загрузке ДО первого syncNow
   *     и сразу по onChanged в открытых вкладках.
   */
  function init() {
    if (!isSupported()) return;

    document.addEventListener('atr:changed', () => schedulePush());
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('online', onOnline);

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const c = changes[PENDING_IMPORT_KEY];
        if (c && c.newValue) applyPendingImport();
        // Фраза сохранена/сменена (вход либо ротация, v0.2.6) — сразу
        // подтягиваем отметки из базы; newValue: undefined = «Выйти» —
        // sync всё равно skip'нулся бы, не порождаем лишний запрос.
        const p = changes[PHRASE_KEY];
        if (p && p.newValue) syncNow();
        // Вайп: localStorage стираем немедленно, не дожидаясь визита.
        const w = changes[WIPE_KEY];
        if (w && w.newValue) applyWipePending();
      });
    }

    // Порядок критичен: импорт → вайп → первый syncNow (вайп строго ДО sync).
    applyPendingImport()
      .finally(() => applyWipePending())
      .finally(() => syncNow());
  }

  ATR.sync = { isSupported, init, syncNow, scheduleRetry, resetRetry, applyPendingImport, applyWipePending };
  // Тестовый хук: укорачивает интервалы backoff, чтобы тесты не ждали секунды.
  ATR.sync.__setRetryDelays = (arr) => {
    retryDelays = Array.isArray(arr) && arr.length ? arr.slice() : [5000];
  };
})();
