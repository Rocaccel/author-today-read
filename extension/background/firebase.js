/**
 * firebase.js — клиент Realtime Database (REST API) для background SW.
 *
 * Почему REST, а не SDK (см. AGENTS.md §8):
 *   - MV3 ES-модульный SW не умеет грузить удалённые скрипты, а firebase-SDK
 *     потребовал бы сборки (в проекте запрещена, §7);
 *   - Realtime Database полностью доступен по REST: GET/PATCH/DELETE на узел
 *     покрывают наши сценарии (pull всех отметок, пачечная запись, ротация).
 *
 * БД проекта — Realtime Database (databaseURL из .env), НЕ Firestore.
 * Модель данных (см. AGENTS.md §8.2):
 *   users/{userId}/marks/{workId} = {
 *     updatedAt: int   — открыто (для слияния LWW на клиенте),
 *     v, iv, ct: str    — AES-GCM шифротекст отметки (см. shared/phrase.js).
 *   }
 *   users/{userId}/devices/{deviceId} = {           // v0.2.6, §8.9
 *     np: {v, iv, ct} — AES-GCM шифротекст JSON {name, platform}
 *                      (ИМЕНА И ПЛАТФОРМА НЕ ВИДНЫ в консоли — как отметки;
 *                      расшифровываются ключом от кодовой фразы);
 *     createdAt, lastSeen: int — epoch_ms (открыто: сортировка/throttle);
 *     deleted: 1 — пометка «удалено» (увидев её своё устройство, сбрасывает
 *                  локальные данные — тихий сброс §8.9; открыто — флаг
 *                  должен читаться до расшифровки).
 *   }
 * Правила БД открытые — контент зашифрован ключом от кодовой фразы
 * (для devices правила должны включать одноранговый узел — §8.2).
 *
 * Конфиг подтягивается через fetch(chrome.runtime.getURL('background/config.json'))
 * (файл генерируется из .env командой `npm run config`, в .gitignore). Если файла
 * нет или databaseURL пустой — isReady() === false, синхронизация выключена,
 * ошибок нет. ВАЖНО: динамический import() в ServiceWorkerGlobalScope запрещён
 * спецификацией HTML (w3c/ServiceWorker#1356) — используем только fetch.
 * Ключ API для RTDB REST не нужен — доступ определяют только правила БД.
 */

import { deriveKey, encryptMark, decryptMark, encryptJson, decryptJson } from '../shared/phrase.js';

/** Срок жизни томбстоунов (v0.2.1): после — удаляются локально и в БД. */
export const GC_TOMBSTONE_MS = 90 * 24 * 60 * 60 * 1000;

/** Кэш ключа: PBKDF2 (100k) дорогой — не выводим на каждый sync. */
let keyCache = { phrase: null, key: null };

/**
 * Вывод AES-ключа из фразы с кэшем (экспорт v0.2.6): SW использует его для
 * шифрования/расшифровки name+platform устройств (§8.9), не повторяя PBKDF2.
 */
