/**
 * firebase.js — клиент Realtime Database (REST API) для background SW.
 *
 * Почему REST, а не SDK (см. AGENTS.md §8):
 *   - MV3 ES-модульный SW не умеет грузить удалённые скрипты, а firebase-SDK
 *     потребовал бы сборки (в проекте запрещена, §7);
 *   - Realtime Database полностью доступен по REST: GET/PATCH на узел
 *     покрывают наши сценарии (pull всех отметок и пачечная запись).
 *
 * БД проекта — Realtime Database (databaseURL из .env), НЕ Firestore.
 * Модель данных (см. AGENTS.md §8.2):
 *   users/{userId}/marks/{workId} = {
 *     updatedAt: int   — открыто (для слияния LWW на клиенте),
 *     v, iv, ct: str    — AES-GCM шифротекст отметки (см. shared/phrase.js).
 *   }
 * Правила БД открытые — контент зашифрован ключом от кодовой фразы.
 *
 * Конфиг подтягивается через fetch(chrome.runtime.getURL('background/config.json'))
 * (файл генерируется из .env командой `npm run config`, в .gitignore). Если файла
 * нет или databaseURL пустой — isReady() === false, синхронизация выключена,
 * ошибок нет. ВАЖНО: динамический import() в ServiceWorkerGlobalScope запрещён
 * спецификацией HTML (w3c/ServiceWorker#1356) — используем только fetch.
 * Ключ API для RTDB REST не нужен — доступ определяют только правила БД.
 */

import { deriveKey, encryptMark, decryptMark } from '../shared/phrase.js';

/** Срок жизни томбстоунов (v0.2.1): после — удаляются локально и в БД. */
export const GC_TOMBSTONE_MS = 90 * 24 * 60 * 60 * 1000;

/** Кэш ключа: PBKDF2 (100k) дорогой — не выводим на каждый sync. */
let keyCache = { phrase: null, key: null };

async function getKeyForPhrase(phrase) {
  if (keyCache.phrase === phrase && keyCache.key) return keyCache.key;
  const key = await deriveKey(phrase);
  keyCache = { phrase, key };
  return key;
}

/** Кэш конфига: файл читаем один раз за жизнь SW. */
let configPromise = null;
export function loadConfig() {
  if (!configPromise) {
    configPromise = fetch(chrome.runtime.getURL('background/config.json'))
      .then((res) => (res.ok ? res.json() : {}))
      .then((config) => ({ config: config || {}, ready: !!(config && config.databaseURL) }))
      .catch(() => ({ config: {}, ready: false })); // файла нет (свежий клон) — это норма
  }
  return configPromise;
}

