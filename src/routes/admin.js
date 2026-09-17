import { all, get, run } from '../db/index.js';
import { esc, fmtDate, fmtNum, int } from '../lib/util.js';
import {
  table, section, badge, statCard, select, field, input, textarea, pageTitle, emptyState,
} from '../views/ui.js';
import { icon } from '../views/icons.js';
import { GLOBAL_ROLES, allRoles, roleName } from '../lib/roles.js';
import { hashPassword } from '../lib/auth.js';
import { audit, auditRecent } from '../lib/audit.js';
import { SETTINGS, setting, setSetting } from '../lib/settings.js';
import registerMetricAdmin from './admin-metric.js';
import registerRolesAdmin from './admin-roles.js';

const isAdmin = (user) => user.global_role === 'admin';
const isManager = (user) => user.global_role === 'admin' || user.global_role === 'quality_manager';

/** بطاقة باب في مركز الإدارة. */
function adminCard({ href, ico, title, desc, stat, adminOnly = false }) {
  return `<a class="adcard" href="${esc(href)}">
    <span class="adcard-ico">${icon(ico, { size: 22 })}</span>
    <span class="adcard-body">
      <strong>${esc(title)}</strong>
      <small>${esc(desc)}</small>
    </span>
    <span class="adcard-stat">${esc(String(stat ?? ''))}${adminOnly ? badge('مدير النظام', 'muted') : ''}</span>
  </a>`;
}

