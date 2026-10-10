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
   * Полная синхронизация одним round-trip.
   * @param {string} userId — hex hash фразы (путь в БД)
   * @param {string} phrase — нормализованная кодовая фраза (ключ шифрования)
   * @param {Object} localEntries — локальный срез {wid: {m, t}} из content
   * @returns {Promise<{pull: Object, pushed: number, skipped: number}>}
   *   pull — облачные записи НОВЕЕ локальных (расшифрованы, готовы к слиянию),
   *   pushed — сколько локальных записей ушло в облако,
   *   skipped — сколько облачных записей не расшифровались (чужая фраза/битость)
   */
  async function sync(userId, phrase, localEntries) {
    const key = await getKeyForPhrase(phrase);
    const remoteDocs = await pullDocs(userId);

    const pull = {};
    let skipped = 0;
    const remoteByWid = new Map();

    // 1) Расшифровываем облако, отбрасываем битые (чужая фраза / повреждение).
    for (const doc of remoteDocs) {
      remoteByWid.set(doc.workId, doc);
      try {
        const mark = await decryptMark(key, doc);
        pull[doc.workId] = { m: mark, t: doc.updatedAt };
      } catch (err) {
        skipped++;
        console.warn('[ATR] запись не расшифрована (чужая фраза?):', doc.workId);
      }
    }

    // 2) Что из локального новее облака — то пушим.
    const toPush = [];
    for (const [workId, entry] of Object.entries(localEntries || {})) {
      if (!entry || typeof entry.t !== 'number') continue;
      if (entry.m !== 'read' && entry.m !== 'skip' && entry.m !== null) continue;
      const remote = remoteByWid.get(workId);
      if (remote && remote.updatedAt >= entry.t) continue; // в облаке не старше
      const encrypted = await encryptMark(key, entry.m);
      toPush.push({ workId, updatedAt: entry.t, ...encrypted });
    }
    await pushDocs(userId, toPush);

    // 3) Из pull убираем записи, которые мы только что запушили (они уже
    //    согласованы; локальная версия новее или равна).
    for (const doc of toPush) delete pull[doc.workId];

    return { pull, pushed: toPush.length, skipped };
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
