/**
 * options.js — логика страницы настроек (ES-модуль options-страницы).
 *
 * Три состояния:
 *   1) нет конфига Firebase (configReady=false) — предупреждение;
 *   2) нет фразы — генерация/ввод фразы (shared/phrase.js);
 *   3) есть фраза — статус, ручная синхронизация, выход.
 *
 * Все данные приходят из background через chrome.runtime.sendMessage
 * (протокол — в background/service-worker.js).
 */
import { generatePhrase, validatePhrase, normalizePhrase } from '../shared/phrase.js';
import { serializeMarks, parseBackup } from '../shared/backup.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

// Бэкап (v0.2.4): снапшот среза кэширует background из atr:sync:sync
// (только content-вкладки), отложенный импорт — пишем сами, применяет
// content на author.today (см. AGENTS.md §8.5).
const SNAPSHOT_KEY = 'atr.sync.snapshot';
const PENDING_IMPORT_KEY = 'atr.sync.pendingImport';

let generatedThisSession = false; // фразу сгенерировали здесь — требуем подтверждение
let rotateGenerated = false; // то же для формы ротации (v0.2.6)
let currentPhrase = null; // фраза из atr:status (для показа/копирования)
let phraseVisible = false; // раскрыли фразу кнопкой «Показать»
const PHRASE_MASK = '•••• •••• •••• •••• ••••';

/** Показать/скрыть блок. */
function show(el, visible) {
  el.classList.toggle('hidden', !visible);
}

/** Формат ISO-времени для человека. */
function formatTime(iso) {
  if (!iso) return 'никогда';
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch (_) {
    return iso;
  }
}

/**
 * Свежесть статистики (v0.2.6): сегодня — «HH:MM», иной день — «ДД.ММ HH:MM»
 * (вчерашнее «14:30» не должно выглядеть свежим).
 */
function formatStatTime(iso) {
  try {
    const d = new Date(iso);
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return hm;
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
  } catch (_) {
    return iso;
  }
}

/** Отрисовка блока показа фразы: маска или текст + состояние кнопок. */
function renderPhrase() {
  const box = $('phrase-text');
  box.textContent = currentPhrase ? (phraseVisible ? currentPhrase : PHRASE_MASK) : '—';
  box.classList.toggle('masked', !!currentPhrase && !phraseVisible);
  $('btn-show').textContent = phraseVisible ? 'Скрыть' : 'Показать';
  $('btn-show').disabled = !currentPhrase;
  $('btn-copy').disabled = !currentPhrase;
}

/** Полный рендер по статусу из background. */
function renderStatus(status) {
  show($('config-warning'), !status.configReady);
  show($('login-block'), status.configReady && !status.hasPhrase);
  show($('status-block'), status.hasPhrase);
  // Карточка «Устройства» (v0.2.6, §8.9): только при фразе И конфиге —
  // список читается из облака, без конфига туда ходить нечего.
  show($('devices-block'), !!(status.hasPhrase && status.configReady));
  renderStats(status.stats);

  // Фраза приходит из atr:status; маскируем по умолчанию (см. §8.5 AGENTS.md)
  currentPhrase = status.phrase || null;
  if (!currentPhrase) phraseVisible = false;
  renderPhrase();

  if (status.hasPhrase) {
    $('user-id').textContent = status.userId || '—';
    $('last-sync').textContent = formatTime(status.lastSync);
    // Ротация (v0.2.6) возможна только при настроенном конфиге — без него
    // старый путь в облаке недоступен и удалять нечего.
    show($('btn-rotate'), !!status.configReady);

    let state = 'готово к работе';
    if (!status.configReady) state = 'конфиг не заполнен — только локально';
    else if (status.lastSync) {
      const read = status.stats?.read || 0;
      const skip = status.stats?.skip || 0;
      state = `синхронизировано ${read}✅ + ${skip}❌`;
    }
    $('sync-state').textContent = state;

    const errBox = $('status-error');
    show(errBox, !!status.lastError);
    if (status.lastError) errBox.textContent = 'Ошибка: ' + status.lastError;
  }
}

