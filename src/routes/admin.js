import { all, get, run } from '../db/index.js';
import { esc, fmtDate, fmtNum, int, num } from '../lib/util.js';
import { table, section, badge, statCard, select, field, input, pageTitle } from '../views/ui.js';
import { ROLES, ROLE_KEYS, GLOBAL_ROLES, roleName } from '../lib/roles.js';
import { hashPassword } from '../lib/auth.js';
import { audit, auditRecent } from '../lib/audit.js';
import { samplePlanLabel } from '../lib/scoring.js';
import { syncProgramTasks } from '../lib/scheduler.js';

const isAdmin = (user) => user.global_role === 'admin';
const isManager = (user) => user.global_role === 'admin' || user.global_role === 'quality_manager';

const PERIODICITY = [
  { value: 'before_start', label: 'قبل بدء البرنامج' },
  { value: 'mid', label: 'منتصف البرنامج' },
  { value: 'end', label: 'نهاية البرنامج' },
  { value: 'mid_end', label: 'المنتصف والنهاية' },
  { value: 'per_session_sample', label: 'عينة من اللقاءات' },
  { value: 'fixed_count', label: 'عدد ثابت من المرات' },
  { value: 'per_main_activity', label: 'بعد كل نشاط رئيس' },
  { value: 'continuous', label: 'سجل تشغيلي مستمر' },
];

