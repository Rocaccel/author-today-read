/**
 * shared/phrase.js — работа с кодовой фразой (ES-модуль).
 *
 * Используется ДВУМЯ контекстами:
 *   1) options-страница — генерация/валидация фразы, показ userId;
 *   2) background service worker — вывод ключа шифрования и userId,
 *      шифрование/дешифрование отметок перед записью в Realtime Database.
 *
 * Модель (см. AGENTS.md §8):
 *   - кодовая фраза ~15 слов — единственный «пароль» пользователя;
 *   - userId = hex(SHA-256(нормализованной фразы)) — путь в БД;
 *   - ключ = PBKDF2-SHA256(фраза, соль, 100k) → AES-GCM-256;
 *   - в облаке лежит шифротекст, поэтому правила БД могут быть
 *     открытыми — без фразы данные не прочитать.
 */

/** Количество слов в генерируемой фразе (ТЗ: «примерно 15»). */
export const PHRASE_WORDS = 15;
/** Минимум/максимум слов для ручного ввода. */
export const MIN_WORDS = 12;
export const MAX_WORDS = 30;

/**
 * Встроенный список слов (128 позиций, латиница, короткие — легко печатать).
 * 128^15 ≈ 2^105 вариантов — энтропии достаточно для «пароля».
 */
export const WORDLIST = [
  'apple', 'arrow', 'amber', 'anchor', 'ascent', 'breeze', 'bridge', 'bronze',
  'bubble', 'cabin', 'cable', 'candy', 'canyon', 'cedar', 'chalk', 'charm',
  'chest', 'cloud', 'clover', 'coral', 'crane', 'crater', 'cream', 'crust',
  'daisy', 'dawn', 'delta', 'desert', 'dragon', 'eagle', 'ember', 'fable',
  'ferry', 'fjord', 'flute', 'forest', 'garden', 'garlic', 'gecko', 'ginger',
  'glacier', 'granite', 'gravel', 'grove', 'guitar', 'harbor', 'harvest', 'hazel',
  'heron', 'honey', 'ivory', 'island', 'jungle', 'kettle', 'lagoon', 'lantern',
  'lava', 'lemon', 'lily', 'lotus', 'magnet', 'mango', 'maple', 'marble',
  'meadow', 'meteor', 'mint', 'mirror', 'monkey', 'moss', 'nickel', 'noodle',
  'novel', 'oasis', 'olive', 'opera', 'orbit', 'otter', 'palace', 'pebble',
  'pelican', 'pepper', 'piano', 'pillar', 'planet', 'plaza', 'plume', 'pollen',
  'pond', 'prairie', 'prism', 'pump', 'quarry', 'quartz', 'rabbit', 'ranch',
  'raven', 'reef', 'ridge', 'river', 'rust', 'saffron', 'sage', 'salmon',
  'sand', 'sapphire', 'satin', 'savanna', 'shark', 'signal', 'silver', 'solar',
  'spark', 'spice', 'star', 'stone', 'storm', 'sunset', 'swamp', 'swift',
  'table', 'temple', 'thunder', 'timber', 'toast', 'tulip', 'tunnel', 'violet'
];

/** Соль PBKDF2 — константа приложения (не секрет, защищает от предвычисленных таблиц). */
const PBKDF2_SALT = 'atr.sync.v1';
const PBKDF2_ITERATIONS = 100000;

const enc = new TextEncoder();

/** Нормализация: нижний регистр, обрезка, множественные пробелы → один. */
export function normalizePhrase(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Проверка фразы: количество слов в допустимом диапазоне. Возвращает null или текст ошибки. */
export function validatePhrase(input) {
  const normalized = normalizePhrase(input);
  if (!normalized) return 'Фраза пуста';
  const count = normalized.split(' ').length;
  if (count < MIN_WORDS) return `Слишком короткая фраза: ${count} слов(а), нужно от ${MIN_WORDS}`;
  if (count > MAX_WORDS) return `Слишком длинная фраза: ${count} слов, максимум ${MAX_WORDS}`;
  return null;
}

/** Генерация новой фразы: PHRASE_WORDS случайных слов через crypto.getRandomValues. */
export function generatePhrase(wordCount = PHRASE_WORDS) {
  const random = new Uint32Array(wordCount);
  crypto.getRandomValues(random);
  return Array.from(random, (n) => WORDLIST[n % WORDLIST.length]).join(' ');
}

/** userId = hex(SHA-256(нормализованной фразы)) — путь users/{userId} в БД. */
export async function deriveUserId(phrase) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(normalizePhrase(phrase)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Вывод ключа AES-GCM-256 из фразы: PBKDF2-SHA256, 100k итераций. */
export async function deriveKey(phrase) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(normalizePhrase(phrase)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(PBKDF2_SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Uint8Array → base64 (работает и в браузере, и в Node ≥16). */
function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** base64 → Uint8Array. */
function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Шифрование отметки: mark ("read" | "skip" | null) → { v, iv, ct } (base64).
 * iv — 12 случайных байт на каждую запись (требование AES-GCM).
 */
export async function encryptMark(key, mark) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify({ m: mark }));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { v: '1', iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Дешифрование { v, iv, ct } → mark ("read" | "skip" | null). Ошибка ключа — исключение. */
export async function decryptMark(key, payload) {
  const ct = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(payload.iv) },
    key,
    fromBase64(payload.ct)
  );
  const parsed = JSON.parse(new TextDecoder().decode(ct));
  return parsed && typeof parsed.m === 'object' ? null : parsed.m;
}

/**
 * Шифрование произвольного JSON-объекта (v0.2.6) — тот же конверт {v, iv, ct}
 * и та же AES-GCM-сессия, что у отметок. Используется для name/platform
 * устройств (§8.9): в консоли Firebase читается только шифротекст.
 */
export async function encryptJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { v: '1', iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Дешифрование { v, iv, ct } → объект. Неверный ключ/битые данные — исключение. */
export async function decryptJson(key, payload) {
  const ct = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(payload.iv) },
    key,
    fromBase64(payload.ct)
  );
  return JSON.parse(new TextDecoder().decode(ct));
}
