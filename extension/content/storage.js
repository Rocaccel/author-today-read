/**
 * ATR.storage — модуль хранения отметок (схема v2).
 *
 * Хранение (см. AGENTS.md §3):
 *   - localStorage страницы author.today, ключ `atr.v2.marks`:
 *       { "<workId>": { "m": "read"|"skip"|null, "t": epoch_ms }, ... }
 *     m — отметка (null = нейтральное состояние/томбстоун),
 *     t — время последнего изменения (нужно для слияния с облаком, LWW).
 *   - томбстоуны (m: null) намеренно НЕ удаляются: без них удаление
 *     «воскресло» бы на другом устройстве при следующей синхронизации.
 *   - миграция со схемы v1 (`atr.v1.marks`: {workId: mark}) выполняется
 *     один раз при первом чтении: t = момент миграции, затем v1 удаляется.
 *
 * Content script работает в isolated world origin https://author.today,
 * поэтому window.localStorage общий с самой страницей. Собственный ключ
 * с префиксом `atr.` — не пересекаемся с ключами сайта (например, `theme`).
 */
(function () {
  'use strict';

  // Пространство имён, общее для всех content-скриптов (порядок подключения
  // в manifest: storage → sync → ui → dom → main).
  const ATR = (globalThis.ATR = globalThis.ATR || {});

  const KEY_V2 = 'atr.v2.marks'; // текущая схема
  const KEY_V1 = 'atr.v1.marks'; // старая схема (мигрируется и удаляется)
  const MARK_READ = 'read';
  const MARK_SKIP = 'skip';

  // --- Низкоуровневые операции с localStorage ---

  /** Читает сырой объект схемы v2. Повреждённый JSON не роняет работу. */
  function readRaw() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY_V2);
    } catch (err) {
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

  /** Атомарная запись: читаем весь объект → мутируем одно поле → пишем целиком. */
  function writeRaw(obj) {
    try {
      localStorage.setItem(KEY_V2, JSON.stringify(obj));
    } catch (err) {
      console.error('[ATR] не удалось записать отметку:', err);
    }
  }

  /**
   * Одноразовая миграция v1 → v2.
   * Формат v1: { "659887": "read" } → v2: { "659887": { m: "read", t: <now> } }.
   * Вызывается из getAll() при отсутствии ключа v2 и наличии ключа v1.
   */
  function migrateV1IfNeeded() {
    let rawV1 = null;
    try {
      rawV1 = localStorage.getItem(KEY_V1);
    } catch (_) {
      return;
    }
    if (rawV1 === null || rawV1 === '') return;

    let migrated = {};
    try {
      const parsed = JSON.parse(rawV1);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const now = Date.now();
        migrated = {};
        for (const [wid, mark] of Object.entries(parsed)) {
          // Принимаем только валидные значения схемы v1
          if (mark === MARK_READ || mark === MARK_SKIP) migrated[wid] = { m: mark, t: now };
        }
      }
    } catch (err) {
      console.error('[ATR] ошибка миграции v1→v2:', err);
    }

    // Пишем v2 (даже пустой — чтобы миграцию не повторять) и удаляем v1.
    if (localStorage.getItem(KEY_V2) === null) writeRaw(migrated);
    try {
      localStorage.removeItem(KEY_V1);
    } catch (_) {
      /* ignore */
    }
    console.info('[ATR] хранилище мигрировано с atr.v1.marks на atr.v2.marks');
  }

  /** Весь объект отметок схемы v2 (после возможной миграции). */
  function getAll() {
    migrateV1IfNeeded();
    return readRaw();
  }

  /**
   * Слияние с облачными данными (LWW по t, см. AGENTS.md §8).
   * remote: { workId: { m, t } } — уже расшифрованные данные из Firebase.
   * Возвращает массив workId, чьи записи изменились локально.
   * Побеждает запись с большим t; при равных t побеждает локальная
   * (не трогаем — пусть остаётся как есть, расхождение критично редко).
   */
  function mergeRemote(remote) {
    const local = getAll();
    const changed = [];
    if (!remote || typeof remote !== 'object') return changed;

    for (const [wid, incoming] of Object.entries(remote)) {
      if (!incoming || typeof incoming.m !== 'string' && incoming.m !== null) continue;
      if (typeof incoming.t !== 'number') continue;

      const current = local[wid];
      if (current && typeof current.t === 'number' && current.t >= incoming.t) continue;

      local[wid] = { m: incoming.m, t: incoming.t };
      changed.push(wid);
    }

    if (changed.length) writeRaw(local);
    return changed;
  }

  /** Текущая отметка книги: "read" | "skip" | null (нет записи или томбстоун). */
  function get(workId) {
    const entry = getAll()[String(workId)];
    if (!entry || typeof entry !== 'object') return null;
    return entry.m === MARK_READ || entry.m === MARK_SKIP ? entry.m : null;
  }

  /** Время последнего изменения отметки (для синхронизации). 0 если нет записи. */
  function getStamp(workId) {
    const entry = getAll()[String(workId)];
    return entry && typeof entry.t === 'number' ? entry.t : 0;
  }

  /** Поставить отметку (заменяет любую существующую), метка времени = сейчас. */
  function set(workId, mark) {
    const all = getAll();
    all[String(workId)] = { m: mark, t: Date.now() };
    writeRaw(all);
    notify(workId);
  }

  /**
   * Снять отметку: записываем ТОМБСТОУН { m: null, t: now }, а не удаляем поле —
   * только так удаление синхронизируется на другие устройства (см. §3).
   * Если записи и так нет — ничего не делаем.
   */
  function remove(workId) {
    const all = getAll();
    const wid = String(workId);
    if (!(wid in all)) return;
    if (all[wid] && all[wid].m === null) return; // уже томбстоун — не трогаем t
    all[wid] = { m: null, t: Date.now() };
    writeRaw(all);
    notify(workId);
  }

  /**
   * Переключение (семантика AGENTS.md §1.1 — «переключатели с заменой»):
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
   * слушает content/dom.js (перерисовка панелей) и content/sync.js (push в облако).
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
    KEY_V2,
    KEY_V1,
    MARK_READ,
    MARK_SKIP,
    getAll,
    get,
    getStamp,
    set,
    remove,
    toggle,
    mergeRemote
  };
})();
