/**
 * shared/backup.js — экспорт/импорт отметок в JSON (v0.2.4).
 *
 * Используется options-страницей (карточка «Бэкап», AGENTS.md §8.5):
 *   - serializeMarks(entries) → строка JSON для файла;
 *   - parseBackup(text)       → {entries, count} либо {error} (человекочитаемо).
 *
 * Формат файла: { format: "atr.marks", version: 1, exportedAt, count, entries }.
 * entries — локальный срез {wid: {m, t}} как в localStorage (§3.1), включая
 * томбстоуны (m:null) — без них восстановление «воскресило» бы отметки.
 * Схема данных, криптография и сеть здесь НЕ живут: файл — открытый JSON
 * (бэкап локальных отметок, облако и так шифруется фразой).
 */

export const BACKUP_FORMAT = 'atr.marks';
export const BACKUP_VERSION = 1;

/** entries {wid: {m, t}} → строка JSON для скачивания. */
export function serializeMarks(entries) {
  const clean = sanitizeEntries(entries);
  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      count: Object.keys(clean).length,
      entries: clean
    },
    null,
    2
  );
}

/**
 * Текст файла → {entries, count} | {error}.
 * Отбраковывает чужой формат и записи с неверными m/t (мусор не применяем).
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (e) {
    return { error: 'Файл не является валидным JSON' };
  }
  if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT) {
    return { error: 'Неизвестный формат файла (ожидается atr.marks)' };
  }
  if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) {
    return { error: `Неподдерживаемая версия файла: ${data.version}` };
  }
  const entries = sanitizeEntries(data.entries);
  const count = Object.keys(entries).length;
  if (count === 0) return { error: 'В файле нет отметок' };
  return { entries, count };
}

/** Только валидные записи: m ∈ {read, skip, null}, t — положительное число. */
function sanitizeEntries(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [wid, entry] of Object.entries(raw)) {
    if (!/^\d+$/.test(wid)) continue;
    if (!entry || typeof entry !== 'object') continue;
    const m = entry.m;
    if (m !== 'read' && m !== 'skip' && m !== null) continue;
    const t = Number(entry.t);
    if (!Number.isFinite(t) || t <= 0) continue;
    out[wid] = { m, t };
  }
  return out;
}
