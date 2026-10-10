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

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let generatedThisSession = false; // фразу сгенерировали здесь — требуем подтверждение
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

  // Фраза приходит из atr:status; маскируем по умолчанию (см. §8.5 AGENTS.md)
  currentPhrase = status.phrase || null;
  if (!currentPhrase) phraseVisible = false;
  renderPhrase();

  if (status.hasPhrase) {
    $('user-id').textContent = status.userId || '—';
    $('last-sync').textContent = formatTime(status.lastSync);

    let state = 'готово к работе';
    if (!status.configReady) state = 'конфиг не заполнен — только локально';
    else if (status.lastSync) state = 'синхронизировано';
    $('sync-state').textContent = state;

    const errBox = $('status-error');
    show(errBox, !!status.lastError);
    if (status.lastError) errBox.textContent = 'Ошибка: ' + status.lastError;
  }
}

/** Загрузка статуса. */
async function refresh() {
  try {
    const status = await send({ type: 'atr:status' });
    if (status && status.ok) renderStatus(status);
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
    await refresh();
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
  await refresh();
}

$('btn-generate').addEventListener('click', onGenerate);
$('btn-login').addEventListener('click', onLogin);
$('btn-show').addEventListener('click', onShowPhrase);
$('btn-copy').addEventListener('click', onCopyPhrase);
$('btn-sync').addEventListener('click', onSyncNow);
$('btn-logout').addEventListener('click', onLogout);

refresh();