export async function getKeyForPhrase(phrase) {
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

/** Тестовый хук (npm test): подменить конфиг, минуя fetch config.json. */
export function __setConfigForTest(config) {
  configPromise = Promise.resolve({ config: config || {}, ready: !!(config && config.databaseURL) });
}

/** Клиент инициализируется с пустым конфигом; реальные значения loadConfig() подставит позже. */
export function initFirebase(config = {}) {
  // Базовый URL Realtime Database без хвостового слэша
  const root = String(config.databaseURL || '').replace(/\/+$/, '');

  /** Узел отметок пользователя: {root}/users/{uid}/marks.json */
  const marksUrl = (userId) => `${root}/users/${userId}/marks.json`;

  /** Узел списка устройств пользователя: {root}/users/{uid}/devices.json */
  const devicesUrl = (userId) => `${root}/users/${userId}/devices.json`;

  /** Один узел устройства: {root}/users/{uid}/devices/{deviceId}.json */
  const deviceUrl = (userId, deviceId) => `${root}/users/${userId}/devices/${deviceId}.json`;

  /**
   * Список устройств (v0.2.6, §8.9): {deviceId: {np:{v,iv,ct}, createdAt,
   * lastSeen, deleted?}} — как в БД, БЕЗ расшифровки (расшифровка name/
   * platform — на стороне SW, см. service-worker.js; legacy-узлы со старым
   * открытым `name` приходят как есть). Пустой узел → {}. Бросает
   * httpError('devices-get') при сбое (старые правила БД без узла devices
   * → 403) — в sync такой сбой гасится, чтобы синхронизация отметок
   * продолжала работать как раньше.
   */
  async function getDevices(userId) {
    const res = await fetch(devicesUrl(userId), { method: 'GET' });
    if (!res.ok) throw httpError('devices-get', res);
    const body = await res.json();
    if (!body || typeof body !== 'object') return {};
    const out = {};
    for (const [id, val] of Object.entries(body)) {
      if (id && val && typeof val === 'object') out[id] = val;
    }
    return out;
  }

  /**
   * Запись одного устройства: PATCH ПО ПУТИ узла — RTDB мержит переданные
   * поля в существующий узел (createdAt/`deleted` не затираются частичным
   * `{np}` или `{lastSeen}`; `name: null`/`platform: null` — удаление
   * legacy-полей открытого формата). Несуществующее устройство создаётся.
   * Тело с `np` вызывающий формирует сам (encryptJson в service-worker.js).
   */
  async function putDevice(userId, deviceId, data) {
    const res = await fetch(deviceUrl(userId, deviceId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw httpError('devices-put', res);
  }

  /**
   * Удаление узла устройства (не «пометка deleted» — именно узла).
   * Используется только для самоочистки ПОСЛЕ тихого сброса (§8.9) и вайпа.
   * Идемпотентно: несуществующий узел — 200.
   */
  async function deleteDevice(userId, deviceId) {
    const res = await fetch(deviceUrl(userId, deviceId), { method: 'DELETE' });
    if (!res.ok) throw httpError('devices-delete', res);
  }

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
   * Полное удаление облачных отметок пользователя (вайп, v0.2.6):
   * DELETE узла marks целиком — тот же подузел, что и при ротации
   * (правила §8.2 дают .write только на marks). Идемпотентно: несуществующий
   * узел — 200, ошибок нет. Бросает httpError('wipe-cloud') при сбое —
   * вызывающий обязан остановиться ДО любых изменений локальных данных.
   */
  async function clearCloud(userId) {
    const res = await fetch(marksUrl(userId), { method: 'DELETE' });
    if (!res.ok) throw httpError('wipe-cloud', res);
    // Список устройств — вторичные данные: чистим best-effort, чтобы старые
    // правила БД (без узла devices, 403) не ломали вайп отметок.
    try {
      const r2 = await fetch(devicesUrl(userId), { method: 'DELETE' });
      if (!r2.ok) console.warn('[ATR] вайп: узел devices не удалён (HTTP ' + r2.status + ')');
    } catch (err) {
      console.warn('[ATR] вайп: узел devices не удалён:', err && err.message);
    }
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
   * @param {string} [deviceId] — id этого устройства (для детекта пометки
   *   «удалено», v0.2.6 §8.9; без него детект невозможен)
   * @returns {Promise<{pull: Object, pushed: number, skipped: number, gc: string[],
   *   devices: (Object|null), reset?: boolean}>}
   *   pull — облачные записи НОВЕЕ локальных (расшифрованы, готовы к слиянию),
   *   pushed — сколько локальных записей ушло в облако,
   *   skipped — сколько облачных записей не расшифровались (чужая фраза/битость),
   *   gc — workId, которые content обязан жёстко удалить локально (applyGc),
   *   devices — список устройств (null — недоступен, старые правила БД),
   *   reset — устройство удалено из списка: push/GC НЕ выполнялись,
   *   SW обязан снять фразу и локальные данные (§8.9).
   */
  async function sync(userId, phrase, localEntries, deviceId) {
    const key = await getKeyForPhrase(phrase);
    const cutoff = Date.now() - GC_TOMBSTONE_MS;
    // Отметки и устройства — параллельно, без добавочной сетевой задержки.
    // Ошибка devices не должна ломать синхронизацию: гасим → null →
    // детект флага и регистрация просто не работают (старые правила БД).
    const [remoteDocs, devices] = await Promise.all([
      pullDocs(userId),
      getDevices(userId).catch((err) => {
        console.warn('[ATR] список устройств недоступен (правила БД?):', err.message);
        return null;
      })
    ]);

    // Тихий сброс (v0.2.6, §8.9): другое устройство пометило нас как
    // удалённое (deleted: 1) — НЕ пушим и не гоняем GC, возвращаем reset.
    if (devices && deviceId && devices[deviceId] && devices[deviceId].deleted === 1) {
      return { pull: {}, pushed: 0, skipped: 0, gc: [], devices, reset: true };
    }

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

    return { pull, pushed: toPush.length, skipped, gc, devices };
  }

  /**
   * Ротация кодовой фразы (v0.2.6): переезд на новый userId с перешифровкой
   * ВСЕХ записей — без потери отметок.
   *
   * Источники слияния (LWW по t, томбстоуны m:null переносятся как есть):
   *   A) старый путь — расшифровка СТАРЫМ ключом;
   *   B) снапшот локального среза из chrome.storage (atr.sync.snapshot);
   *   C) новый путь — идемпотентность повторного запуска (новым ключом).
   *
   * Порядок записи критичен для безопасности:
   *   1) один PATCH перешифрованного на НОВЫЙ путь (атомарен в RTDB);
   *   2) только после успешного PATCH — DELETE старого узла marks целиком;
   *   3) сохранение новой фразы/service-worker делает ПОСЛЕ возврата.
   * Сбой на любом шаге = ничего не изменилось, ротацию можно повторить.
   * DELETE идёт именно на users/{uid}/marks.json (не на users/{uid}):
   *   правила БД дают write только на подузел marks (§8.2) — без их изменения.
   *
   * GC не применяется: протухшие томбстоуны переезжают со своими updatedAt,
   * разберёт обычный sync уже нового пути (§8.2а).
   *
   * @param {string} oldUserId — hex hash старой фразы (путь в БД)
   * @param {string} oldPhrase — нормализованная старая фраза (старый ключ)
   * @param {string} newUserId — hex hash новой фразы
   * @param {string} newPhrase — нормализованная новая фраза (новой ключ)
   * @param {Object} snapshotEntries — локальный срез {wid: {m, t}} из снапшота
   * @returns {Promise<{migrated: number, skipped: number}>}
   *   migrated — сколько записей переехало; skipped — не расшифровались (A)
   */
  async function rotate(oldUserId, oldPhrase, newUserId, newPhrase, snapshotEntries) {
    const oldKey = await getKeyForPhrase(oldPhrase);
    const newKey = await getKeyForPhrase(newPhrase);
    const merged = new Map(); // wid → {m, t}
    let skipped = 0;

    // A) Старый путь: расшифровка старым ключом (битая запись — счётчик, не фейл).
    for (const doc of await pullDocs(oldUserId)) {
      try {
        const mark = await decryptMark(oldKey, doc);
        merged.set(doc.workId, { m: mark, t: doc.updatedAt });
      } catch (err) {
        skipped++;
        console.warn('[ATR] ротация: запись старого пути не расшифрована:', doc.workId);
      }
    }

    // B) Снапшот локального среза: побеждает только строго более новая запись.
    for (const [wid, entry] of Object.entries(snapshotEntries || {})) {
      if (!entry || typeof entry.t !== 'number') continue;
      if (entry.m !== 'read' && entry.m !== 'skip' && entry.m !== null) continue;
      const current = merged.get(wid);
      if (!current || entry.t > current.t) merged.set(wid, { m: entry.m, t: entry.t });
    }

    // C) Новый путь (повтор запуска): чужая/битая запись не мешает —
    // наша из patch её перезапишет, если новее.
    if (oldUserId !== newUserId) {
      for (const doc of await pullDocs(newUserId)) {
        try {
          const mark = await decryptMark(newKey, doc);
          const current = merged.get(doc.workId);
          if (!current || doc.updatedAt > current.t) merged.set(doc.workId, { m: mark, t: doc.updatedAt });
        } catch (err) {
          // не расшифровалась новым ключом — пропускаем (перезапишем своей)
        }
      }
    }

    // Перешифровка новым ключом → один PATCH на новый путь (атомарен).
    const patch = {};
    for (const [wid, entry] of merged) {
      const encrypted = await encryptMark(newKey, entry.m);
      patch[wid] = { updatedAt: entry.t, ...encrypted };
    }
    if (Object.keys(patch).length) {
      const res = await fetch(marksUrl(newUserId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (!res.ok) throw httpError('rotate-push', res);
    }

    // Старый узел — ТОЛЬКО после успешного push (порядок критичен, см. докс).
    if (oldUserId !== newUserId) {
      const res = await fetch(marksUrl(oldUserId), { method: 'DELETE' });
      if (!res.ok) throw httpError('rotate-delete', res);

      // Перенос списка устройств на новый userId (v0.2.6, §8.9) — вторичные
      // данные: сбой НЕ проваливает ротацию (устройства дозапишут себя сами
      // при следующем sync — регистрация видит отсутствие записи). Старые
      // правила БД (без devices) → 403 → просто пропускаем.
      // name+platform перешифровываются: payload старого пути расшифровывается
      // СТАРЫМ ключом (legacy-узел с открытым `name` — как есть) и зашифровывается
      // НОВЫМ — иначе после смены фразы имена не читались бы новым ключом.
      // Битый payload → узел переносится без np (имя станет фолбэком).
      try {
        const oldDevices = await getDevices(oldUserId);
        const migrated = {};
        for (const [id, node] of Object.entries(oldDevices)) {
          const copy = { ...node };
          delete copy.name; // legacy-поля открытого формата в новый путь не едут
          delete copy.platform;
          if (node.np) {
            try {
              const fields = await decryptJson(oldKey, node.np);
              copy.np = await encryptJson(newKey, fields);
            } catch (err) {
              delete copy.np;
              console.warn('[ATR] ротация: устройство перенесено без имени (не расшифровалось):', id);
            }
          } else if (typeof node.name === 'string' || typeof node.platform === 'string') {
            copy.np = await encryptJson(newKey, {
              name: String(node.name || ''),
              platform: String(node.platform || '')
            });
          }
          migrated[id] = copy;
        }
        if (Object.keys(migrated).length) {
          const r2 = await fetch(devicesUrl(newUserId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(migrated)
          });
          if (!r2.ok) throw httpError('rotate-devices', r2);
          const r3 = await fetch(devicesUrl(oldUserId), { method: 'DELETE' });
          if (!r3.ok) throw httpError('rotate-devices-delete', r3);
        }
      } catch (err) {
        console.warn('[ATR] ротация: список устройств не перенесён:', err.message);
      }
    }

    return { migrated: merged.size, skipped };
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

  return { isReady, sync, pullDocs, rotate, clearCloud, getDevices, putDevice, deleteDevice };
}
