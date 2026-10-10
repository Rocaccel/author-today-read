/**
 * ATR.storage — модуль хранения отметок.
 *
 * Требование ТЗ: данные хранятся ТОЛЬКО локально в localStorage (без сети,
 * без chrome.storage). Content script работает в isolated world origin
 * https://author.today, поэтому window.localStorage — общий с самой страницей.
 * Используем собственный ключ с префиксом `atr.`, чтобы не пересекаться
 * с ключами сайта (например, `theme`).
 *
 * Схема значения по ключу KEY — JSON-объект:
 *   { "<workId>": "read" | "skip", ... }
 *   "read" — положительная отметка (✅), "skip" — отрицательная (❌).
 *   Отсутствие ключа у книги = нейтральное состояние (индикатор пуст).
 * Снятие отметки = удаление поля из объекта (не пишем null).
 */
(function () {
  'use strict';

  // Пространство имён, общее для всех content-скриптов (порядок подключения
  // в manifest: storage → ui → dom → main).
  const ATR = (globalThis.ATR = globalThis.ATR || {});

  const KEY = 'atr.v1.marks'; // версионированный ключ: atr.<версия>.<назначение>
  const MARK_READ = 'read';
  const MARK_SKIP = 'skip';

  /** Читает весь объект отметок. Повреждённый JSON не роняет работу —
   *  возвращаем пустой объект и логируем проблему. */
  function getAll() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch (err) {
      // localStorage может быть недоступен (приватный режим и т.п.)
      console.error('[ATR] localStorage недоступен:', err);
      return {};
    }
    if (raw === null || raw === '') return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      console.warn('[ATR] хранилище не объект, сбрасываю:', raw);
      return {};
    } catch (err) {
      console.error('[ATR] повреждённый JSON в хранилище, сбрасываю:', err);
      return {};
    }
  }

  /** Атомарная запись: читаем весь объект → мутируем одно поле → пишем целиком.
   *  localStorage не имеет транзакций, поэтому «атомарность» здесь —
   *  отсутствие промежуточных состояний на уровне нашего кода. */
  function writeAll(obj) {
    try {
      localStorage.setItem(KEY, JSON.stringify(obj));
    } catch (err) {
      console.error('[ATR] не удалось записать отметку:', err);
    }
  }

  /** Текущая отметка книги: "read" | "skip" | null (нет записи). */
  function get(workId) {
    const all = getAll();
    const mark = all[String(workId)];
    return mark === MARK_READ || mark === MARK_SKIP ? mark : null;
  }

  /** Поставить отметку (заменяет любую существующую). */
  function set(workId, mark) {
    const all = getAll();
    all[String(workId)] = mark;
    writeAll(all);
    notify(workId);
  }

  /** Снять отметку: удаляем поле, чтобы состояние стало нейтральным. */
  function remove(workId) {
    const all = getAll();
    if (String(workId) in all) {
      delete all[String(workId)];
      writeAll(all);
      notify(workId);
    }
  }

  /**
   * Переключение (семантика из AGENTS.md §1.1 — «переключатели с заменой»):
   *   стоит такая же отметка  → снять (вернуть null);
   *   стоит чужая / пусто     → поставить свою.
   * Возвращает новое состояние.
   */
  function toggle(workId, mark) {
    const current = get(workId);
    const next = current === mark ? null : mark;
    if (next === null) {
      remove(workId);
    } else {
      set(workId, next);
    }
    return next;
  }

  /**
   * Уведомление внутри страницы: content-скрипты разные — событие на document
   * слушает content/dom.js и обновляет все панели затронутой книги.
   * Кросс-табное обновление обеспечивает нативное событие `storage` (window),
   * его подписка живёт в content/dom.js.
   */
  function notify(workId) {
    try {
      document.dispatchEvent(
        new CustomEvent('atr:changed', { detail: { workId: String(workId) } })
      );
    } catch (err) {
      console.error('[ATR] не удалось разослать событие:', err);
    }
  }

  ATR.storage = {
    KEY,
    MARK_READ,
    MARK_SKIP,
    getAll,
    get,
    set,
    remove,
    toggle
  };
})();
