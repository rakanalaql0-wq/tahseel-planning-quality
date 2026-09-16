import { get } from '../db/index.js';
import { canAccessProgram, programPerms, rolesInProgram } from '../lib/auth.js';
import { can } from '../lib/roles.js';
import { esc, fmtDate } from '../lib/util.js';
import { statusBadge, subnav } from '../views/ui.js';

export const PROGRAM_TABS = [
  ['', 'نظرة عامة'],
  ['metric', 'المقياس والدرجة'],
  ['sessions', 'اللقاءات'],
  ['students', 'الطلاب'],
  ['attendance', 'الحضور'],
  ['plan', 'الخطة والمحتوى'],
  ['teachers', 'المعلمون'],
  ['activities', 'الأنشطة'],
  ['surveys', 'الاستبانات'],
  ['impact', 'قياس الأثر'],
  ['complaints', 'الشكاوى'],
  ['discipline', 'المتابعة والانضباط'],
  ['continuity', 'الاستمرارية'],
  ['actions', 'الإجراءات'],
  ['team', 'الفريق والأدوار'],
  ['audit', 'سجل التدقيق'],
  ['close', 'إقفال البرنامج'],
];

/**
 * يحمّل البرنامج ويتحقق من صلاحية الوصول.
 * يعيد null بعد إرسال رد الخطأ المناسب.
 */
export function loadProgram(ctx, { perm = null } = {}) {
  const program = get(
    `SELECT p.*, v.name AS venue_name, v.location AS venue_location
       FROM programs p LEFT JOIN venues v ON v.id = p.venue_id WHERE p.id = ?`,
    ctx.params.id,
  );
  if (!program) { ctx.notFound('البرنامج غير موجود.'); return null; }
  if (!canAccessProgram(ctx.user, program.id)) { ctx.deny('هذا البرنامج غير مسند إليك.'); return null; }
  const perms = programPerms(ctx.user, program.id);
  if (perm && !can(perms, perm)) { ctx.deny(); return null; }
  return { program, perms, roles: rolesInProgram(ctx.user.id, program.id) };
}

/** يمنع الكتابة على برنامج مغلق. */
export function ensureOpen(ctx, program) {
  if (program.status === 'closed') {
    ctx.redirect(`/programs/${program.id}`, 'البرنامج مغلق ولا يقبل التعديل.', 'err');
    return false;
  }
  return true;
}

/** ترويسة صفحة البرنامج مع شريط التبويبات. */
export function programHead(program, active, extra = '') {
  return `<div class="crumbs"><a href="/programs">البرامج</a> ← ${esc(program.name)}</div>
  <div class="pagehead">
    <div>
      <h1>${esc(program.name)} ${statusBadge(program.status)}</h1>
      <p class="meta">${esc(program.code || '')} · ${esc(program.term || '')} ·
        ${fmtDate(program.start_date)} — ${fmtDate(program.end_date)} ·
        ${esc(program.venue_name || 'بلا قاعة')} · ${program.planned_sessions} لقاءات · ${program.planned_students} طالبًا</p>
    </div>
    <div>${extra}</div>
  </div>
  ${subnav(program.id, active, PROGRAM_TABS)}`;
}

export const yesNo = (v) => (v ? 'نعم' : 'لا');
