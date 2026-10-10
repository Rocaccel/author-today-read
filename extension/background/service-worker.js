/**
 * Background service worker (Manifest V3, ES-модуль).
 *
 * Назначение минимальное: расширение работает без popup и без сообщений от
 * content script — всё локально в странице. Воркер существует, потому что
 * структура ТЗ требует background, и он держит точку входа для Firebase-заглушки.
 */
import { initFirebase } from './firebase.js';

// Конфиг намеренно пустой: см. комментарий в firebase.js («как подключить»).
// Реальные ключи сюда не вписываются, пока модуль — заглушка.
const firebase = initFirebase({});

chrome.runtime.onInstalled.addListener((details) => {
  console.info(
    `[ATR] расширение установлено/обновлено (${details.reason}). ` +
      'Хранение отметок: localStorage страницы author.today, ключ atr.v1.marks. ' +
      `Firebase-заглушка готова: ${firebase.isReady() ? 'да' : 'нет (ожидаемо)'}`
  );
});