/** Счётчики (v0.2.2): блок виден всегда, даже без фразы и конфига. */
function renderStats(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  $('stat-read').textContent = String(Number(s.read) || 0);
  $('stat-skip').textContent = String(Number(s.skip) || 0);
  $('stat-total').textContent = String(Number(s.total) || 0);
  // Свежесть (v0.2.6): строка из stats.at — когда content в последний раз
  // присылал срез; без единого визита на author.today — скрыта.
  const atEl = $('stat-at');
  if (s.at) {
    atEl.textContent = 'Данные на ' + formatStatTime(s.at);
    show(atEl, true);
  } else {
    show(atEl, false);
  }
}

/** Статус блока «Бэкап»: сколько отметок готово к экспорту и на когда. */
async function renderBackupStatus() {
  const el = $('backup-status');
  try {
    const data = await chrome.storage.local.get(SNAPSHOT_KEY);
    const snap = data && data[SNAPSHOT_KEY];
    const n = snap && snap.entries ? Object.keys(snap.entries).length : 0;
    el.textContent = n
      ? `Готово к экспорту: ${n} отметок (данные на ${formatTime(snap.at)}).`
      : 'Нет данных для экспорта — отметьте книги на author.today.';
  } catch (err) {
    el.textContent = 'Статус бэкапа недоступен.';
  }
}