/** Клиент инициализируется с пустым конфигом; реальные значения loadConfig() подставит позже. */
export function initFirebase(config = {}) {
  // Базовый URL Realtime Database без хвостового слэша
  const root = String(config.databaseURL || '').replace(/\/+$/, '');

  /** Узел отметок пользователя: {root}/users/{uid}/marks.json */
  const marksUrl = (userId) => `${root}/users/${userId}/marks.json`;

  /**
   * Pull: все отметки пользователя из облака → [{workId, updatedAt, ...iv/ct}].
   * Пустой узел в RTDB — это `null` в теле ответа (не ошибка).
   */
  async function pullDocs(userId) {
    const res = await fetch(marksUrl(userId), { method: 'GET' });
    if (!res.ok) throw httpError('pull', res);
    const body = await res.json();
    if (!body || typeof body !== 'object') return []; // null — данных нет
    return Object.entries(body)
      .filter(([workId, val]) => workId && val && typeof val === 'object')
      .map(([workId, val]) => ({
        workId,
        updatedAt: Number(val.updatedAt) || 0,
        v: String(val.v || ''),
        iv: String(val.iv || ''),
        ct: String(val.ct || '')
      }));
  }

  /**
   * Push: пачечная запись одним PATCH (RTDB мержит переданные ветки,
   * чужие workId не затрагивает). Томбстоуны шифруются так же, как отметки.
   */
  async function pushDocs(userId, docs) {
    if (!docs.length) return;
    const patch = {};
    for (const d of docs) {
      patch[d.workId] = { updatedAt: d.updatedAt, v: d.v, iv: d.iv, ct: d.ct };
    }
    const res = await fetch(marksUrl(userId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!res.ok) throw httpError('push', res);
  }

  /**
   * Удаление узлов (GC томбстоунов, v0.2.1): в RTDB REST значение null
   * в теле PATCH удаляет ключ. Пустой список — запроса нет.
   * Идемпотентно: несуществующий узел — no-op.
   */
  async function deleteDocs(userId, wids) {
    if (!wids.length) return;
    const patch = {};
    for (const wid of wids) patch[wid] = null;
    const res = await fetch(marksUrl(userId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!res.ok) throw httpError('delete', res);
  }

  /**
   * Полная синхронизация одним round-trip.
   *
   * Правила GC (v0.2.1, cutoff = now − 90 дней, работает только ТОМБСТОУН —
   * живые отметки не удаляются никогда):
   *   - облачный томбстоун старше cutoff: не отдаётся в pull, узел удаляется
   *     из БД, wid попадает в gc (content вычищает свою локальную копию,
   *     если она старше или тоже протухла);
   *   - локальный томбстоун старше cutoff: не пушится, wid попадает в gc;
   *   - локальная запись НОВЕЕ протухшего облачного томбстоуна — пушится
   *     по обычным правилам (перекрывает удаление), wid из gc убирается;
   *   - протухший томбстоун никогда не «воскрешает» чужие данные.
   *
   * ИЗВЕСТНЫЙ РИСК (принят): устройство, молчащее дольше 90 дней, может
   * затянуть и запушить свою старую отметку после удаления узла — порог
   * GC-окна выбран пользователем (AGENTS.md §8).
   *
   * @param {string} userId — hex hash фразы (путь в БД)
   * @param {string} phrase — нормализованная кодовая фраза (ключ шифрования)
   * @param {Object} localEntries — локальный срез {wid: {m, t}} из content
   * @returns {Promise<{pull: Object, pushed: number, skipped: number, gc: string[]}>}
   *   pull — облачные записи НОВЕЕ локальных (расшифрованы, готовы к слиянию),
   *   pushed — сколько локальных записей ушло в облако,
   *   skipped — сколько облачных записей не расшифровались (чужая фраза/битость),
   *   gc — workId, которые content обязан жёстко удалить локально (applyGc)
   */
  async function sync(userId, phrase, localEntries) {
    const key = await getKeyForPhrase(phrase);
    const cutoff = Date.now() - GC_TOMBSTONE_MS;
    const remoteDocs = await pullDocs(userId);

    const pull = {};
    const gcSet = new Set();
    let skipped = 0;
    const remoteByWid = new Map();

    // 1) Расшифровываем облако, отбрасываем битые (чужая фраза / повреждение).
    for (const doc of remoteDocs) {
      remoteByWid.set(doc.workId, doc);
      try {
        const mark = await decryptMark(key, doc);
        // Протухший облачный томбстоун: в pull не отдаём (иначе content его
        // пере-добавит), планируем удаление узла и локальной копии.
        if (mark === null && doc.updatedAt < cutoff) {
          gcSet.add(doc.workId);
          continue;
        }
        pull[doc.workId] = { m: mark, t: doc.updatedAt };
      } catch (err) {
        skipped++;
        console.warn('[ATR] запись не расшифрована (чужая фраза?):', doc.workId);
      }
    }

    // 2) Что из локального новее облака — то пушим (с GC-исключениями).
    const toPush = [];
    for (const [workId, entry] of Object.entries(localEntries || {})) {
      if (!entry || typeof entry.t !== 'number') continue;
      if (entry.m !== 'read' && entry.m !== 'skip' && entry.m !== null) continue;

      const remote = remoteByWid.get(workId);

      // Локальный протухший томбстоун: никогда не пушим.
      if (entry.m === null && entry.t < cutoff) {
        // Облачные данные живые и новее — их заберёт pull (merge сам поправит
        // локальное), удалять в облако нельзя.
        if (remote && !gcSet.has(workId) && remote.updatedAt > entry.t) continue;
        gcSet.add(workId); // drop локально (+ удаление узла, если он есть)
        continue;
      }

      if (remote && remote.updatedAt >= entry.t) {
        // В облаке не старше — push не нужен. Если облачная версия это
        // протухший томбстоун (wid уже в gcSet), локальная запись проиграла
        // историческому удалению и вычистится через gc; иначе её поправит pull.
        continue;
      }

      // Локальное новее (или облака нет) — пушим; перекрывает протухший
      // облачный томбстоун, поэтому wid из gc убираем.
      const encrypted = await encryptMark(key, entry.m);
      toPush.push({ workId, updatedAt: entry.t, ...encrypted });
      gcSet.delete(workId);
    }
    await pushDocs(userId, toPush);

    // 3) Удаляем протухшие томбстоуны из БД (отдельным PATCH с null).
    const gc = [...gcSet];
    if (gc.length) await deleteDocs(userId, gc);

    // 4) Из pull убираем записи, которые мы только что запушили (они уже
    //    согласованы; локальная версия новее или равна).
    for (const doc of toPush) delete pull[doc.workId];

    return { pull, pushed: toPush.length, skipped, gc };
  }

  function isReady() {
    return !!root;
  }

  /** Ошибку HTTP превращаем в понятный статус для options-страницы. */
  function httpError(stage, res) {
    const err = new Error(`${stage}: HTTP ${res.status}`);
    err.stage = stage;
    err.status = res.status;
    return err;
  }

  return { isReady, sync, pullDocs };
}
