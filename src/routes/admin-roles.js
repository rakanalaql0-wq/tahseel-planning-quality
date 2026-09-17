import { all, get, run } from '../db/index.js';
import { esc } from '../lib/util.js';
import {
  table, section, badge, statCard, field, input, textarea, select, pageTitle, emptyState,
} from '../views/ui.js';
import { icon } from '../views/icons.js';
import {
  PERMISSIONS, ALL_PERMS, allRoles, roleByKey, invalidateRoleCache,
} from '../lib/roles.js';
import { audit } from '../lib/audit.js';

/**
 * المناصب والصلاحيات.
 *
 * يضيف مدير النظام منصبًا جديدًا ويحدد صلاحياته بالتأشير، فتظهر مباشرة
 * في إسناد الفريق وفي «مالك المؤشر» دون تعديل برمجي.
 *
 * حدّان لا يتجاوزهما هذا الباب:
 * • الصلاحيات نفسها لا تُخترع من الواجهة — كل صلاحية مربوطة بشاشة أو زر
 *   موجود في الكود، فصلاحية مخترعة لا تفتح شيئًا.
 * • «مدير النظام» ليس دورًا هنا: صلاحيته مطلقة (*) في الكود، فلا تُسحب
 *   من الواجهة ولا يُقفل النظام على نفسه.
 */

const isAdmin = (user) => user.global_role === 'admin';
const KEY_RE = /^[a-z][a-z0-9_]{2,31}$/;

/** أين يُستعمل هذا الدور الآن — يحدّد هل يجوز حذفه. */
function roleUsage(key) {
  return {
    assignments: Number(get('SELECT COUNT(*) c FROM program_assignments WHERE role = ?', key)?.c || 0),
    indicators: Number(get('SELECT COUNT(*) c FROM indicators WHERE owner_role = ?', key)?.c || 0),
    tasks: Number(get('SELECT COUNT(*) c FROM tasks WHERE assigned_role = ?', key)?.c || 0),
  };
}

/** مربعات اختيار الصلاحيات، مجمّعة بحسب المجال. */
function permsPicker(selected) {
  return `<div class="perm-groups">${PERMISSIONS.map((g) => `
    <fieldset class="perm-group">
      <legend>${esc(g.group)}</legend>
      ${g.perms.map(([key, label]) => `<label class="perm">
        <input type="checkbox" name="perm" value="${esc(key)}"${selected.has(key) ? ' checked' : ''}>
        <span class="perm-text"><span>${esc(label)}</span><code>${esc(key)}</code></span>
      </label>`).join('')}
    </fieldset>`).join('')}</div>`;
}

