import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { all, get, run } from '../db/index.js';
import { token } from './util.js';
import { permsFor } from './roles.js';

const SESSION_DAYS = 7;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  try {
    const candidate = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function findUserByUsername(username) {
  return get('SELECT * FROM users WHERE lower(username) = lower(?)', String(username || '').trim());
}

/** ينشئ جلسة دخول ويعيد رمزها. */
export function createSession(userId, userAgent = '') {
  const t = token(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  run(
    'INSERT INTO auth_sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)',
    t, userId, expires, String(userAgent).slice(0, 200),
  );
  run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", userId);
  return t;
}

export function destroySession(t) {
  if (t) run('DELETE FROM auth_sessions WHERE token = ?', t);
}

/** يعيد المستخدم المرتبط برمز الجلسة، أو null إذا انتهت أو أُلغيت. */
export function userFromToken(t) {
  if (!t) return null;
  const row = get(
    `SELECT u.* FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now') AND u.is_active = 1`,
    t,
  );
  return row || null;
}

export function cleanupSessions() {
  run("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')");
}

/** أدوار المستخدم داخل برنامج معيّن. */
export function rolesInProgram(userId, programId) {
  return all(
    'SELECT role FROM program_assignments WHERE user_id = ? AND program_id = ?',
    userId, programId,
  ).map((r) => r.role);
}

/** كل البرامج المسندة للمستخدم (أو كلها لمدير النظام/مدير الجودة). */
export function programsForUser(user) {
  if (!user) return [];
  if (user.global_role === 'admin' || user.global_role === 'quality_manager') {
    return all(`SELECT p.*, v.name AS venue_name FROM programs p
                LEFT JOIN venues v ON v.id = p.venue_id
                ORDER BY p.status = 'closed', p.start_date DESC, p.id DESC`);
  }
  return all(
    `SELECT DISTINCT p.*, v.name AS venue_name FROM programs p
       JOIN program_assignments a ON a.program_id = p.id AND a.user_id = ?
       LEFT JOIN venues v ON v.id = p.venue_id
      ORDER BY p.status = 'closed', p.start_date DESC, p.id DESC`,
    user.id,
  );
}

export function canAccessProgram(user, programId) {
  if (!user) return false;
  if (user.global_role === 'admin' || user.global_role === 'quality_manager') return true;
  return Boolean(get(
    'SELECT 1 FROM program_assignments WHERE user_id = ? AND program_id = ? LIMIT 1',
    user.id, programId,
  ));
}

/** مجموعة صلاحيات المستخدم داخل برنامج. */
export function programPerms(user, programId) {
  return permsFor(user, rolesInProgram(user.id, programId));
}
