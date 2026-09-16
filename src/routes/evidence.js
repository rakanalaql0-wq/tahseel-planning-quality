import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { get, run } from '../db/index.js';
import { ROOT } from '../db/index.js';
import { send } from '../lib/http.js';
import { token } from '../lib/util.js';
import { audit } from '../lib/audit.js';
import { canAccessProgram } from '../lib/auth.js';

const UPLOAD_DIR = join(ROOT, 'uploads');
const MAX_FILE = 10 * 1024 * 1024; // 10MB

const ALLOWED_EXT = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.doc', '.docx',
  '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.heic',
]);

/** يستنتج البرنامج المرتبط بالكيان للتحقق من الصلاحية. */
function programOf(entityType, entityId) {
  switch (entityType) {
    case 'verification': return get('SELECT program_id FROM verifications WHERE id = ?', entityId)?.program_id;
    case 'complaint': return get('SELECT program_id FROM complaints WHERE id = ?', entityId)?.program_id;
    case 'activity': return get('SELECT program_id FROM activities WHERE id = ?', entityId)?.program_id;
    case 'corrective_action': return get('SELECT program_id FROM corrective_actions WHERE id = ?', entityId)?.program_id;
    case 'discipline_case': return get('SELECT program_id FROM discipline_cases WHERE id = ?', entityId)?.program_id;
    case 'plan': return get('SELECT program_id FROM plans WHERE program_id = ?', entityId)?.program_id ?? Number(entityId);
    case 'teacher': return null; // المعلم مشترك بين البرامج — يكفي أن يكون المستخدم مسندًا لأي برنامج
    default: return null;
  }
}

const ENTITY_TYPES = new Set([
  'verification', 'complaint', 'activity', 'teacher', 'plan', 'corrective_action', 'discipline_case',
]);

export default function register(router) {
  router.post('/evidence', async (ctx) => {
    const entityType = String(ctx.body.entity_type || '');
    const entityId = Number(ctx.body.entity_id || 0);
    const back = String(ctx.body.back || '/');
    if (!ENTITY_TYPES.has(entityType) || !entityId) return ctx.deny('نوع الشاهد غير مدعوم.');

    const programId = programOf(entityType, entityId);
    if (programId && !canAccessProgram(ctx.user, programId)) return ctx.deny();

    const title = String(ctx.body.title || '').trim() || null;
    const url = String(ctx.body.url || '').trim();
    const file = ctx.files.find((f) => f.field === 'file' && f.data?.length);

    if (!url && !file) {
      return ctx.redirect(back.startsWith('/') ? back : '/', 'أرفق ملفًا أو أدخل رابطًا.', 'err');
    }

    if (url) {
      if (!/^https?:\/\//i.test(url)) {
        return ctx.redirect(back.startsWith('/') ? back : '/', 'الرابط يجب أن يبدأ بـ http أو https.', 'err');
      }
      run(`INSERT INTO evidences (entity_type, entity_id, kind, title, url, uploaded_by)
           VALUES (?, ?, 'link', ?, ?, ?)`, entityType, entityId, title || url, url, ctx.user.id);
    }

    if (file) {
      const ext = extname(file.filename).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        return ctx.redirect(back.startsWith('/') ? back : '/', `نوع الملف ${ext || ''} غير مسموح.`, 'err');
      }
      if (file.data.length > MAX_FILE) {
        return ctx.redirect(back.startsWith('/') ? back : '/', 'حجم الملف يتجاوز 10 ميجابايت.', 'err');
      }
      await mkdir(UPLOAD_DIR, { recursive: true });
      const stored = `${Date.now()}-${token(6)}${ext}`;
      await writeFile(join(UPLOAD_DIR, stored), file.data);
      run(`INSERT INTO evidences (entity_type, entity_id, kind, title, file_name, file_path, mime_type, size_bytes, uploaded_by)
           VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?)`,
        entityType, entityId, title || basename(file.filename), basename(file.filename), stored,
        file.mimeType, file.data.length, ctx.user.id);
    }

    audit({
      user: ctx.user, action: 'evidence.add', entityType, entityId, programId: programId || null,
      after: { title, hasFile: Boolean(file), hasUrl: Boolean(url) }, ip: ctx.ip,
    });
    ctx.redirect(back.startsWith('/') ? back : '/', 'أُضيف الشاهد.');
  });

  router.get('/evidence/:eid/download', async (ctx) => {
    const e = get('SELECT * FROM evidences WHERE id = ?', ctx.params.eid);
    if (!e || e.kind !== 'file') return ctx.notFound();
    const programId = programOf(e.entity_type, e.entity_id);
    if (programId && !canAccessProgram(ctx.user, programId)) return ctx.deny();
    try {
      const data = await readFile(join(UPLOAD_DIR, basename(e.file_path)));
      send(ctx.res, 200, data, {
        'Content-Type': e.mime_type || 'application/octet-stream',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(e.file_name || 'evidence')}`,
      });
    } catch {
      ctx.notFound('الملف غير متاح على الخادم.');
    }
  });
}
