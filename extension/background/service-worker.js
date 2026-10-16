/**
 * Background service worker (Manifest V3, ES-модуль).
 *
 * Роль: единственное место с СЕТЬЮ (CORS расширения) и хранилищем
 * кодовой фразы. Content-скрипты общаются с ним через chrome.runtime.
 *
 * Протокол сообщений (см. AGENTS.md §8):
 *   atr:status        → состояние (конфиг/фраза/последняя синхронизация)
 *   atr:phrase:set    {phrase}  → валидация, userId, сохранение фразы
 *   atr:phrase:clear  → выход (фраза удаляется с устройства)
 *   atr:phrase:rotate {phrase}  → ротация фразы без потери отметок (v0.2.6):
 *                     перешифровка + переезд на новый userId, старый путь
 *                     удаляется, потом сохраняется новая фраза
 *   atr:sync:sync     {entries} → полный round-trip с Realtime Database,
 *                     возврат pull
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
const K_STATS = 'atr.sync.stats'; // {read, skip, total, at} — кэш счётчиков (v0.2.2)
const K_SNAPSHOT = 'atr.sync.snapshot'; // {entries, at} — последний срез от content (v0.2.4, экспорт)
const K_WIPE = 'atr.sync.wipePending'; // флаг полного вайпа (v0.2.6): content чистит localStorage

/**
 * Счётчики из локального среза {wid: {m, t}} (v0.2.2).
 * Томбстоуны (m:null) и мусор не считаются; total = read + skip.
 */
export function computeStats(entries) {
  let read = 0;
  let skip = 0;
  for (const entry of Object.values(entries || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.m === 'read') read++;
    else if (entry.m === 'skip') skip++;
  }
  return { read, skip, total: read + skip, at: new Date().toISOString() };
}

/**
 * Кэшировать счётчики и полный снапшот среза. Вызывается из handleSync
 * ТОЛЬКО для сообщений от content-вкладок (sender.tab): options шлёт
 * atr:sync:sync с entries:{} — без этой проверки он обнулял бы статистику
 * и экспорт (v0.2.4). Кэш обновляется ДО проверок конфига/фразы — счётчики
 * локальные и работают без синхронизации.
 */
async function saveStatsFrom(entries, sender) {
  if (!sender || !sender.tab || !entries || typeof entries !== 'object') return;
  await chrome.storage.local.set({
    [K_STATS]: computeStats(entries),
    [K_SNAPSHOT]: { entries, at: new Date().toISOString() }
  });
}

/** Сохранённая фраза (нормализованная) или null. */
async function getPhrase() {
  const data = await chrome.storage.local.get(K_PHRASE);
  return data[K_PHRASE] || null;
}

// --- Guard ротации и вайпа (v0.2.6): окно гонки с незавершёнными sync -----
// `opLabel='rotate'|'wipe'` ставится синхронно до первого await, guard в
// handleSync проверяет его до любого await — новый sync либо отклонён ДО
// инкремента счётчика, либо (начатый раньше) уже посчитан и ждётся drain'ом.
let opLabel = null;
let activeSyncs = 0;

/** Дождаться завершения sync, начатых до ротации (или timeout, мс). */
async function waitForDrain(timeoutMs = 10000) {
  const started = Date.now();
  while (activeSyncs > 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return activeSyncs === 0;
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
  const data = await chrome.storage.local.get([K_LAST_SYNC, K_LAST_ERROR, K_STATS]);
  const configReady = !!(config.databaseURL && config.databaseURL.startsWith('https://'));
  return {
    ok: true,
    configReady,
    hasPhrase: !!phrase,
    // Фразу отдаём options-странице (extension-origin): там есть кнопки
    // «Показать»/«Копировать» (см. §8.5). Страница author.today её не видит.
    phrase: phrase || null,
    userId: userId || null,
    lastSync: data[K_LAST_SYNC] || null,
    lastError: data[K_LAST_ERROR] || null,
    // Локальная статистика (v0.2.2): доступна ВСЕГДА, без фразы и конфига —
    // считается из localStorage страницы (кэш обновляет content при каждом sync).
    stats: data[K_STATS] || { read: 0, skip: 0, total: 0, at: null },
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
 * atr:phrase:rotate — ротация фразы без потери отметок (v0.2.6).
 *
 * Порядок (безопасность при сбое):
 *   1) drain незавершённых sync (opLabel закрывает окно гонки —
 *      иначе параллельный push мог бы воскресить старый путь после DELETE);
 *   2) миграция в firebase.rotate: LWW-слияние (облако + снапшот + новый
 *      путь) → перешифровка → PATCH нового пути → DELETE старого;
 *   3) и ТОЛЬКО потом сохранение новой фразы/userId в chrome.storage.
 * Сбой на любом шаге оставляет хранилище и старый путь нетронутыми —
 * ротацию можно спокойно повторить.
 */