export default function register(router) {
  // ------------------------------ إدارة المقياس -------------------------
  router.get('/admin/metric', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const sections = all('SELECT * FROM metric_sections ORDER BY sort, id');
    const axes = all('SELECT * FROM metric_axes ORDER BY sort, id');
    const indicators = all('SELECT * FROM indicators ORDER BY sort, id');
    const totalWeight = indicators.filter((i) => i.is_active).reduce((s, i) => s + Number(i.weight), 0);

    const rows = [];
    for (const s of sections) {
      const sAxes = axes.filter((a) => a.section_id === s.id);
      const sWeight = sAxes.reduce((acc, a) => acc + indicators.filter((i) => i.axis_id === a.id && i.is_active)
        .reduce((x, i) => x + Number(i.weight), 0), 0);
      rows.push(`<tr class="section-row"><td colspan="6"><strong>${esc(s.name)}</strong>
        — الوزن المعلن ${fmtNum(s.weight)} / المحسوب من المؤشرات ${fmtNum(sWeight)}
        ${Math.abs(sWeight - Number(s.weight)) > 0.01 ? badge('تعارض في الأوزان', 'bad') : badge('متطابق', 'good')}</td></tr>`);
      for (const a of sAxes) {
        rows.push(`<tr class="axis-row"><td colspan="6">— ${esc(a.name)} (${fmtNum(a.weight)})</td></tr>`);
        for (const i of indicators.filter((x) => x.axis_id === a.id)) {
          rows.push(`<tr>
            <td><code>${esc(i.code)}</code> ${esc(i.name)}
              ${i.is_active ? '' : badge('معطّل', 'muted')}
              ${i.description ? `<br><small class="muted">${esc(i.description)}</small>` : ''}</td>
            <td>${{ checklist: 'قائمة تحقق', survey: 'استبانة', record: 'سجل تشغيلي' }[i.tool]}</td>
            <td>${roleName(i.owner_role)}</td>
            <td><small>${esc(samplePlanLabel(i))}</small></td>
            <td class="num">${fmtNum(i.weight)}</td>
            <td><form method="post" action="/admin/metric/indicator" class="row-form">
              <input type="hidden" name="id" value="${i.id}">
              ${input('weight', { type: 'number', value: i.weight, attrs: 'step="0.5" min="0" max="300" style="width:80px"' })}
              ${select('owner_role', ROLE_KEYS.map((k) => ({ value: k, label: ROLES[k].name })), i.owner_role)}
              ${select('periodicity', PERIODICITY, i.periodicity)}
              ${input('sample_pct', { type: 'number', value: i.sample_pct ?? '', placeholder: '% عينة', attrs: 'min="0" max="100" style="width:80px"' })}
              ${input('min_count', { type: 'number', value: i.min_count ?? '', placeholder: 'حد أدنى', attrs: 'min="0" max="200" style="width:80px"' })}
              ${select('is_active', [{ value: '1', label: 'مفعّل' }, { value: '0', label: 'معطّل' }], String(i.is_active))}
              <button class="btn small sec">حفظ</button>
            </form></td></tr>`);
        }
      }
    }

    ctx.render('إدارة المقياس', `
      <div class="pagehead"><div>${pageTitle('إدارة المقياس')}
        <p class="meta">الأوزان والدوريات وقواعد العينة قابلة للتعديل دون تغيير الكود</p></div></div>
      <div class="stats">
        ${statCard({ label: 'إجمالي أوزان المؤشرات', value: fmtNum(totalWeight), tone: Math.abs(totalWeight - 300) < 0.01 ? 'good' : 'bad', sub: 'المطلوب 300 (BR-01)' })}
        ${statCard({ label: 'الأقسام', value: sections.length })}
        ${statCard({ label: 'المحاور', value: axes.length })}
        ${statCard({ label: 'المؤشرات المفعّلة', value: indicators.filter((i) => i.is_active).length })}
      </div>
      ${Math.abs(totalWeight - 300) > 0.01 ? '<div class="flash err">تحذير: مجموع أوزان المؤشرات لا يساوي 300 درجة. صحّح الأوزان قبل اعتماد القياس.</div>' : ''}
      ${section('شجرة المقياس', `<div class="table-wrap"><table class="compact">
        <thead><tr><th>المؤشر</th><th>الأداة</th><th>المسؤول</th><th>خطة العينة</th><th>الوزن</th><th>تعديل</th></tr></thead>
        <tbody>${rows.join('')}</tbody></table></div>`,
        { actions: '<form method="post" action="/admin/metric/resync" class="inline"><button class="btn sec small">إعادة توليد مهام كل البرامج النشطة</button></form>' })}
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
        <li>BR-12 — لا يحكم الطالب على السلامة العلمية للمحتوى (لا تُبنى أسئلة استبانة على مؤشرات المحتوى).</li>
      </ul>`)}`, { active: '/admin/metric', wide: true });
  });

  router.post('/admin/metric/indicator', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const ind = get('SELECT * FROM indicators WHERE id = ?', ctx.body.id);
    if (!ind) return ctx.notFound();
    const weight = Math.max(0, Math.min(300, num(ctx.body.weight, ind.weight)));
    const role = ROLE_KEYS.includes(ctx.body.owner_role) ? ctx.body.owner_role : ind.owner_role;
    const periodicity = PERIODICITY.some((p) => p.value === ctx.body.periodicity) ? ctx.body.periodicity : ind.periodicity;
    const samplePct = ctx.body.sample_pct === '' ? null : Math.max(0, Math.min(100, num(ctx.body.sample_pct, 0)));
    const minCount = ctx.body.min_count === '' ? null : Math.max(0, Math.min(200, int(ctx.body.min_count, 0)));
    const active = ctx.body.is_active === '0' ? 0 : 1;
    run(`UPDATE indicators SET weight = ?, owner_role = ?, periodicity = ?, sample_pct = ?, min_count = ?, is_active = ? WHERE id = ?`,
      weight, role, periodicity, samplePct, minCount, active, ind.id);
    audit({
      user: ctx.user, action: 'indicator.update', entityType: 'indicator', entityId: ind.id,
      before: { weight: ind.weight, owner_role: ind.owner_role, periodicity: ind.periodicity, sample_pct: ind.sample_pct, min_count: ind.min_count, is_active: ind.is_active },
      after: { weight, owner_role: role, periodicity, sample_pct: samplePct, min_count: minCount, is_active: active }, ip: ctx.ip,
    });
    ctx.redirect('/admin/metric', 'حُدّث المؤشر. أعد توليد المهام لتطبيق التغيير على البرامج النشطة.');
  });

  router.post('/admin/metric/resync', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const programs = all("SELECT id FROM programs WHERE status <> 'closed'");
    let created = 0;
    let cancelled = 0;
    for (const p of programs) {
      const r = syncProgramTasks(p.id);
      created += r.created; cancelled += r.cancelled;
    }
    audit({ user: ctx.user, action: 'tasks.resync_all', entityType: 'system', after: { created, cancelled }, ip: ctx.ip });
    ctx.redirect('/admin/metric', `أُعيد التوليد على ${programs.length} برنامجًا: ${created} مهمة جديدة، ${cancelled} ملغاة.`);
  });

  // ------------------------------ المستخدمون ---------------------------
  router.get('/admin/users', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const users = all(
      `SELECT u.*, (SELECT COUNT(*) FROM program_assignments a WHERE a.user_id = u.id) AS assignments,
              (SELECT COUNT(*) FROM tasks t WHERE t.assigned_user_id = u.id AND t.status = 'pending') AS pending
         FROM users u ORDER BY u.full_name`,
    );
    ctx.render('المستخدمون', `
      <div class="pagehead"><div>${pageTitle('المستخدمون والحسابات')}</div></div>
      ${section('الحسابات', table(['الاسم', 'الحساب', 'الصلاحية العامة', 'إسنادات', 'مهام معلّقة', 'آخر دخول', 'الحالة', ''],
        users.map((u) => [
          esc(u.full_name), `<code>${esc(u.username)}</code>`, esc(GLOBAL_ROLES[u.global_role] || u.global_role),
          `<span class="num">${u.assignments}</span>`, `<span class="num">${u.pending}</span>`,
          fmtDate(u.last_login_at), u.is_active ? badge('نشط', 'good') : badge('موقوف', 'muted'),
          isAdmin(ctx.user) ? `<form method="post" action="/admin/users/toggle" class="inline">
            <input type="hidden" name="id" value="${u.id}">
            <button class="btn small sec">${u.is_active ? 'إيقاف' : 'تفعيل'}</button></form>` : '',
        ])))}
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
        <p class="hint">الأدوار التشغيلية تُسند داخل كل برنامج من شاشة «الفريق والأدوار».</p>`) : ''}`,
    { active: '/admin/users' });
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
      <div class="pagehead"><div>${pageTitle('سجل التدقيق')}
        <p class="meta">من فعل ماذا ومتى — قبل/بعد التعديل، وسجل الدخول والاعتمادات</p></div></div>
      ${section('آخر 300 عملية', table(['التاريخ', 'المستخدم', 'العملية', 'الكيان', 'البرنامج', 'قبل', 'بعد'],
        rows.map((a) => [
          `<small class="num">${esc(a.created_at)}</small>`, esc(a.user_name || '—'),
          `<code>${esc(a.action)}</code>`, `${esc(a.entity_type || '—')}#${a.entity_id ?? '—'}`,
          a.program_id ? `<a href="/programs/${a.program_id}">#${a.program_id}</a>` : '—',
          `<small class="muted">${esc(String(a.before_json || '—').slice(0, 90))}</small>`,
          `<small class="muted">${esc(String(a.after_json || '—').slice(0, 90))}</small>`,
        ]), { empty: 'لا توجد عمليات.' }))}`, { active: '/admin/audit', wide: true });
  });
}
