/**
 * firebase.js — клиент Firebase (Firestore REST API) для background SW.
 *
 * Почему REST, а не SDK (см. AGENTS.md §8):
 *   - MV3 ES-модульный SW не умеет грузить удалённые скрипты, а firebase-SDK
 *     потребовал бы сборки (в проекте запрещена, §7);
 *   - Firestore полностью доступен по REST: list + batchWrite покрывают наши
 *     сценарии (pull всех отметок и пачечная запись).
 *
 * Модель данных: users/{userId}/marks/{workId} = {
 *   updatedAt: int   — открыто (для слияния LWW на клиенте),
 *   v, iv, ct: str    — AES-GCM шифротекст отметки (см. shared/phrase.js).
 * } Правила БД открытые — контент зашифрован ключом от кодовой фразы.
 *
 * Конфиг подтягивается динамическим import() из config.js (генерируется из
 * .env командой `npm run config`, файл в .gitignore). Если файла нет или
 * поля пустые — isReady() === false, синхронизация выключена, ошибок нет.
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

/** Загрузка конфига из config.js (может отсутствовать — это норма). */
let configPromise = null;
export function loadConfig() {
  if (!configPromise) {
    configPromise = import('./config.js').then(
      (m) => ({ config: m.firebaseConfig || {}, ready: !!m.firebaseConfigReady }),
      () => ({ config: {}, ready: false })
    );
  }
  return configPromise;
}

/** Клиент инициализируется с пустым конфигом; реальные значения loadConfig() подставит позже. */
export function initFirebase(config = {}) {
  const baseDocsUrl = () =>
    `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;

  /** Путь коллекции отметок пользователя. */
  const marksUrl = (userId) => `${baseDocsUrl()}/users/${userId}/marks`;

  /**
   * Pull: все отметки пользователя из облака → [{workId, updatedAt, ...iv/ct}].
   * Пустая коллекция у Firestore отвечает 404 NOT_FOUND — это «данных нет».
   */
  async function pullDocs(userId) {
    const url = `${marksUrl(userId)}?key=${encodeURIComponent(config.apiKey)}`;
    const res = await fetch(url, { method: 'GET' });
    if (res.status === 404) return [];
    if (!res.ok) throw httpError('pull', res);
    const body = await res.json();
    if (!body.documents) return [];
    return body.documents.map((doc) => {
      const f = doc.fields || {};
      return {
        // workId — последний сегмент имени документа users/{uid}/marks/{wid}
        workId: doc.name.split('/').pop(),
        updatedAt: Number(f.updatedAt ? f.updatedAt.integerValue : 0) || 0,
        v: f.v ? f.v.stringValue : '',
        iv: f.iv ? f.iv.stringValue : '',
        ct: f.ct ? f.ct.stringValue : ''
      };
    });
  }

  /**
   * Push: пачечная запись. batchWrite не принимает две записи на один doc —
   * по одному элементу на workId — это выполняется.
   */
  async function pushDocs(userId, docs) {
    if (!docs.length) return;
    const url = `${baseDocsUrl()}:batchWrite?key=${encodeURIComponent(config.apiKey)}`;
    const writes = docs.map((d) => ({
      update: {
        name: `${marksUrl(userId)}/${d.workId}`,
        fields: {
          updatedAt: { integerValue: String(d.updatedAt) },
          v: { stringValue: d.v },
          iv: { stringValue: d.iv },
          ct: { stringValue: d.ct }
        }
      }
    }));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes })
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
    return !!(config.apiKey && config.projectId);
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
