import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');

const DB_PATH = process.env.TPQ_DB || join(ROOT, 'data', 'tpq.db');

let db = null;

/** يفتح الاتصال بقاعدة البيانات وينشئ المخطط عند أول تشغيل. */
export function getDb() {
  if (db) return db;
  if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/** أعمدة أُضيفت بعد الإصدار الأول — تُضاف للقواعد القائمة دون فقدان بيانات. */
const COLUMN_MIGRATIONS = [
  ['surveys', 'target_count', 'INTEGER'],          // عدد المستهدفين وقت فتح الاستبانة
  ['surveys', 'is_open_link', 'INTEGER NOT NULL DEFAULT 0'],
  ['discipline_cases', 'followup_at', 'TEXT'],     // تاريخ جلسة المتابعة
  ['discipline_cases', 'followup_note', 'TEXT'],
  ['programs', 'is_public', 'INTEGER NOT NULL DEFAULT 1'], // الإعلان في الموقع العام
];

function migrate(handle) {
  for (const [table, column, type] of COLUMN_MIGRATIONS) {
    const cols = handle.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.length) continue;
    if (cols.some((c) => c.name === column)) continue;
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** يعيد فتح قاعدة بيانات جديدة (يُستخدم في الاختبارات). */
export function resetDbHandle() {
  if (db) { try { db.close(); } catch { /* مغلق مسبقًا */ } }
  db = null;
}

export const all = (sql, ...params) => getDb().prepare(sql).all(...params);
export const get = (sql, ...params) => getDb().prepare(sql).get(...params) ?? null;
export const run = (sql, ...params) => getDb().prepare(sql).run(...params);

/** ينفّذ دالة داخل معاملة واحدة. */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export { DB_PATH };
