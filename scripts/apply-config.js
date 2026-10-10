/**
 * apply-config.js — читает .env и генерирует extension/background/config.js.
 *
 * Зачем: ключи Firebase должны попасть внутрь расширения (браузер не умеет
 * читать .env), при этом они НЕ должны попадать в git. Решение:
 *   .env (gitignore, вы заполняете) → npm run config → config.js (тоже gitignore)
 *
 * Запуск из корня проекта:  npm run config
 *
 * Это НЕ сборка (bundle) — просто копирование значений в ES-модуль,
 * никаких зависимостей кроме node:fs/node:path из коробки.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const OUT_PATH = path.join(ROOT, 'extension', 'background', 'config.js');

/** Разбор простого KEY=VALUE .env (комментии и пустые строки пропускаются). */
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Снимаем парные кавычки, если есть
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function main() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('[apply-config] файл .env не найден. Создайте .env (см. .env.example в документации).');
    process.exit(1);
  }
  const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));

  const config = {
    apiKey: env.FIREBASE_API_KEY || '',
    projectId: env.FIREBASE_PROJECT_ID || '',
    authDomain: env.FIREBASE_AUTH_DOMAIN || '',
    databaseURL: env.FIREBASE_DATABASE_URL || '',
    storageBucket: env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: env.FIREBASE_APP_ID || '',
    measurementId: env.FIREBASE_MEASUREMENT_ID || ''
  };

  const filled = config.apiKey && config.projectId;
  const banner =
    '/**\n' +
    ' * СГЕНЕРИРОВАНО scripts/apply-config.js из .env — НЕ РЕДАКТИРУЙТЕ ВРУЧНУЮ.\n' +
    ' * Этот файл в .gitignore и не попадает в репозиторий.\n' +
    ' * Заполните .env и выполните `npm run config`, чтобы обновить.\n' +
    ' */\n';
  const body =
    banner +
    'export const firebaseConfig = ' +
    JSON.stringify(config, null, 2) +
    ';\n\n' +
    'export const firebaseConfigReady = ' +
    (filled ? 'true' : 'false') +
    ';\n';

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, body, 'utf8');
  console.log(`[apply-config] записан ${path.relative(ROOT, OUT_PATH)}`);
  console.log(
    filled
      ? '[apply-config] конфиг заполнен (apiKey + projectId) — синхронизация доступна.'
      : '[apply-config] apiKey/projectId пустые — синхронизация будет выключена (расширение работает локально).'
  );
}

main();
