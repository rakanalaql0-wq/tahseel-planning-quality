import { all, run } from '../db/index.js';

/**
 * سجل التدقيق: من فعل ماذا ومتى، مع صورة قبل/بعد التعديل.
 * البند 10: «حفظ سجل تدقيق غير قابل للتلاعب لكل التعديلات الجوهرية».
 */
export function audit({ user, action, entityType, entityId, programId, before, after, ip }) {
  run(
    `INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, program_id, before_json, after_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    user?.id ?? null,
    user?.full_name ?? 'نظام',
    action,
    entityType ?? null,
    entityId ?? null,
    programId ?? null,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    ip ?? null,
  );
}

export function auditFor(entityType, entityId, limit = 50) {
  return all(
    'SELECT * FROM audit_logs WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT ?',
    entityType, entityId, limit,
  );
}

export function auditForProgram(programId, limit = 200) {
  return all(
    'SELECT * FROM audit_logs WHERE program_id = ? ORDER BY id DESC LIMIT ?',
    programId, limit,
  );
}

export function auditRecent(limit = 200) {
  return all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', limit);
}