async function handlePhraseRotate(msg) {
  opLabel = 'rotate'; // синхронно, до первого await — guard в handleSync видит сразу
  try {
    const drained = await waitForDrain();
    if (!drained) {
      return { ok: false, error: 'не удалось дождаться текущих синхронизаций — повторите попытку' };
    }

    const { config, ready } = await loadConfig();
    if (!ready) return { ok: false, error: 'синхронизация не настроена (нет конфига) — смена фразы невозможна' };

    const oldPhrase = await getPhrase();
    if (!oldPhrase) return { ok: false, error: 'нет текущей фразы — сначала войдите' };

    const newPhrase = normalizePhrase(msg && msg.phrase);
    const validationError = validatePhrase(newPhrase);
    if (validationError) return { ok: false, error: validationError };
    if (newPhrase === oldPhrase) return { ok: false, error: 'новая фраза совпадает с текущей' };

    const oldUserId = (await getUserId()) || (await deriveUserId(oldPhrase));
    const newUserId = await deriveUserId(newPhrase);
    if (newUserId === oldUserId) return { ok: false, error: 'новая фраза совпадает с текущей' };

    const data = await chrome.storage.local.get(K_SNAPSHOT);
    const snapshot = (data[K_SNAPSHOT] && data[K_SNAPSHOT].entries) || {};

    const client = initFirebase(config);
    const result = await client.rotate(oldUserId, oldPhrase, newUserId, newPhrase, snapshot);

    // Миграция и DELETE старого пути выполнены — фиксируем новую фразу.
    await chrome.storage.local.set({
      [K_PHRASE]: newPhrase,
      [K_USER]: newUserId,
      [K_LAST_SYNC]: new Date().toISOString()
    });
    await setLastError(null);
    return { ok: true, userId: newUserId, migrated: result.migrated, skipped: result.skipped };
  } catch (err) {
    // Ошибка сети/правил ДО сохранения фразы: storage и старый путь не тронуты.
    let message = String(err && err.message ? err.message : err);
    if (err && (err.status === 401 || err.status === 403)) {
      message += ' — проверьте правила Realtime Database (должны быть открыты, см. DEVELOPMENT.md)';
    }
    await setLastError(message);
    return { ok: false, error: message };
  } finally {
    opLabel = null;
  }
}

/**
 * atr:data:wipe — полное удаление всей информации (v0.2.6): облачные отметки
 * (если доступны), статусы/копии отметок в chrome.storage и флаг для content
 * (localStorage сайта чистит вкладка — сразу по onChanged или при следующем
 * визите). Порядок как при ротации: guard → drain → DELETE облака (сбой →
 * НИЧЕГО не тронуто, повтор безопасен) → очистка storage → флаг.
 *
 * Без конфига или без фразы облако пропускается (`cloudDeleted:false`,
 * `reason: 'no-config'|'no-phrase'`): локальные данные обязан удалить любой
 * пользователь, даже если синхронизация не настраивалась.
 */