export default function register(router) {
  // ------------------------------ قائمة المناصب ------------------------------
  router.get('/admin/roles', (ctx) => {
    if (!isAdmin(ctx.user)) return ctx.deny();
    const roles = allRoles();

    const rows = roles.map((r) => {
      const u = roleUsage(r.key);
      return [
        `<a href="/admin/roles/${esc(r.key)}"><strong>${esc(r.name)}</strong></a>
         <br><code>${esc(r.key)}</code>`,
        r.is_system ? badge('من الوثيقة', 'info') : badge('مُضاف', 'muted'),
        r.is_active ? badge('مفعّل', 'good') : badge('معطّل', 'muted'),
        `<span class="num">${r.perms.size}</span>`,
        `<span class="num">${u.assignments}</span>`,
        `<span class="num">${u.indicators}</span>`,
        `<a class="btn sec small" href="/admin/roles/${esc(r.key)}">تعديل</a>`,
      ];
    });

    ctx.render('المناصب والصلاحيات', `
      <div class="pagehead"><div>${pageTitle('المناصب والصلاحيات')}
        <p class="meta">أضف منصبًا وحدّد ما يملكه من صلاحيات — يظهر فورًا في إسناد الفريق وفي مالك المؤشر</p></div>
        <div><a class="btn sec" href="/admin">${icon('chevron', { size: 14 })} مركز الإدارة</a></div></div>

      <div class="stats">
        ${statCard({ label: 'المناصب', value: roles.length, ico: 'team' })}
        ${statCard({ label: 'المفعّلة', value: roles.filter((r) => r.is_active).length, ico: 'check', tone: 'good' })}
        ${statCard({ label: 'الصلاحيات المتاحة', value: ALL_PERMS.length, ico: 'shield' })}
        ${statCard({ label: 'إسنادات قائمة', value: Number(get('SELECT COUNT(*) c FROM program_assignments')?.c || 0), ico: 'users' })}
      </div>

      ${section('المناصب', table(
    ['المنصب', 'النوع', 'الحالة', 'صلاحياته', 'إسنادات', 'مؤشرات يملكها', ''],
    rows, { empty: 'لا مناصب.' },
  ), { ico: 'team' })}

      ${section('إضافة منصب جديد', `
        <form method="post" action="/admin/roles">
          <div class="form-grid">
            ${field('اسم المنصب', input('name', { required: true, placeholder: 'منسّق الأنشطة' }))}
            ${field('المعرّف', input('key', { required: true, placeholder: 'activity_coordinator', attrs: 'pattern="[a-z][a-z0-9_]{2,31}"' }), 'حروف إنجليزية صغيرة وشرطة سفلية — لا يتغيّر بعد الإنشاء')}
          </div>
          ${field('وصف المنصب', textarea('description', { rows: 2, placeholder: 'من يشغل هذا المنصب وما نطاق عمله' }))}
          <h3 style="margin-top:1rem">صلاحياته</h3>
          ${permsPicker(new Set())}
          <p style="margin-top:.9rem"><button class="btn">${icon('plus', { size: 14 })} إضافة المنصب</button></p>
        </form>`, { ico: 'plus' })}

      <div class="flash info">${icon('info', { size: 17 })}<span>
        «مدير النظام» ليس منصبًا في هذه الشاشة: صلاحيته مطلقة في الكود حتى لا يُقفل النظام على نفسه
        بسحب صلاحية خاطئة.</span></div>`,
    { active: '/admin/roles', wide: true });
  });

  // ------------------------------ صفحة منصب ------------------------------
  router.get('/admin/roles/:key', (ctx) => {
    if (!isAdmin(ctx.user)) return ctx.deny();
    const role = roleByKey(ctx.params.key);
    if (!role) return ctx.notFound('المنصب غير موجود.');
    const usage = roleUsage(role.key);
    const holders = all(
      `SELECT DISTINCT u.id, u.full_name, u.username FROM program_assignments a
         JOIN users u ON u.id = a.user_id WHERE a.role = ? ORDER BY u.full_name`, role.key,
    );
    const owned = all('SELECT id, code, name, weight FROM indicators WHERE owner_role = ? ORDER BY sort, id', role.key);

    const blocked = role.is_system ? 'منصب من الوثيقة — يُعطَّل ولا يُحذف'
      : usage.assignments ? `مسند إلى ${usage.assignments} شخصًا`
        : usage.indicators ? `يملك ${usage.indicators} مؤشرًا` : null;

    ctx.render(role.name, `
      <div class="crumbs"><a href="/admin">مركز الإدارة</a> ← <a href="/admin/roles">المناصب والصلاحيات</a></div>
      <div class="pagehead"><div>
        ${pageTitle(role.name, { ico: 'team', extra: role.is_active ? badge('مفعّل', 'good') : badge('معطّل', 'muted') })}
        <p class="meta"><code>${esc(role.key)}</code>${role.description ? ` · ${esc(role.description)}` : ''}</p>
      </div><div>${blocked
    ? `<span class="hint">${esc(blocked)}</span>`
    : `<form method="post" action="/admin/roles/${esc(role.key)}/delete" class="inline"
          onsubmit="return confirm('سيُحذف المنصب نهائيًا. متابعة؟')">
        <button class="btn danger small">${icon('close', { size: 13 })} حذف المنصب</button></form>`}</div></div>

      <div class="stats">
        ${statCard({ label: 'صلاحياته', value: role.perms.size, ico: 'shield' })}
        ${statCard({ label: 'من يشغلونه', value: holders.length, ico: 'users' })}
        ${statCard({ label: 'مؤشرات يملكها', value: owned.length, ico: 'target', tone: owned.length ? 'info' : '' })}
        ${statCard({ label: 'مهام باسمه', value: usage.tasks, ico: 'tasks' })}
      </div>

      ${section('تعريف المنصب وصلاحياته', `
        <form method="post" action="/admin/roles/${esc(role.key)}">
          <div class="form-grid">
            ${field('اسم المنصب', input('name', { value: role.name, required: true }))}
            ${field('الحالة', select('is_active', [{ value: '1', label: 'مفعّل' }, { value: '0', label: 'معطّل' }], String(role.is_active ? 1 : 0)), 'المعطّل لا يظهر في إسناد الفريق ولا يمنح صلاحياته')}
          </div>
          ${field('وصف المنصب', textarea('description', { value: role.description, rows: 2 }))}

          <h3 style="margin-top:1rem">الصلاحيات</h3>
          ${permsPicker(role.perms)}

          <h3 style="margin-top:1rem">المسؤوليات كما تظهر لصاحب المنصب</h3>
          ${field('مسؤولية في كل سطر', textarea('duties', { value: role.duties.join('\n'), rows: 6 }),
    'تُعرض في لوحة المستخدم وفي شاشة «الفريق والأدوار».')}

          <p style="margin-top:.9rem"><button class="btn">حفظ المنصب</button></p>
        </form>`, { ico: 'shield' })}

      <div class="grid two">
        ${section('من يشغل هذا المنصب', holders.length
    ? table(['الاسم', 'الحساب'], holders.map((h) => [esc(h.full_name), `<code>${esc(h.username)}</code>`]))
    : emptyState('لم يُسند هذا المنصب لأحد بعد.', 'users'), { ico: 'users' })}

        ${section('المؤشرات التي يملك قياسها', owned.length
    ? table(['المؤشر', 'الوزن'], owned.map((o) => [
      `<a href="/admin/metric/indicator/${o.id}"><code>${esc(o.code)}</code> ${esc(o.name)}</a>`,
      `<span class="num">${o.weight}</span>`,
    ]))
    : emptyState('لا يملك هذا المنصب قياس أي مؤشر.', 'target'), { ico: 'target' })}
      </div>`,
    { active: '/admin/roles', wide: true });
  });

  // ------------------------------ إنشاء منصب ------------------------------
  router.post('/admin/roles', (ctx) => {
    if (!isAdmin(ctx.user)) return ctx.deny();
    const key = String(ctx.body.key || '').trim().toLowerCase();
    const name = String(ctx.body.name || '').trim();
    if (!KEY_RE.test(key)) return ctx.redirect('/admin/roles', 'المعرّف غير صحيح: حروف إنجليزية صغيرة وشرطة سفلية، 3 أحرف فأكثر.', 'err');
    if (!name) return ctx.redirect('/admin/roles', 'اسم المنصب مطلوب.', 'err');
    if (roleByKey(key)) return ctx.redirect('/admin/roles', 'المعرّف مستخدم مسبقًا.', 'err');
    if (key === 'admin') return ctx.redirect('/admin/roles', 'المعرّف admin محجوز لمدير النظام.', 'err');

    const perms = [].concat(ctx.body.perm ?? []).filter((p) => ALL_PERMS.includes(p));
    const sort = Number(get('SELECT COALESCE(MAX(sort), 0) + 1 s FROM roles')?.s || 0);
    run('INSERT INTO roles (key, name, description, is_system, sort) VALUES (?, ?, ?, 0, ?)',
      key, name, String(ctx.body.description || '').trim() || null, sort);
    for (const p of perms) run('INSERT OR IGNORE INTO role_permissions (role_key, perm) VALUES (?, ?)', key, p);
    invalidateRoleCache();

    audit({ user: ctx.user, action: 'role.create', entityType: 'role', entityId: null, after: { key, name, perms }, ip: ctx.ip });
    ctx.redirect(`/admin/roles/${key}`, 'أُضيف المنصب. يظهر الآن في إسناد الفريق وفي مالك المؤشر.');
  });

  // ------------------------------ تحديث منصب ------------------------------
  router.post('/admin/roles/:key', (ctx) => {
    if (!isAdmin(ctx.user)) return ctx.deny();
    const role = roleByKey(ctx.params.key);
    if (!role) return ctx.notFound();
    const back = `/admin/roles/${role.key}`;

    const name = String(ctx.body.name || '').trim();
    if (!name) return ctx.redirect(back, 'اسم المنصب مطلوب.', 'err');
    const active = ctx.body.is_active === '0' ? 0 : 1;
    const description = String(ctx.body.description || '').trim() || null;

    run('UPDATE roles SET name = ?, description = ?, is_active = ? WHERE key = ?',
      name, description, active, role.key);

    // الصلاحيات: تُستبدل كاملة بما أُشّر عليه، ويُرفض أي مفتاح لا يعرفه النظام
    const perms = [].concat(ctx.body.perm ?? []).filter((p) => ALL_PERMS.includes(p));
    run('DELETE FROM role_permissions WHERE role_key = ?', role.key);
    for (const p of perms) run('INSERT OR IGNORE INTO role_permissions (role_key, perm) VALUES (?, ?)', role.key, p);

    // المسؤوليات: سطر لكل مسؤولية
    const duties = String(ctx.body.duties || '').split('\n').map((d) => d.trim()).filter(Boolean).slice(0, 40);
    run('DELETE FROM role_duties WHERE role_key = ?', role.key);
    for (const [i, d] of duties.entries()) {
      run('INSERT INTO role_duties (role_key, text, sort) VALUES (?, ?, ?)', role.key, d.slice(0, 400), i);
    }

    invalidateRoleCache();
    audit({
      user: ctx.user, action: 'role.update', entityType: 'role', entityId: null,
      before: { name: role.name, is_active: role.is_active, perms: [...role.perms] },
      after: { key: role.key, name, is_active: active, perms }, ip: ctx.ip,
    });
    ctx.redirect(back, 'حُدّث المنصب وصلاحياته.');
  });

  // ------------------------------ حذف منصب ------------------------------
  router.post('/admin/roles/:key/delete', (ctx) => {
    if (!isAdmin(ctx.user)) return ctx.deny();
    const role = roleByKey(ctx.params.key);
    if (!role) return ctx.notFound();
    const back = `/admin/roles/${role.key}`;
    if (role.is_system) return ctx.redirect(back, 'منصب من الوثيقة الأصلية — يُعطَّل ولا يُحذف.', 'err');

    const usage = roleUsage(role.key);
    if (usage.assignments) return ctx.redirect(back, `المنصب مسند إلى ${usage.assignments} شخصًا — أزل الإسناد أولًا.`, 'err');
    if (usage.indicators) return ctx.redirect(back, `المنصب يملك ${usage.indicators} مؤشرًا — انقل ملكيتها أولًا.`, 'err');

    run('DELETE FROM roles WHERE key = ?', role.key);
    invalidateRoleCache();
    audit({ user: ctx.user, action: 'role.delete', entityType: 'role', entityId: null, before: { key: role.key, name: role.name }, ip: ctx.ip });
    ctx.redirect('/admin/roles', 'حُذف المنصب.');
  });
}