/** Экспорт: снапшот → JSON-файл (скачивание, Blob — работает в options). */
async function onExport() {
  const el = $('backup-status');
  try {
    const data = await chrome.storage.local.get(SNAPSHOT_KEY);
    const snap = data && data[SNAPSHOT_KEY];
    if (!snap || !snap.entries || Object.keys(snap.entries).length === 0) {
      el.textContent = 'Нет данных для экспорта — отметьте книги на author.today.';
      return;
    }
    const json = serializeMarks(snap.entries);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `author-today-marks-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    el.textContent = `Выгружено отметок: ${Object.keys(snap.entries).length}.`;
  } catch (err) {
    el.textContent = 'Экспорт не удался: ' + String(err && err.message ? err.message : err);
  }
}

/** Выбор файла → валидация → отложенный импорт (применит content). */
async function onImportFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = ''; // разрешить выбрать тот же файл повторно
  if (!file) return;
  const el = $('backup-status');
  try {
    const res = parseBackup(await file.text());
    if (res.error) {
      el.textContent = 'Импорт: ' + res.error;
      return;
    }
    await chrome.storage.local.set({ [PENDING_IMPORT_KEY]: res.entries });
    el.textContent =
      `Импортировано ${res.count} отметок. Применение — на открытой вкладке ` +
      'author.today или при следующем открытии сайта.';
    show($('btn-open-site'), true);
  } catch (err) {
    el.textContent = 'Импорт не удался: ' + String(err && err.message ? err.message : err);
  }
}

/** Загрузка статуса (+ список устройств, если карточка видима, §8.9). */
async function refresh(opts = {}) {
  try {
    const status = await send({ type: 'atr:status' });
    if (status && status.ok) {
      renderStatus(status);
      if (status.hasPhrase && status.configReady) {
        await loadDevices(opts.focusOwn);
      } else {
        show($('devices-error'), false);
        devicesFocusOwn = false; // фразы нет — автофокус неактуален
      }
    }
  } catch (err) {
    console.error('[ATR options] статус недоступен:', err);
  }
}

/** Создать фразу: вписываем в поле, включаем обязательное подтверждение. */
function onGenerate() {
  $('phrase-input').value = generatePhrase();
  generatedThisSession = true;
  show($('confirm-label'), true);
  $('confirm-check').checked = false;
  show($('login-error'), false);
}

/** Войти / сохранить фразу. */
async function onLogin() {
  const errorBox = $('login-error');
  const phrase = normalizePhrase($('phrase-input').value);

  const error = validatePhrase(phrase);
  if (error) {
    errorBox.textContent = error;
    show(errorBox, true);
    return;
  }
  if (generatedThisSession && !$('confirm-check').checked) {
    errorBox.textContent = 'Сначала подтвердите, что фраза сохранена';
    show(errorBox, true);
    return;
  }

  try {
    const res = await send({ type: 'atr:phrase:set', phrase });
    if (!res.ok) {
      errorBox.textContent = res.error || 'Не удалось сохранить фразу';
      show(errorBox, true);
      return;
    }
    generatedThisSession = false;
    $('phrase-input').value = '';
    show($('confirm-label'), false);
    show($('wipe-done'), false); // новый вход — итог вайпа неактуален
    await refresh();
    // Регистрация устройства (v0.2.6, §8.9): первый sync от этой фразы —
    // иначе своё устройство в списке не появится до визита на author.today.
    try {
      await send({ type: 'atr:sync:sync', entries: {} });
    } catch (_) {
      /* сети нет — устройство зарегистрируется при следующем посещении сайта */
    }
    // Автофокус переименования: имя устройству задаётся при первом входе.
    await loadDevices(true);
  } catch (err) {
    errorBox.textContent = String(err && err.message ? err.message : err);
    show(errorBox, true);
  }
}

/** Ручная синхронизация (pull облака; контент-вкладки дошлют своё сами). */
async function onSyncNow() {
  const btn = $('btn-sync');
  btn.disabled = true;
  btn.textContent = 'Синхронизация…';
  try {
    const res = await send({ type: 'atr:sync:sync', entries: {} });
    if (res && res.ok) {
      $('sync-state').textContent =
        `выполнено (в облако: ${res.pushed}, из облака: ${Object.keys(res.pull || {}).length})`;
    }
  } catch (err) {
    console.error('[ATR options] sync:', err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Синхронизировать сейчас';
    await refresh();
  }
}

/** Показать/скрыть фразу текстом (маска по умолчанию). */
function onShowPhrase() {
  if (!currentPhrase) return;
  phraseVisible = !phraseVisible;
  renderPhrase();
}

/** Скопировать фразу в буфер обмена (extension-origin → clipboard API). */
async function onCopyPhrase() {
  if (!currentPhrase) return;
  const btn = $('btn-copy');
  try {
    await navigator.clipboard.writeText(currentPhrase);
    btn.textContent = 'Скопировано';
  } catch (_) {
    btn.textContent = 'Ошибка копирования';
  }
  setTimeout(() => {
    btn.textContent = 'Копировать';
  }, 1500);
}

/** Выход: фраза удаляется с устройства. */
async function onLogout() {
  await send({ type: 'atr:phrase:clear' });
  generatedThisSession = false;
  devicesFocusOwn = false; // автофокус своей строки без фразы не нужен
  showRotateForm(false); // форма ротации без фразы неактуальна
  await refresh();
}

// --- Ротация фразы (v0.2.6): форма «Сменить фразу» -------------------------

/** Открыть/закрыть форму ротации; закрытие сбрасывает поля и подтверждение. */
function showRotateForm(open) {
  show($('rotate-form'), open);
  if (open) {
    show($('rotate-error'), false);
    show($('rotate-done'), false); // прошлый успех скрываем при новом входе
    return;
  }
  $('rotate-input').value = '';
  rotateGenerated = false;
  $('rotate-confirm-check').checked = false;
  show($('rotate-confirm-label'), false);
  show($('rotate-error'), false);
}

/** Сгенерировать новую фразу в форме ротации (обязателен чекбокс). */
function onRotateGenerate() {
  $('rotate-input').value = generatePhrase();
  rotateGenerated = true;
  show($('rotate-confirm-label'), true);
  $('rotate-confirm-check').checked = false;
  show($('rotate-error'), false);
}

/** Ротация: валидация → atr:phrase:rotate → статус. Ошибки инлайн. */
async function onRotateDo() {
  const errorBox = $('rotate-error');
  const phrase = normalizePhrase($('rotate-input').value);

  const error = validatePhrase(phrase);
  if (error) {
    errorBox.textContent = error;
    show(errorBox, true);
    return;
  }
  if (rotateGenerated && !$('rotate-confirm-check').checked) {
    errorBox.textContent = 'Сначала подтвердите, что новая фраза сохранена';
    show(errorBox, true);
    return;
  }

  const btn = $('btn-rotate-do');
  btn.disabled = true;
  btn.textContent = 'Смена фразы…';
  try {
    const res = await send({ type: 'atr:phrase:rotate', phrase });
    if (!res || !res.ok) {
      errorBox.textContent = (res && res.error) || 'Не удалось сменить фразу';
      show(errorBox, true);
      return;
    }
    showRotateForm(false); // включая сброс полей/подтверждения
    await refresh(); // новый userId в статусе
    show($('wipe-done'), false); // ротация успешна — итог вайпа неактуален
    show($('rotate-done'), true);
  } catch (err) {
    errorBox.textContent = String(err && err.message ? err.message : err);
    show(errorBox, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сменить и войти';
  }
}

// --- Полный вайп (v0.2.6): «Удалить все данные» -----------------------------

/** Текст итога: зависит от того, было ли доступно облако. */
function wipeDoneText(res) {
  if (res.cloudDeleted) {
    return (
      'Все данные удалены: облачные отметки, отметки этого браузера, кодовая ' +
      'фраза и статусы. На других устройствах с этой фразой сделайте то же ' +
      'самое — иначе их отметки при следующей синхронизации снова уйдут в облако.'
    );
  }
  if (res.reason === 'no-config') {
    return 'Локальные данные и статусы удалены. Облако не тронуто: синхронизация не настроена (нет конфига) — доступа к нему нет.';
  }
  if (res.reason === 'no-phrase') {
    return 'Локальные данные и статусы удалены. Облако не тронуто: кодовая фраза неизвестна — без неё к нему нет доступа.';
  }
  return 'Данные удалены.';
}

/** Открыть/закрыть форму вайпа; открытие сбрасывает чекбокс и ошибки. */
function showWipeForm(open) {
  show($('wipe-form'), open);
  $('wipe-confirm-check').checked = false;
  show($('wipe-error'), false);
  if (open) show($('wipe-done'), false);
}

/** Полный вайп: чекбокс-гейт → atr:data:wipe → итог + обновление UI. */
async function onWipeDo() {
  const errorBox = $('wipe-error');
  if (!$('wipe-confirm-check').checked) {
    errorBox.textContent = 'Сначала подтвердите, что понимаете: данные удаляются безвозвратно';
    show(errorBox, true);
    return;
  }
  const btn = $('btn-wipe-do');
  btn.disabled = true;
  btn.textContent = 'Удаляем…';
  try {
    const res = await send({ type: 'atr:data:wipe' });
    if (!res || !res.ok) {
      errorBox.textContent = (res && res.error) || 'Не удалось удалить данные';
      show(errorBox, true);
      return;
    }
    // Успех: форма закрыта, состояние фразы сброшено, всё перечитано.
    showWipeForm(false);
    currentPhrase = null;
    phraseVisible = false;
    generatedThisSession = false;
    rotateGenerated = false;
    showRotateForm(false);
    await refresh(); // фразы нет → login-block; статусы и статистика нулевые
    await renderBackupStatus(); // снапшот удалён → «Нет данных для экспорта»
    $('wipe-done-text').textContent = wipeDoneText(res);
    show($('wipe-done'), true);
  } catch (err) {
    errorBox.textContent = String(err && err.message ? err.message : err);
    show(errorBox, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Удалить всё безвозвратно';
  }
}

// --- Устройства (v0.2.6, §8.9): список, переименование, удаление ------------

let ownDeviceId = null; // deviceId этого браузера (at­r:devices:list → ownId)
let devicesFocusOwn = false; // автофокус своей строки после первого входа

/** Последняя активность/регистрация устройства — человекочитаемо. */
function formatDeviceMeta(d) {
  if (d.lastSeen) return 'Активно: ' + formatStatTime(new Date(d.lastSeen).toISOString());
  if (d.createdAt) return 'Добавлено: ' + formatStatTime(new Date(d.createdAt).toISOString());
  return '';
}

/**
 * Загрузка списка (atr:devices:list → SW → облако). focusOwn — открыть
 * inline-переименование СВОЕЙ строки, когда она появится (имя задаётся
 * при первом входе; флаг потребляется только при показе — устройство
 * может зарегистрироваться позже, после визита на author.today).
 */
async function loadDevices(focusOwn) {
  if (focusOwn) devicesFocusOwn = true;
  const listEl = $('devices-list');
  const errorBox = $('devices-error');
  listEl.textContent = 'Загрузка…';
  show(errorBox, false);
  let res;
  try {
    res = await send({ type: 'atr:devices:list' });
  } catch (err) {
    res = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  // Тихий сброс (§8.9): SW уже удалил фразу/статусы — UI в состояние
  // «как после установки», плашка в #wipe-block (карточка он виден всегда).
  if (res && res.reset) {
    await applyRemoteResetNotice();
    return;
  }
  if (!res || !res.ok) {
    listEl.textContent = '';
    errorBox.textContent = (res && res.error) || 'Список устройств недоступен';
    show(errorBox, true);
    return;
  }
  ownDeviceId = res.ownId || null;
  renderDevices(res.devices || []);
}

/** Плашка после тихого сброса: состояние фразы сброшено, итог виден. */
async function applyRemoteResetNotice() {
  currentPhrase = null;
  phraseVisible = false;
  generatedThisSession = false;
  rotateGenerated = false;
  devicesFocusOwn = false;
  showRotateForm(false);
  showWipeForm(false);
  await refresh(); // фразы нет → login-block, карточка «Устройства» скрыта
  await renderBackupStatus(); // снапшот удалён → «Нет данных для экспорта»
  $('wipe-done-text').textContent =
    'Это устройство удалено из списка другим устройством: кодовая фраза и ' +
    'локальные отметки на нём удалены (как после установки). Облачные ' +
    'отметки не тронуты.';
  show($('wipe-done'), true);
}

/** Отрисовка строк списка; автофокус своей строки — после первого входа. */
function renderDevices(devices) {
  const listEl = $('devices-list');
  listEl.textContent = '';
  if (!devices.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent =
      'Пока пусто: своё устройство появится здесь после первого ' +
      'посещения author.today с этой фразой.';
    listEl.appendChild(p);
    return; // devicesFocusOwn сохраняется — дождёмся регистрации устройства
  }
  const rows = new Map();
  for (const d of devices) {
    const row = buildDeviceRow(d);
    rows.set(d.id, row);
    listEl.appendChild(row);
  }
  if (devicesFocusOwn && ownDeviceId && rows.has(ownDeviceId)) {
    devicesFocusOwn = false;
    startRename(rows.get(ownDeviceId), devices.find((d) => d.id === ownDeviceId));
  }
}

/** Строка списка: имя (+бейдж «Это устройство»), мета, кнопки действий. */
function buildDeviceRow(device) {
  const row = document.createElement('div');
  row.className = 'device-row';
  row.dataset.id = device.id;

  const info = document.createElement('div');
  info.className = 'device-info';
  const title = document.createElement('div');
  title.className = 'device-title';
  const nameEl = document.createElement('span');
  nameEl.className = 'device-name';
  nameEl.textContent = device.name;
  title.appendChild(nameEl);
  if (device.id === ownDeviceId) {
    const badge = document.createElement('span');
    badge.className = 'device-badge';
    badge.textContent = 'Это устройство';
    title.appendChild(badge);
  }
  info.appendChild(title);
  const meta = document.createElement('span');
  meta.className = 'device-meta muted';
  meta.textContent = formatDeviceMeta(device);
  if (meta.textContent) info.appendChild(meta);
  row.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'device-actions';
  fillDeviceActions(actions, row, device);
  row.appendChild(actions);
  return row;
}

/**
 * Кнопки строки: «Переименовать» всегда; «Удалить» — ТОЛЬКО для чужого
 * устройства (своё удалить нельзя — решение пользователя, §8.9).
 */
function fillDeviceActions(actions, row, device) {
  actions.textContent = '';
  const btnRename = document.createElement('button');
  btnRename.type = 'button';
  btnRename.textContent = 'Переименовать';
  btnRename.addEventListener('click', () => startRename(row, device));
  actions.appendChild(btnRename);
  if (device.id !== ownDeviceId) {
    const btnRemove = document.createElement('button');
    btnRemove.type = 'button';
    btnRemove.className = 'danger';
    btnRemove.textContent = 'Удалить';
    btnRemove.addEventListener('click', () => removeDevice(device, btnRemove, actions, row));
    actions.appendChild(btnRemove);
  }
}

/** Inline-переименование: input вместо кнопок, Enter/«Сохранить» → SW. */
function startRename(row, device) {
  const actions = row.querySelector('.device-actions');
  if (!actions || actions.dataset.renaming === '1') return;
  actions.dataset.renaming = '1';
  actions.textContent = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 40;
  input.className = 'device-rename-input';
  input.value = device.name;

  const btnOk = document.createElement('button');
  btnOk.type = 'button';
  btnOk.className = 'primary';
  btnOk.textContent = 'Сохранить';
  const btnCancel = document.createElement('button');
  btnCancel.type = 'button';
  btnCancel.textContent = 'Отмена';
  const err = document.createElement('p');
  err.className = 'error hidden';

  const cancel = () => {
    delete actions.dataset.renaming;
    fillDeviceActions(actions, row, device);
  };
  const save = async () => {
    const name = input.value.trim().replace(/\s+/g, ' ');
    if (!name) {
      err.textContent = 'Имя устройства не может быть пустым';
      show(err, true);
      return;
    }
    btnOk.disabled = true;
    btnCancel.disabled = true;
    try {
      const res = await send({ type: 'atr:devices:rename', deviceId: device.id, name });
      if (!res || !res.ok) {
        err.textContent = (res && res.error) || 'Не удалось переименовать устройство';
        show(err, true);
        btnOk.disabled = false;
        btnCancel.disabled = false;
        return;
      }
      await loadDevices(false); // свежий список с новым именем
    } catch (e) {
      err.textContent = String(e && e.message ? e.message : e);
      show(err, true);
      btnOk.disabled = false;
      btnCancel.disabled = false;
    }
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      save();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  });
  btnOk.addEventListener('click', save);
  btnCancel.addEventListener('click', cancel);

  actions.append(input, btnOk, btnCancel, err);
  input.focus();
  input.select();
}

/** Удаление чужого устройства: два шага («Удалить» → «Удалить — точно?»). */
async function removeDevice(device, btn, actions, row) {
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Удалить — точно?';
    // Подтверждение само сбрасывается через 5 с, чтобы кнопка не «залипла».
    setTimeout(() => {
      if (btn.dataset.confirm === '1' && document.contains(btn)) {
        btn.dataset.confirm = '0';
        btn.textContent = 'Удалить';
      }
    }, 5000);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Удаляем…';
  const fail = (message) => {
    const errorBox = $('devices-error');
    errorBox.textContent = message;
    show(errorBox, true);
    fillDeviceActions(actions, row, device); // кнопки заново, confirm сброшен
  };
  try {
    const res = await send({ type: 'atr:devices:remove', deviceId: device.id });
    if (!res || !res.ok) {
      fail((res && res.error) || 'Не удалось удалить устройство');
      return;
    }
    await loadDevices(false); // список без удалённого устройства
  } catch (e) {
    fail(String(e && e.message ? e.message : e));
  }
}

$('btn-generate').addEventListener('click', onGenerate);
$('btn-login').addEventListener('click', onLogin);
$('btn-show').addEventListener('click', onShowPhrase);
$('btn-copy').addEventListener('click', onCopyPhrase);
$('btn-sync').addEventListener('click', onSyncNow);
$('btn-logout').addEventListener('click', onLogout);
$('btn-rotate').addEventListener('click', () => showRotateForm(true));
$('btn-rotate-generate').addEventListener('click', onRotateGenerate);
$('btn-rotate-do').addEventListener('click', onRotateDo);
$('btn-rotate-cancel').addEventListener('click', () => showRotateForm(false));
$('btn-wipe').addEventListener('click', () => showWipeForm(true));
$('btn-wipe-do').addEventListener('click', onWipeDo);
$('btn-wipe-cancel').addEventListener('click', () => showWipeForm(false));
$('btn-wipe-open-site').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://author.today/' });
});
$('btn-export').addEventListener('click', onExport);
$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', onImportFile);
$('btn-open-site').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://author.today/' });
});

refresh();
renderBackupStatus();
