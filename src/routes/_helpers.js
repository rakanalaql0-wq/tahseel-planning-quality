import { get } from '../db/index.js';
import { canAccessProgram, programPerms, rolesInProgram } from '../lib/auth.js';
import { can } from '../lib/roles.js';
import { esc, fmtDate } from '../lib/util.js';
import { statusBadge } from '../views/ui.js';
import { icon } from '../views/icons.js';

/**
 * تبويبات البرنامج.
 * لكل تبويب الصلاحية اللازمة لرؤيته — فلا يُعرض للمستخدم ما لا يملك صلاحيته.
 * `perm: null` يعني متاح لكل من أُسند إليه البرنامج.
 * `anyPerm` يعني يكفي امتلاك واحدة من الصلاحيات.
 */
export const TAB_GROUPS = [
  { id: 'main', label: '' },
  { id: 'ops', label: 'التشغيل' },
  { id: 'measure', label: 'القياس' },
  { id: 'follow', label: 'المتابعة' },
  { id: 'admin', label: 'الإدارة' },
];

export const PROGRAM_TABS = [
  { key: '', label: 'نظرة عامة', ico: 'home', perm: null, group: 'main' },
  { key: 'metric', label: 'المقياس والدرجة', ico: 'metric', perm: null, group: 'main' },
  { key: 'sessions', group: 'ops', label: 'اللقاءات', ico: 'sessions', perm: 'session.manage' },
  { key: 'students', group: 'ops', label: 'الطلاب', ico: 'students', perm: 'student.manage' },
  { key: 'attendance', group: 'ops', label: 'الحضور', ico: 'attendance', perm: 'attendance.manage' },
  { key: 'plan', group: 'ops', label: 'الخطة والمحتوى', ico: 'plan', perm: 'plan.review' },
  { key: 'teachers', group: 'ops', label: 'المعلمون', ico: 'teacher', perm: 'teacher.verify' },
  { key: 'activities', group: 'ops', label: 'الأنشطة', ico: 'activity', perm: 'activity.manage' },
  {
    key: 'surveys', group: 'measure',
    label: 'الاستبانات',
    ico: 'survey',
    anyPerm: ['survey.manage.teacher', 'survey.manage.experience', 'survey.analyze'],
  },
  { key: 'impact', group: 'measure', label: 'قياس الأثر', ico: 'impact', perm: 'impact.manage' },
  {
    key: 'complaints', group: 'follow',
    label: 'الشكاوى',
    ico: 'complaint',
    anyPerm: ['complaint.manage', 'complaint.verify'],
  },
  { key: 'discipline', group: 'follow', label: 'المتابعة والانضباط', ico: 'discipline', perm: 'discipline.manage' },
  { key: 'continuity', group: 'follow', label: 'الاستمرارية', ico: 'continuity', perm: 'continuity.manage' },
  { key: 'actions', group: 'follow', label: 'الإجراءات', ico: 'actions', perm: 'action.manage' },
  { key: 'team', group: 'admin', label: 'الفريق والأدوار', ico: 'team', perm: null },
  { key: 'audit', group: 'admin', label: 'سجل التدقيق', ico: 'audit', perm: 'audit.read' },
  { key: 'close', group: 'admin', label: 'إقفال البرنامج', ico: 'closeProgram', perm: 'program.close' },
];

/** التبويبات التي يملك المستخدم صلاحية رؤيتها. */
export function visibleTabs(perms) {
  return PROGRAM_TABS.filter((t) => {
    if (t.anyPerm) return t.anyPerm.some((p) => can(perms, p));
    return t.perm === null || can(perms, t.perm);
  });
}

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

/** ترويسة صفحة البرنامج مع شريط التبويبات المفلتر بالصلاحية. */
export function programHead(program, active, perms = null, extra = '') {
  const tabs = perms ? visibleTabs(perms) : PROGRAM_TABS;
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
  <nav class="subnav">${TAB_GROUPS.map((g) => {
    const items = tabs.filter((t) => t.group === g.id);
    if (!items.length) return '';
    return `<span class="subnav-group">
      ${g.label ? `<span class="g-label">${esc(g.label)}</span>` : ''}
      ${items.map((t) => `<a class="${active === t.key ? 'on' : ''}" href="/programs/${program.id}${t.key ? `/${t.key}` : ''}">
        ${icon(t.ico, { size: 15 })}<span>${esc(t.label)}</span></a>`).join('')}
    </span>`;
  }).join('')}</nav>`;
}

export const yesNo = (v) => (v ? 'نعم' : 'لا');