async function handleDataWipe() {
  opLabel = 'wipe'; // синхронно, до первого await — guard в handleSync видит сразу
  try {
    const drained = await waitForDrain();
    if (!drained) {
      return { ok: false, error: 'не удалось дождаться текущих синхронизаций — повторите попытку' };
    }

    let cloudDeleted = false;
    let reason = null;
    const { config, ready } = await loadConfig();
    const phrase = await getPhrase();
    if (!ready) {
      reason = 'no-config';
    } else if (!phrase) {
      reason = 'no-phrase';
    } else {
      const userId = (await getUserId()) || (await deriveUserId(phrase));
      await initFirebase(config).clearCloud(userId); // сбой → catch, storage не тронут
      cloudDeleted = true;
    }

    // Локальные данные расширения, включая копии отметок (stats, snapshot)
    // и отложенный импорт — иначе после вайпа «воскреснут» бы откуда-нибудь.
    await chrome.storage.local.remove([
      K_PHRASE, K_USER, K_LAST_SYNC, K_LAST_ERROR, K_STATS, K_SNAPSHOT, 'atr.sync.pendingImport'
    ]);
    // Флаг — последним: content в открытых вкладках чистит localStorage сразу,
    // при отсутствии вкладок — при следующем визите на author.today.
    await chrome.storage.local.set({ [K_WIPE]: Date.now() });
    return { ok: true, cloudDeleted, reason };
  } catch (err) {
    // Сбой ДО очистки storage (обычно DELETE облака): всё ещё на месте.
    let message = String(err && err.message ? err.message : err);
    if (err && (err.status === 401 || err.status === 403)) {
      message += ' — проверьте правила Realtime Database (должны быть открыты, см. DEVELOPMENT.md)';
    }
    await setLastError(message);
    return { ok: false, error: message };
  } finally {
    opLabel = null;
  }
}

/**
 * atr:sync:sync — полный round-trip:
 * pull облака → LWW-сравнение с локальным срезом → push новых → вернуть pull.
 */
async function handleSync(msg, sender) {
  // Guard ротации/вайпа (v0.2.6): БЕЗ await — атомарен с присвоением `opLabel`
  // (оба выполняются синхронно при входе в хендлер). Отклонённый sync
  // ретраится на content (ротация — скоро, вайп — штатным backoff).
  if (opLabel) {
    return {
      ok: false,
      error: opLabel === 'rotate' ? 'идёт смена кодовой фразы' : 'идёт удаление данных'
    };
  }
  activeSyncs++; // инкремент тоже до первого await — drain гарантированно ждёт
  try {
    // Статистика (v0.2.2): кэш счётчиков обновляется в первую очередь —
    // до проверок конфига/фразы (локальные данные) и только от content-вкладок.
    await saveStatsFrom(msg && msg.entries, sender);

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
      // gc (v0.2.1) — workId протухших томбстоунов: content жёстко удалит их
      // локально через storage.applyGc (узлы в БД уже удалены в firebase.js).
      return {
        ok: true,
        pull: result.pull,
        pushed: result.pushed,
        skipped: result.skipped,
        gc: result.gc || []
      };
    } catch (err) {
      // Ошибка сети/правил — сохраняем для options, content остаётся тихим.
      let message = String(err && err.message ? err.message : err);
      if (err && (err.status === 401 || err.status === 403)) {
        message += ' — проверьте правила Realtime Database (должны быть открыты, см. DEVELOPMENT.md)';
      }
      await setLastError(message);
      return { ok: false, error: message };
    }
  } finally {
    activeSyncs--; // ровно один декремент на каждый инкремент (все пути возврата)
  }
}

/** Роутер сообщений. sendResponse асинхронный → возвращаем true. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  const handlers = {
    'atr:status': handleStatus,
    'atr:phrase:set': handlePhraseSet,
    'atr:phrase:clear': handlePhraseClear,
    'atr:phrase:rotate': handlePhraseRotate,
    'atr:data:wipe': handleDataWipe,
    'atr:sync:sync': handleSync
  };
  const handler = handlers[type];
  if (!handler) return false;

  handler(msg, sender)
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

// Клик по иконке в тулбаре → открыть Параметры (без попапа, v0.2.3)
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
