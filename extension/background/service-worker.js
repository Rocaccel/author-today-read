/**
 * Background service worker (Manifest V3, ES-модуль).
 *
 * Роль в v0.2.0: единственное место с СЕТЬЮ (CORS расширения) и хранилищем
 * кодовой фразы. Content-скрипты общаются с ним через chrome.runtime.
 *
 * Протокол сообщений (см. AGENTS.md §8):
 *   atr:status        → состояние (конфиг/фраза/последняя синхронизация)
 *   atr:phrase:set    {phrase}  → валидация, userId, сохранение фразы
 *   atr:phrase:clear  → выход (фраза удаляется с устройства)
 *   atr:sync:sync     {entries} → полный round-trip с Firestore, возврат pull
 *
 * Фраза хранится ТОЛЬКО в chrome.storage.local (читает одно расширение,
 * страница author.today её не видит). В page localStorage не попадает.
 */

import { initFirebase, loadConfig } from './firebase.js';
import { validatePhrase, normalizePhrase, deriveUserId } from '../shared/phrase.js';

// Ключи chrome.storage.local (префикс atr.* — не пересекаемся ни с чем)
const K_PHRASE = 'atr.sync.phrase';
const K_USER = 'atr.sync.userId';
const K_LAST_SYNC = 'atr.sync.lastSync';
const K_LAST_ERROR = 'atr.sync.lastError';

/** Сохранённая фраза (нормализованная) или null. */
async function getPhrase() {
  const data = await chrome.storage.local.get(K_PHRASE);
  return data[K_PHRASE] || null;
}

/** Сохранённый userId (hex) или null. */
async function getUserId() {
  const data = await chrome.storage.local.get(K_USER);
  return data[K_USER] || null;
}

async function setLastError(message) {
  await chrome.storage.local.set({ [K_LAST_ERROR]: message || null });
}

/** atr:status — всё, что нужно options-странице. */
async function handleStatus() {
  const { config } = await loadConfig();
  const [phrase, userId] = await Promise.all([getPhrase(), getUserId()]);
  const data = await chrome.storage.local.get([K_LAST_SYNC, K_LAST_ERROR]);
  const configReady = !!(config.apiKey && config.projectId);
  return {
    ok: true,
    configReady,
    hasPhrase: !!phrase,
    userId: userId || null,
    lastSync: data[K_LAST_SYNC] || null,
    lastError: data[K_LAST_ERROR] || null,
    // полная готовность к синхронизации
    ready: configReady && !!phrase
  };
}

/** atr:phrase:set — валидация и сохранение новой/первой фразы. */
async function handlePhraseSet(msg) {
  const error = validatePhrase(msg && msg.phrase);
  if (error) return { ok: false, error };
  const phrase = normalizePhrase(msg.phrase);
  const userId = await deriveUserId(phrase); // детерминирован из фразы
  await chrome.storage.local.set({ [K_PHRASE]: phrase, [K_USER]: userId });
  await setLastError(null);
  return { ok: true, userId };
}

/** atr:phrase:clear — фраза удаляется, синхронизация прекращается. */
async function handlePhraseClear() {
  await chrome.storage.local.remove([K_PHRASE, K_USER, K_LAST_ERROR]);
  return { ok: true };
}

/**
 * atr:sync:sync — полный round-trip:
 * pull облака → LWW-сравнение с локальным срезом → push новых → вернуть pull.
 */
async function handleSync(msg) {
  const { config, ready } = await loadConfig();
  if (!ready) return { ok: false, skip: true, reason: 'config' };

  const phrase = await getPhrase();
  if (!phrase) return { ok: false, skip: true, reason: 'phrase' };

  let userId = await getUserId();
  if (!userId) {
    userId = await deriveUserId(phrase); // самовосстановление после чистки storage
    await chrome.storage.local.set({ [K_USER]: userId });
  }

  try {
    const client = initFirebase(config);
    const result = await client.sync(userId, phrase, (msg && msg.entries) || {});
    await chrome.storage.local.set({ [K_LAST_SYNC]: new Date().toISOString() });
    await setLastError(null);
    return { ok: true, pull: result.pull, pushed: result.pushed, skipped: result.skipped };
  } catch (err) {
    // Ошибка сети/правил — сохраняем для options, content остаётся тихим.
    let message = String(err && err.message ? err.message : err);
    if (err && (err.status === 401 || err.status === 403)) {
      message += ' — проверьте правила Firestore (должны быть открыты, см. README)';
    }
    await setLastError(message);
    return { ok: false, error: message };
  }
}

/** Роутер сообщений. sendResponse асинхронный → возвращаем true. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  const handlers = {
    'atr:status': handleStatus,
    'atr:phrase:set': handlePhraseSet,
    'atr:phrase:clear': handlePhraseClear,
    'atr:sync:sync': handleSync
  };
  const handler = handlers[type];
  if (!handler) return false;

  handler(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  console.info(
    `[ATR] расширение установлено/обновлено (${details.reason}). ` +
      'Отметки: localStorage (atr.v2.marks, кэш) + синхронизация через Firebase.'
  );
});