export default function register(router) {
  registerMetricAdmin(router);
  registerRolesAdmin(router);

  // ------------------------------ مركز الإدارة ------------------------------
  router.get('/admin', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const c = (sql) => Number(get(sql)?.c || 0);
    const indicators = all('SELECT weight, is_active FROM indicators');
    const totalWeight = indicators.filter((i) => i.is_active).reduce((s, i) => s + Number(i.weight), 0);
    const roles = allRoles();

    return ctx.render('مركز الإدارة', `
      <div class="pagehead"><div>${pageTitle('مركز الإدارة', { ico: 'shield' })}
        <p class="meta">كل ما يمكن تعريفه وتعديله في النظام من مكان واحد</p></div></div>

      <div class="stats">
        ${statCard({
    label: 'إجمالي أوزان المقياس',
    value: fmtNum(totalWeight),
    ico: 'scale',
    tone: Math.abs(totalWeight - 300) < 0.01 ? 'good' : 'bad',
    sub: 'المطلوب 300 (BR-01)',
  })}
        ${statCard({ label: 'المناصب', value: roles.length, ico: 'team', sub: `${roles.filter((r) => r.is_active).length} مفعّل` })}
        ${statCard({ label: 'الحسابات النشطة', value: c('SELECT COUNT(*) c FROM users WHERE is_active = 1'), ico: 'users' })}
        ${statCard({ label: 'البرامج', value: c('SELECT COUNT(*) c FROM programs'), ico: 'programs' })}
      </div>

      ${section('أبواب الإدارة', `<div class="adcards">
        ${adminCard({
    href: '/admin/metric',
    ico: 'scale',
    title: 'بنية المقياس والأوزان',
    desc: 'الأقسام والمحاور والمؤشرات والأوزان والدوريات وبنود التحقق وأسئلة الاستبانات',
    stat: `${c('SELECT COUNT(*) c FROM indicators WHERE is_active = 1')} مؤشرًا`,
  })}
        ${isAdmin(ctx.user) ? adminCard({
    href: '/admin/roles',
    ico: 'shield',
    title: 'المناصب والصلاحيات',
    desc: 'إضافة منصب جديد وتحديد صلاحياته ومسؤولياته ومن يملك قياس المؤشرات',
    stat: `${roles.length} منصبًا`,
    adminOnly: true,
  }) : ''}
        ${adminCard({
    href: '/admin/users',
    ico: 'users',
    title: 'المستخدمون والحسابات',
    desc: 'إنشاء الحسابات وإيقافها وتحديد الصلاحية العامة',
    stat: `${c('SELECT COUNT(*) c FROM users')} حسابًا`,
  })}
        ${isAdmin(ctx.user) ? adminCard({
    href: '/admin/settings',
    ico: 'plan',
    title: 'الإعدادات والبيانات المرجعية',
    desc: 'اسم الجمعية، حدّ الاستجابة المعتمد، مدة معالجة الشكوى، والقاعات',
    stat: `${c('SELECT COUNT(*) c FROM venues')} قاعة`,
    adminOnly: true,
  }) : ''}
        ${adminCard({
    href: '/admin/audit',
    ico: 'audit',
    title: 'سجل التدقيق',
    desc: 'من فعل ماذا ومتى — قبل التعديل وبعده',
    stat: `${c('SELECT COUNT(*) c FROM audit_logs')} عملية`,
  })}
      </div>`, { ico: 'layers' })}

      ${section('قواعد الأعمال المعتمدة', `<ul class="duties">
        <li>BR-01 — إجمالي المقياس 300 درجة: 75 + 135 + 90.</li>
        <li>BR-02 — قائمة التحقق: متحقق 100%، جزئي 50%، غير متحقق 0%.</li>
        <li>BR-03 — الاستبانة: (المتوسط − 1) ÷ 4 × 100.</li>
        <li>BR-04 — الملاحظة إلزامية عند جزئي أو غير متحقق.</li>
        <li>BR-05 — تهيئة القاعات: عينة لا تقل عن 50% من اللقاءات.</li>
        <li>BR-06 — الضيافة: عينة لا تقل عن 25% وبحد أدنى مرتين.</li>
        <li>BR-07 — التجهيزات: تحقق مرتان على الأقل.</li>
        <li>BR-08 — الدعم والتواصل: قياس في المنتصف والنهاية.</li>
        <li>BR-09 — فاعلية النشاط الرئيس: تقاس مباشرة بعد كل نشاط رئيس.</li>
        <li>BR-10 — الاستمرارية: 5 درجات نية الاستمرار + 15 الاستمرار الفعلي.</li>
        <li>BR-11 — «اكتمال القياس» يُعرض مستقلاً عن «نتيجة الجودة».</li>
        <li>BR-12 — لا يحكم الطالب على السلامة العلمية للمحتوى.</li>
        <li>BR-13 — الاستبانة دون الحد الأدنى للاستجابة تُوسم «عينة غير كافية».</li>
        <li>BR-14 — رابط الاستبانة فردي لكل طالب ويُستخدم مرة واحدة.</li>
        <li>BR-15 — المؤشر غير المنطبق يُستثنى من الوزن بسبب موثّق.</li>
      </ul>`, { ico: 'list' })}`,
    { active: '/admin', wide: true });
  });

  // ------------------------------ الإعدادات والبيانات المرجعية ------------
  router.get('/admin/settings', (ctx) => {
    if (!isAdmin(ctx.user)) return ctx.deny();
    const venues = all(`SELECT v.*, (SELECT COUNT(*) FROM programs p WHERE p.venue_id = v.id) AS programs
                          FROM venues v ORDER BY v.name`);

    ctx.render('الإعدادات', `
      <div class="crumbs"><a href="/admin">مركز الإدارة</a></div>
      <div class="pagehead"><div>${pageTitle('الإعدادات والبيانات المرجعية', { ico: 'plan' })}
        <p class="meta">قيم يقرأها النظام فعلًا في الاحتساب والعرض</p></div></div>

      ${section('إعدادات النظام', `
        <form method="post" action="/admin/settings">
          <div class="form-grid">
            ${SETTINGS.map((s) => field(s.label, input(s.key, {
    type: s.type === 'number' ? 'number' : 'text',
    value: setting(s.key) ?? '',
    attrs: s.type === 'number' ? `min="${s.min}" max="${s.max}"` : '',
  }), s.hint)).join('')}
          </div>
          <button class="btn">حفظ الإعدادات</button>
        </form>`, { ico: 'plan' })}

      ${section(`القاعات والمواقع (${venues.length})`, `
        ${venues.length ? table(['القاعة', 'الموقع', 'السعة', 'برامج', 'ملاحظات', ''],
    venues.map((v) => [
      `<details class="editbox"><summary>${esc(v.name)}</summary><div class="editbox-body">
            <form method="post" action="/admin/venues">
              <input type="hidden" name="op" value="update"><input type="hidden" name="id" value="${v.id}">
              <div class="form-grid">
                ${field('الاسم', input('name', { value: v.name, required: true }))}
                ${field('الموقع', input('location', { value: v.location || '' }))}
                ${field('السعة', input('capacity', { type: 'number', value: v.capacity ?? '', attrs: 'min="0" max="5000"' }))}
              </div>
              ${field('ملاحظات', textarea('notes', { value: v.notes || '', rows: 2 }))}
              <button class="btn small">حفظ القاعة</button>
            </form></div></details>`,
      esc(v.location || '—'),
      v.capacity === null ? '—' : `<span class="num">${v.capacity}</span>`,
      `<span class="num">${v.programs}</span>`,
      `<small class="muted">${esc(v.notes || '—')}</small>`,
      v.programs
        ? '<span class="hint">مستخدمة في برامج</span>'
        : `<form method="post" action="/admin/venues" class="inline" onsubmit="return confirm('حذف القاعة؟')">
              <input type="hidden" name="op" value="delete"><input type="hidden" name="id" value="${v.id}">
              <button class="btn danger small">حذف</button></form>`,
    ])) : emptyState('لا قاعات مسجّلة.', 'building')}

        <details class="editbox"><summary>${icon('plus', { size: 14 })} إضافة قاعة</summary><div class="editbox-body">
          <form method="post" action="/admin/venues">
            <input type="hidden" name="op" value="create">
            <div class="form-grid">
              ${field('الاسم', input('name', { required: true, placeholder: 'القاعة الرئيسة' }))}
              ${field('الموقع', input('location', { placeholder: 'المقر الرئيس — الرياض' }))}
              ${field('السعة', input('capacity', { type: 'number', attrs: 'min="0" max="5000"' }))}
            </div>
            ${field('ملاحظات', textarea('notes', { rows: 2 }))}
            <button class="btn small">إضافة القاعة</button>
          </form></div></details>`, { ico: 'building' })}`,
    { active: '/admin', wide: true });
  });

  router.post('/admin/settings', (ctx) => {
    if (!isAdmin(ctx.user)) return ctx.deny();
    const changed = [];
    for (const s of SETTINGS) {
      const raw = ctx.body[s.key];
      if (raw === undefined) continue;
      let value = String(raw).trim();
      if (s.type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) continue;
        value = String(Math.max(s.min, Math.min(s.max, n)));
      }
      if (!value) continue;
      if (setSetting(s.key, value)) changed.push(`${s.key}=${value}`);
    }
    audit({ user: ctx.user, action: 'settings.update', entityType: 'system', after: { changed }, ip: ctx.ip });
    ctx.redirect('/admin/settings', 'حُفظت الإعدادات.');
  });

  // ------------------------------ القاعات ------------------------------
  router.post('/admin/venues', (ctx) => {
    if (!isAdmin(ctx.user)) return ctx.deny();
    const back = '/admin/settings';
    const op = ctx.body.op;

    if (op === 'delete') {
      const v = get('SELECT * FROM venues WHERE id = ?', ctx.body.id);
      if (!v) return ctx.notFound();
      if (get('SELECT 1 FROM programs WHERE venue_id = ?', v.id)) {
        return ctx.redirect(back, 'القاعة مستخدمة في برامج — لا تُحذف.', 'err');
      }
      run('DELETE FROM venues WHERE id = ?', v.id);
      audit({ user: ctx.user, action: 'venue.delete', entityType: 'venue', entityId: v.id, before: v, ip: ctx.ip });
      return ctx.redirect(back, 'حُذفت القاعة.');
    }

    const name = String(ctx.body.name || '').trim();
    if (!name) return ctx.redirect(back, 'اسم القاعة مطلوب.', 'err');
    const location = String(ctx.body.location || '').trim() || null;
    const capacity = ctx.body.capacity === '' ? null : Math.max(0, Math.min(5000, int(ctx.body.capacity, 0)));
    const notes = String(ctx.body.notes || '').trim() || null;

    if (op === 'update') {
      const v = get('SELECT * FROM venues WHERE id = ?', ctx.body.id);
      if (!v) return ctx.notFound();
      run('UPDATE venues SET name = ?, location = ?, capacity = ?, notes = ? WHERE id = ?',
        name, location, capacity, notes, v.id);
      audit({ user: ctx.user, action: 'venue.update', entityType: 'venue', entityId: v.id, before: v, after: { name, location, capacity }, ip: ctx.ip });
      return ctx.redirect(back, 'حُدّثت القاعة.');
    }

    const res = run('INSERT INTO venues (name, location, capacity, notes) VALUES (?, ?, ?, ?)',
      name, location, capacity, notes);
    audit({ user: ctx.user, action: 'venue.create', entityType: 'venue', entityId: Number(res.lastInsertRowid), after: { name, location }, ip: ctx.ip });
    return ctx.redirect(back, 'أُضيفت القاعة.');
  });

  // ------------------------------ المستخدمون ---------------------------
  router.get('/admin/users', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const users = all(
      `SELECT u.*, (SELECT COUNT(*) FROM program_assignments a WHERE a.user_id = u.id) AS assignments,
              (SELECT COUNT(*) FROM tasks t WHERE t.assigned_user_id = u.id AND t.status = 'pending') AS pending
         FROM users u ORDER BY u.full_name`,
    );
    const rolesOf = (userId) => all(
      'SELECT DISTINCT role FROM program_assignments WHERE user_id = ?', userId,
    ).map((r) => roleName(r.role)).join('، ');

    ctx.render('المستخدمون', `
      <div class="crumbs"><a href="/admin">مركز الإدارة</a></div>
      <div class="pagehead"><div>${pageTitle('المستخدمون والحسابات')}
        <p class="meta">الصلاحية العامة هنا، والمناصب التشغيلية تُسند داخل كل برنامج</p></div></div>
      ${section('الحسابات', table(['الاسم', 'الحساب', 'الصلاحية العامة', 'مناصبه', 'إسنادات', 'مهام معلّقة', 'آخر دخول', 'الحالة', ''],
    users.map((u) => [
      esc(u.full_name), `<code>${esc(u.username)}</code>`,
      esc(GLOBAL_ROLES[u.global_role] || u.global_role),
      `<small class="muted">${esc(rolesOf(u.id) || '—')}</small>`,
      `<span class="num">${u.assignments}</span>`, `<span class="num">${u.pending}</span>`,
      fmtDate(u.last_login_at), u.is_active ? badge('نشط', 'good') : badge('موقوف', 'muted'),
      isAdmin(ctx.user) ? `<form method="post" action="/admin/users/toggle" class="inline">
            <input type="hidden" name="id" value="${u.id}">
            <button class="btn small sec">${u.is_active ? 'إيقاف' : 'تفعيل'}</button></form>` : '',
    ])), { ico: 'users' })}
      ${isAdmin(ctx.user) ? section('إضافة مستخدم', `
        <form method="post" action="/admin/users">
          <div class="form-grid">
            ${field('الاسم الكامل', input('full_name', { required: true }))}
            ${field('اسم المستخدم', input('username', { required: true, attrs: 'pattern="[A-Za-z0-9._-]{3,32}"' }), 'حروف إنجليزية وأرقام، 3 أحرف فأكثر')}
            ${field('كلمة المرور', input('password', { type: 'password', required: true, attrs: 'minlength="8"' }))}
            ${field('الصلاحية العامة', select('global_role', Object.entries(GLOBAL_ROLES).map(([v, l]) => ({ value: v, label: l })), 'none'))}
          </div>
          <button class="btn">إضافة</button>
        </form>
        <p class="hint">المناصب التشغيلية تُسند داخل كل برنامج من شاشة «الفريق والأدوار».</p>`, { ico: 'plus' }) : ''}`,
    { active: '/admin/users', wide: true });
  });

  router.post('/admin/users', (ctx) => {
    if (!isAdmin(ctx.user)) return ctx.deny();
    const fullName = String(ctx.body.full_name || '').trim();
    const username = String(ctx.body.username || '').trim();
    const password = String(ctx.body.password || '');
    if (!fullName || !/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
      return ctx.redirect('/admin/users', 'بيانات الحساب غير صحيحة.', 'err');
    }
    if (password.length < 8) return ctx.redirect('/admin/users', 'كلمة المرور يجب ألا تقل عن 8 أحرف.', 'err');
    if (get('SELECT 1 FROM users WHERE lower(username) = lower(?)', username)) {
      return ctx.redirect('/admin/users', 'اسم المستخدم مستخدم مسبقًا.', 'err');
    }
    const globalRole = Object.keys(GLOBAL_ROLES).includes(ctx.body.global_role) ? ctx.body.global_role : 'none';
    const { hash, salt } = hashPassword(password);
    const res = run('INSERT INTO users (full_name, username, password_hash, password_salt, global_role) VALUES (?, ?, ?, ?, ?)',
      fullName, username, hash, salt, globalRole);
    audit({ user: ctx.user, action: 'user.create', entityType: 'user', entityId: Number(res.lastInsertRowid), after: { username, globalRole }, ip: ctx.ip });
    ctx.redirect('/admin/users', 'أُضيف المستخدم.');
  });

  router.post('/admin/users/toggle', (ctx) => {
    if (!isAdmin(ctx.user)) return ctx.deny();
    const u = get('SELECT * FROM users WHERE id = ?', ctx.body.id);
    if (!u) return ctx.notFound();
    if (u.id === ctx.user.id) return ctx.redirect('/admin/users', 'لا يمكن إيقاف حسابك الحالي.', 'err');
    run('UPDATE users SET is_active = ? WHERE id = ?', u.is_active ? 0 : 1, u.id);
    if (u.is_active) run('DELETE FROM auth_sessions WHERE user_id = ?', u.id);
    audit({ user: ctx.user, action: 'user.toggle', entityType: 'user', entityId: u.id, before: { is_active: u.is_active }, after: { is_active: u.is_active ? 0 : 1 }, ip: ctx.ip });
    ctx.redirect('/admin/users', 'حُدّثت حالة الحساب.');
  });

  // ------------------------------ سجل التدقيق العام ---------------------
  router.get('/admin/audit', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const rows = auditRecent(300);
    ctx.render('سجل التدقيق', `
      <div class="crumbs"><a href="/admin">مركز الإدارة</a></div>
      <div class="pagehead"><div>${pageTitle('سجل التدقيق')}
        <p class="meta">من فعل ماذا ومتى — قبل/بعد التعديل، وسجل الدخول والاعتمادات</p></div></div>
      ${section('آخر 300 عملية', table(['التاريخ', 'المستخدم', 'العملية', 'الكيان', 'البرنامج', 'قبل', 'بعد'],
    rows.map((a) => [
      `<small class="num">${esc(a.created_at)}</small>`, esc(a.user_name || '—'),
      `<code>${esc(a.action)}</code>`, `${esc(a.entity_type || '—')}#${a.entity_id ?? '—'}`,
      a.program_id ? `<a href="/programs/${a.program_id}">#${a.program_id}</a>` : '—',
      `<small class="muted">${esc(String(a.before_json || '—').slice(0, 90))}</small>`,
      `<small class="muted">${esc(String(a.after_json || '—').slice(0, 90))}</small>`,
    ]), { empty: 'لا توجد عمليات.' }), { ico: 'audit' })}`,
    { active: '/admin/audit', wide: true });
  });
}
