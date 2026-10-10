/**
 * ЗАГЛУШКА модуля Firebase (ES-модуль background-сервис-воркера).
 *
 * Контекст: исходное ТЗ просило «модуль работы с Firebase» в структуре файлов,
 * но требование хранения гласит «только локально в local storage».
 * Разрешение противоречия: модуль существует как точка расширения,
 * но СЕЙЧАС ничего не делает — данные хранятся исключительно в localStorage
 * страницы (см. content/storage.js). Реальные вызовы синхронизации сюда
 * НЕ подключены и подключаться не будут без отдельного запроса пользователя.
 *
 * Как подключить Firebase в будущем (план, не реализовывать сейчас):
 *   1) npm-сборка не нужна — подключить compat-бандлы (как делает сам сайт:
 *      firebase-app-compat + firebase-messaging-compat) или модульный CDN;
 *   2) заполнить config ниже (apiKey, projectId и т.д. из консоли Firebase);
 *   3) реализовать pushMarks/pullMarks и вызывать их из content-скрипта
 *      через chrome.runtime.sendMessage + этот модуль;
 *   4) при этом хранение в localStorage остаётся первичным кэшем (офлайн),
 *      иначе нарушится требование «только локально».
 */

/**
 * Инициализация Firebase-клиента.
 * @param {object} config — конфигурация Firebase (apiKey, authDomain, ...).
 * @returns {{isReady: () => boolean}} объект-заглушка.
 */
export function initFirebase(config = {}) {
  // Никаких сетевых вызовов: только лог намерения.
  console.info(
    '[ATR] Firebase-модуль: заглушка активна, подключение не выполняется. config keys:',
    Object.keys(config)
  );
  return {
    // В реальной реализации здесь будет проверка инициализированного app.
    isReady: () => false
  };
}

/**
 * Отправка отметок в облако — намеренный no-op.
 * @param {object} marks — объект вида {workId: "read"|"skip"}.
 */
export function pushMarks(marks) {
  console.debug('[ATR] Firebase pushMarks — заглушка, записей в облако не будет:', marks);
}

/**
 * Получение отметок из облака — намеренный no-op.
 * @returns {null} null означает «удалённых данных нет».
 */
export function pullMarks() {
  return null;
}
