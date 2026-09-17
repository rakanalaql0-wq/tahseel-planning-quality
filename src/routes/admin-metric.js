import { all, get, run } from '../db/index.js';
import { esc, fmtNum, int, num } from '../lib/util.js';
import {
  table, section, badge, statCard, select, field, input, textarea, pageTitle, emptyState,
} from '../views/ui.js';
import { icon } from '../views/icons.js';
import { activeRoles, roleKeys, roleName } from '../lib/roles.js';
import { audit } from '../lib/audit.js';
import { samplePlanLabel } from '../lib/scoring.js';
import { syncProgramTasks } from '../lib/scheduler.js';

/**
 * تحرير بنية المقياس من الواجهة: الأقسام والمحاور والمؤشرات والأوزان
 * وبنود التحقق وأسئلة الاستبانات.
 *
 * المبدأ الحاكم لكل ما في هذا الملف: **لا يُحذف ما قِيس**.
 * حذف مؤشر أو بند بعد قياسه يمحو سجلات التحقق معه (ON DELETE CASCADE)،
 * فيصبح التقرير القديم غير قابل للتفسير. لذلك يُمنع الحذف عند وجود قياس،
 * ويُعرض «التعطيل» بديلًا: يختفي من القياس الجديد وتبقى سجلاته كما هي.
 *
 * والبرامج المغلقة محفوظة أصلًا: درجتها النهائية مخزّنة في final_score،
 * فتعديل الأوزان لا يغيّرها. أما البرامج القائمة فتُحتسب درجتها من جديد.
 */

const TOOLS = [
  { value: 'checklist', label: 'قائمة تحقق' },
  { value: 'survey', label: 'استبانة' },
  { value: 'record', label: 'سجل تشغيلي' },
];
const TOOL_LABEL = Object.fromEntries(TOOLS.map((t) => [t.value, t.label]));

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

/** قواعد حساب السجلات التشغيلية — مطبّقة في محرك الاحتساب لا في الواجهة. */
const RECORD_RULES = [
  { value: 'attendance_rate', label: 'نسبة الحضور من سجل الحضور' },
  { value: 'discipline_documented', label: 'توثيق معالجة الحالات المتعثرة' },
  { value: 'followup_sessions', label: 'عقد جلسات المتابعة للحالات' },
  { value: 'complaint_sla', label: 'إغلاق الشكاوى ضمن المدة المعتمدة' },
  { value: 'continuity_intent', label: 'نية الاستمرار المعلنة من الطلاب' },
  { value: 'continuity_actual', label: 'الاستمرار الفعلي حتى النهاية' },
];
const RULE_LABEL = Object.fromEntries(RECORD_RULES.map((r) => [r.value, r.label]));

const POINTS = [
  { value: 'mid', label: 'منتصف البرنامج' },
  { value: 'end', label: 'نهاية البرنامج' },
  { value: 'activity', label: 'بعد النشاط الرئيس' },
];

const isManager = (user) => user.global_role === 'admin' || user.global_role === 'quality_manager';
const CODE_RE = /^[A-Za-z0-9.\-_]{1,24}$/;

// ------------------------------ قياس الاستخدام ------------------------------

/** كم قياسًا يستند إلى هذا المؤشر — يحدّد هل يجوز حذفه. */
function indicatorUsage(id) {
  const c = (sql) => Number(get(sql, id)?.c || 0);
  return {
    verifications: c('SELECT COUNT(*) c FROM verifications WHERE indicator_id = ?'),
    tasks: c('SELECT COUNT(*) c FROM tasks WHERE indicator_id = ?'),
    exemptions: c('SELECT COUNT(*) c FROM indicator_exemptions WHERE indicator_id = ?'),
    questions: c('SELECT COUNT(*) c FROM question_bank WHERE indicator_id = ?'),
    surveyQuestions: c('SELECT COUNT(*) c FROM survey_questions WHERE indicator_id = ?'),
  };
}
const isMeasured = (u) => u.verifications + u.tasks + u.exemptions + u.surveyQuestions > 0;

/** هل تحت هذا المحور/القسم أي مؤشر قِيس فعلًا. */
function axisMeasured(axisId) {
  return all('SELECT id FROM indicators WHERE axis_id = ?', axisId)
    .some((i) => isMeasured(indicatorUsage(i.id)));
}
function sectionMeasured(sectionId) {
  return all('SELECT id FROM metric_axes WHERE section_id = ?', sectionId).some((a) => axisMeasured(a.id));
}

const itemUsage = (id) => Number(get('SELECT COUNT(*) c FROM verification_items WHERE checklist_item_id = ?', id)?.c || 0);

// ------------------------------ عناصر الواجهة ------------------------------

/** نموذج داخل <details> — يبقى الشجرة مقروءة ويفتح التحرير عند الطلب. */
const editBox = (label, body) => `<details class="editbox">
  <summary>${icon('plan', { size: 14 })} ${esc(label)}</summary>
  <div class="editbox-body">${body}</div>
</details>`;

const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

/** زر حذف مع تأكيد — أو سبب المنع. */
function deleteButton(action, id, blocked) {
  if (blocked) return `<span class="hint">${esc(blocked)}</span>`;
  return `<form method="post" action="${esc(action)}" class="inline"
      onsubmit="return confirm('سيُحذف نهائيًا. متابعة؟')">
    ${hidden('op', 'delete')}${hidden('id', id)}
    <button class="btn danger small">${icon('close', { size: 13 })} حذف</button></form>`;
}

export default function register(router) {
  // ------------------------------ شجرة المقياس ------------------------------
  router.get('/admin/metric', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const sections = all('SELECT * FROM metric_sections ORDER BY sort, id');
    const axes = all('SELECT * FROM metric_axes ORDER BY sort, id');
    const indicators = all('SELECT * FROM indicators ORDER BY sort, id');
    const totalWeight = indicators.filter((i) => i.is_active).reduce((s, i) => s + Number(i.weight), 0);

    const axisWeight = (axisId) => indicators
      .filter((i) => i.axis_id === axisId && i.is_active)
      .reduce((s, i) => s + Number(i.weight), 0);

    const sectionForm = (s = null) => `
      <form method="post" action="/admin/metric/section">
        ${hidden('op', s ? 'update' : 'create')}${s ? hidden('id', s.id) : ''}
        <div class="form-grid">
          ${field('الرمز', input('code', { value: s?.code || '', required: true, placeholder: 'A1' }))}
          ${field('اسم القسم', input('name', { value: s?.name || '', required: true }))}
          ${field('الوزن المعلن', input('weight', { type: 'number', value: s?.weight ?? '', required: true, attrs: 'step="0.5" min="0" max="300"' }))}
          ${field('الترتيب', input('sort', { type: 'number', value: s?.sort ?? 0, attrs: 'min="0" max="99"' }))}
        </div>
        <button class="btn small">${s ? 'حفظ القسم' : 'إضافة قسم'}</button>
      </form>`;

    const axisForm = (sectionId, a = null) => `
      <form method="post" action="/admin/metric/axis">
        ${hidden('op', a ? 'update' : 'create')}${a ? hidden('id', a.id) : ''}${hidden('section_id', sectionId)}
        <div class="form-grid">
          ${field('الرمز', input('code', { value: a?.code || '', required: true, placeholder: 'A1.1' }))}
          ${field('اسم المحور', input('name', { value: a?.name || '', required: true }))}
          ${field('الوزن', input('weight', { type: 'number', value: a?.weight ?? '', required: true, attrs: 'step="0.5" min="0" max="300"' }))}
          ${field('الترتيب', input('sort', { type: 'number', value: a?.sort ?? 0, attrs: 'min="0" max="99"' }))}
        </div>
        <button class="btn small">${a ? 'حفظ المحور' : 'إضافة محور'}</button>
      </form>`;

    const indicatorForm = (axisId) => `
      <form method="post" action="/admin/metric/indicator">
        ${hidden('op', 'create')}${hidden('axis_id', axisId)}
        <div class="form-grid">
          ${field('الرمز', input('code', { required: true, placeholder: 'I-1.1.1' }))}
          ${field('اسم المؤشر', input('name', { required: true }))}
          ${field('الوزن', input('weight', { type: 'number', required: true, attrs: 'step="0.5" min="0" max="300"' }))}
          ${field('أداة القياس', select('tool', TOOLS, 'checklist'))}
          ${field('الدور المسؤول (مالك المؤشر)', select('owner_role', activeRoles().map((r) => ({ value: r.key, label: r.name })), 'program_officer'))}
          ${field('الدورية', select('periodicity', PERIODICITY, 'end'))}
        </div>
        <button class="btn small">${icon('plus', { size: 13 })} إضافة مؤشر</button>
        <p class="hint">تُضبط خطة العينة وبنود التحقق من صفحة المؤشر بعد إنشائه.</p>
      </form>`;

    const tree = sections.map((s) => {
      const sAxes = axes.filter((a) => a.section_id === s.id);
      const sWeight = sAxes.reduce((acc, a) => acc + axisWeight(a.id), 0);
      const mismatch = Math.abs(sWeight - Number(s.weight)) > 0.01;

      return `<div class="mnode mnode-section">
        <div class="mnode-head">
          <div>
            <h3><code>${esc(s.code)}</code> ${esc(s.name)}</h3>
            <p class="meta">الوزن المعلن <span class="num">${fmtNum(s.weight)}</span> ·
              المحسوب من المؤشرات <span class="num">${fmtNum(sWeight)}</span>
              ${mismatch ? badge('تعارض في الأوزان', 'bad') : badge('متطابق', 'good')}</p>
          </div>
          <div class="mnode-actions">
            ${deleteButton('/admin/metric/section', s.id,
    sAxes.length ? 'احذف محاوره أولًا' : sectionMeasured(s.id) ? 'قِيس — لا يُحذف' : null)}
          </div>
        </div>
        ${editBox('تعديل القسم', sectionForm(s))}

        ${sAxes.map((a) => {
    const aInds = indicators.filter((i) => i.axis_id === a.id);
    const aw = axisWeight(a.id);
    const aMismatch = Math.abs(aw - Number(a.weight)) > 0.01;
    return `<div class="mnode mnode-axis">
            <div class="mnode-head">
              <div>
                <h4><code>${esc(a.code)}</code> ${esc(a.name)}</h4>
                <p class="meta">الوزن <span class="num">${fmtNum(a.weight)}</span> ·
                  المحسوب <span class="num">${fmtNum(aw)}</span>
                  ${aMismatch ? badge('تعارض', 'bad') : badge('متطابق', 'good')}</p>
              </div>
              <div class="mnode-actions">
                ${deleteButton('/admin/metric/axis', a.id,
      aInds.length ? 'احذف مؤشراته أولًا' : axisMeasured(a.id) ? 'قِيس — لا يُحذف' : null)}
              </div>
            </div>
            ${editBox('تعديل المحور', axisForm(s.id, a))}

            ${aInds.length ? `<div class="table-wrap"><table class="compact">
              <thead><tr><th>المؤشر</th><th>الأداة</th><th>مالك المؤشر</th><th>خطة العينة</th><th>الوزن</th><th></th></tr></thead>
              <tbody>${aInds.map((i) => `<tr${i.is_active ? '' : ' class="exempt-row"'}>
                <td><a href="/admin/metric/indicator/${i.id}"><code>${esc(i.code)}</code> ${esc(i.name)}</a>
                  ${i.is_active ? '' : badge('معطّل', 'muted')}</td>
                <td>${esc(TOOL_LABEL[i.tool] || i.tool)}</td>
                <td>${esc(roleName(i.owner_role))}</td>
                <td><small>${esc(samplePlanLabel(i))}</small></td>
                <td class="num">${fmtNum(i.weight)}</td>
                <td><a class="btn sec small" href="/admin/metric/indicator/${i.id}">تفصيل</a></td>
              </tr>`).join('')}</tbody></table></div>` : '<p class="hint">لا مؤشرات في هذا المحور بعد.</p>'}
            ${editBox('إضافة مؤشر', indicatorForm(a.id))}
          </div>`;
  }).join('')}

        ${editBox('إضافة محور', axisForm(s.id))}
      </div>`;
    }).join('');

    ctx.render('بنية المقياس', `
      <div class="pagehead"><div>${pageTitle('بنية المقياس والأوزان')}
        <p class="meta">الأقسام والمحاور والمؤشرات والأوزان والدوريات — تُحرَّر هنا دون تعديل برمجي</p></div>
        <div><a class="btn sec" href="/admin">${icon('chevron', { size: 14 })} مركز الإدارة</a></div></div>

      <div class="stats">
        ${statCard({
    label: 'إجمالي أوزان المؤشرات',
    value: fmtNum(totalWeight),
    ico: 'scale',
    tone: Math.abs(totalWeight - 300) < 0.01 ? 'good' : 'bad',
    sub: 'المطلوب 300 (BR-01)',
  })}
        ${statCard({ label: 'الأقسام', value: sections.length, ico: 'layers' })}
        ${statCard({ label: 'المحاور', value: axes.length, ico: 'list' })}
        ${statCard({ label: 'المؤشرات المفعّلة', value: indicators.filter((i) => i.is_active).length, ico: 'target' })}
      </div>

      ${Math.abs(totalWeight - 300) > 0.01 ? `<div class="flash err">${icon('alert', { size: 17 })}
        <span>مجموع أوزان المؤشرات ${fmtNum(totalWeight)} لا يساوي 300 درجة. صحّح الأوزان قبل اعتماد القياس (BR-01).</span></div>` : ''}

      <div class="flash info">${icon('info', { size: 17 })}<span>
        تعديل الأوزان يعيد احتساب درجات <strong>البرامج القائمة</strong> فقط.
        البرامج المغلقة محفوظة بدرجتها النهائية ولا تتأثر.</span></div>

      ${section('شجرة المقياس', tree || emptyState('لا توجد أقسام بعد — ابدأ بإضافة قسم.', 'layers'), {
    actions: `<form method="post" action="/admin/metric/resync" class="inline">
          <button class="btn sec small">${icon('continuity', { size: 13 })} إعادة توليد مهام البرامج القائمة</button></form>`,
  })}

      ${section('إضافة قسم جديد', sectionForm())}`,
    { active: '/admin/metric', wide: true });
  });

  // ------------------------------ الأقسام ------------------------------
  router.post('/admin/metric/section', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const op = ctx.body.op;
    const back = '/admin/metric';

    if (op === 'delete') {
      const s = get('SELECT * FROM metric_sections WHERE id = ?', ctx.body.id);
      if (!s) return ctx.notFound();
      if (get('SELECT 1 FROM metric_axes WHERE section_id = ?', s.id)) {
        return ctx.redirect(back, 'احذف محاور القسم أولًا.', 'err');
      }
      run('DELETE FROM metric_sections WHERE id = ?', s.id);
      audit({ user: ctx.user, action: 'metric.section.delete', entityType: 'metric_section', entityId: s.id, before: s, ip: ctx.ip });
      return ctx.redirect(back, 'حُذف القسم.');
    }

    const code = String(ctx.body.code || '').trim();
    const name = String(ctx.body.name || '').trim();
    if (!CODE_RE.test(code) || !name) return ctx.redirect(back, 'الرمز أو الاسم غير صحيح.', 'err');
    const weight = Math.max(0, Math.min(300, num(ctx.body.weight, 0)));
    const sort = Math.max(0, Math.min(99, int(ctx.body.sort, 0)));

    if (op === 'update') {
      const s = get('SELECT * FROM metric_sections WHERE id = ?', ctx.body.id);
      if (!s) return ctx.notFound();
      if (get('SELECT 1 FROM metric_sections WHERE code = ? AND id <> ?', code, s.id)) {
        return ctx.redirect(back, 'الرمز مستخدم في قسم آخر.', 'err');
      }
      run('UPDATE metric_sections SET code = ?, name = ?, weight = ?, sort = ? WHERE id = ?', code, name, weight, sort, s.id);
      audit({ user: ctx.user, action: 'metric.section.update', entityType: 'metric_section', entityId: s.id, before: s, after: { code, name, weight, sort }, ip: ctx.ip });
      return ctx.redirect(back, 'حُدّث القسم.');
    }

    if (get('SELECT 1 FROM metric_sections WHERE code = ?', code)) {
      return ctx.redirect(back, 'الرمز مستخدم مسبقًا.', 'err');
    }
    const res = run('INSERT INTO metric_sections (code, name, weight, sort) VALUES (?, ?, ?, ?)', code, name, weight, sort);
    audit({ user: ctx.user, action: 'metric.section.create', entityType: 'metric_section', entityId: Number(res.lastInsertRowid), after: { code, name, weight }, ip: ctx.ip });
    return ctx.redirect(back, 'أُضيف القسم.');
  });

  // ------------------------------ المحاور ------------------------------
  router.post('/admin/metric/axis', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const op = ctx.body.op;
    const back = '/admin/metric';

    if (op === 'delete') {
      const a = get('SELECT * FROM metric_axes WHERE id = ?', ctx.body.id);
      if (!a) return ctx.notFound();
      if (get('SELECT 1 FROM indicators WHERE axis_id = ?', a.id)) {
        return ctx.redirect(back, 'احذف مؤشرات المحور أولًا.', 'err');
      }
      run('DELETE FROM metric_axes WHERE id = ?', a.id);
      audit({ user: ctx.user, action: 'metric.axis.delete', entityType: 'metric_axis', entityId: a.id, before: a, ip: ctx.ip });
      return ctx.redirect(back, 'حُذف المحور.');
    }

    const sectionId = int(ctx.body.section_id, 0);
    if (!get('SELECT 1 FROM metric_sections WHERE id = ?', sectionId)) {
      return ctx.redirect(back, 'القسم غير موجود.', 'err');
    }
    const code = String(ctx.body.code || '').trim();
    const name = String(ctx.body.name || '').trim();
    if (!CODE_RE.test(code) || !name) return ctx.redirect(back, 'الرمز أو الاسم غير صحيح.', 'err');
    const weight = Math.max(0, Math.min(300, num(ctx.body.weight, 0)));
    const sort = Math.max(0, Math.min(99, int(ctx.body.sort, 0)));

    if (op === 'update') {
      const a = get('SELECT * FROM metric_axes WHERE id = ?', ctx.body.id);
      if (!a) return ctx.notFound();
      if (get('SELECT 1 FROM metric_axes WHERE code = ? AND id <> ?', code, a.id)) {
        return ctx.redirect(back, 'الرمز مستخدم في محور آخر.', 'err');
      }
      run('UPDATE metric_axes SET section_id = ?, code = ?, name = ?, weight = ?, sort = ? WHERE id = ?',
        sectionId, code, name, weight, sort, a.id);
      audit({ user: ctx.user, action: 'metric.axis.update', entityType: 'metric_axis', entityId: a.id, before: a, after: { code, name, weight, sort }, ip: ctx.ip });
      return ctx.redirect(back, 'حُدّث المحور.');
    }

    if (get('SELECT 1 FROM metric_axes WHERE code = ?', code)) {
      return ctx.redirect(back, 'الرمز مستخدم مسبقًا.', 'err');
    }
    const res = run('INSERT INTO metric_axes (section_id, code, name, weight, sort) VALUES (?, ?, ?, ?, ?)',
      sectionId, code, name, weight, sort);
    audit({ user: ctx.user, action: 'metric.axis.create', entityType: 'metric_axis', entityId: Number(res.lastInsertRowid), after: { code, name, weight }, ip: ctx.ip });
    return ctx.redirect(back, 'أُضيف المحور.');
  });

  // ------------------------------ صفحة المؤشر ------------------------------
  router.get('/admin/metric/indicator/:id', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const ind = get('SELECT * FROM indicators WHERE id = ?', ctx.params.id);
    if (!ind) return ctx.notFound('المؤشر غير موجود.');
    const axis = get('SELECT * FROM metric_axes WHERE id = ?', ind.axis_id);
    const sec = axis ? get('SELECT * FROM metric_sections WHERE id = ?', axis.section_id) : null;
    const axesAll = all(`SELECT a.*, s.name AS section_name FROM metric_axes a
                          JOIN metric_sections s ON s.id = a.section_id ORDER BY s.sort, a.sort`);
    const usage = indicatorUsage(ind.id);
    const measured = isMeasured(usage);

    const items = all('SELECT * FROM checklist_items WHERE indicator_id = ? ORDER BY sort, id', ind.id);
    const questions = all('SELECT * FROM question_bank WHERE indicator_id = ? ORDER BY sort, id', ind.id);

    // --- قائمة التحقق ---
    const itemsPanel = section(`بنود التحقق (${items.length})`, `
      ${items.length ? `<div class="table-wrap"><table class="compact">
        <thead><tr><th>الرمز</th><th>نص البند</th><th>الوزن النسبي</th><th>الحالة</th><th>القياسات</th><th></th></tr></thead>
        <tbody>${items.map((it) => {
    const used = itemUsage(it.id);
    return `<tr${it.is_active ? '' : ' class="exempt-row"'}>
            <td><code>${esc(it.code)}</code></td>
            <td>${editBox(it.text, `
              <form method="post" action="/admin/metric/item">
                ${hidden('op', 'update')}${hidden('id', it.id)}
                ${field('نص البند', textarea('text', { value: it.text, rows: 2, required: true }))}
                <div class="form-grid">
                  ${field('الرمز', input('code', { value: it.code, required: true }))}
                  ${field('الوزن النسبي', input('weight', { type: 'number', value: it.weight, attrs: 'step="0.5" min="0.5" max="20"' }))}
                  ${field('الترتيب', input('sort', { type: 'number', value: it.sort, attrs: 'min="0" max="99"' }))}
                  ${field('الحالة', select('is_active', [{ value: '1', label: 'مفعّل' }, { value: '0', label: 'معطّل' }], String(it.is_active)))}
                </div>
                <button class="btn small">حفظ البند</button>
              </form>`)}</td>
            <td class="num">${fmtNum(it.weight)}</td>
            <td>${it.is_active ? badge('مفعّل', 'good') : badge('معطّل', 'muted')}</td>
            <td class="num">${used}</td>
            <td>${deleteButton('/admin/metric/item', it.id, used ? `قِيس ${used} مرة — عطّله بدل حذفه` : null)}</td>
          </tr>`;
  }).join('')}</tbody></table></div>` : emptyState('لا بنود تحقق — أضف البند الأول.', 'check')}

      ${editBox('إضافة بند تحقق', `
        <form method="post" action="/admin/metric/item">
          ${hidden('op', 'create')}${hidden('indicator_id', ind.id)}
          ${field('نص البند', textarea('text', { rows: 2, required: true, placeholder: 'مثال: القاعة نظيفة ومهيّأة قبل بدء الدرس' }))}
          <div class="form-grid">
            ${field('الرمز', input('code', { required: true, placeholder: 'C1' }))}
            ${field('الوزن النسبي', input('weight', { type: 'number', value: 1, attrs: 'step="0.5" min="0.5" max="20"' }))}
            ${field('الترتيب', input('sort', { type: 'number', value: items.length, attrs: 'min="0" max="99"' }))}
          </div>
          <button class="btn small">${icon('plus', { size: 13 })} إضافة البند</button>
        </form>`)}
      <p class="hint">النتيجة = مجموع (حالة البند × وزنه النسبي) ÷ مجموع الأوزان.
        متحقق 100% · جزئي 50% · غير متحقق 0% (BR-02).</p>`, { ico: 'check' });

    // --- بنك أسئلة الاستبانة ---
    const questionsPanel = section(`أسئلة الاستبانة (${questions.length})`, `
      ${questions.length ? table(['الرمز', 'نص السؤال', 'موضع القياس', 'الترتيب', ''],
    questions.map((q) => [
      `<code>${esc(q.code)}</code>`,
      editBox(q.text, `
          <form method="post" action="/admin/metric/question">
            ${hidden('op', 'update')}${hidden('id', q.id)}
            ${field('نص السؤال', textarea('text', { value: q.text, rows: 2, required: true }))}
            <div class="form-grid">
              ${field('الرمز', input('code', { value: q.code, required: true }))}
              ${field('موضع القياس', select('point', POINTS, q.point))}
              ${field('الترتيب', input('sort', { type: 'number', value: q.sort, attrs: 'min="0" max="99"' }))}
            </div>
            <button class="btn small">حفظ السؤال</button>
          </form>`),
      esc(POINTS.find((p) => p.value === q.point)?.label || q.point),
      `<span class="num">${q.sort}</span>`,
      deleteButton('/admin/metric/question', q.id, null),
    ])) : emptyState('لا أسئلة مرتبطة بهذا المؤشر.', 'survey')}

      ${editBox('إضافة سؤال', `
        <form method="post" action="/admin/metric/question">
          ${hidden('op', 'create')}${hidden('indicator_id', ind.id)}
          ${field('نص السؤال', textarea('text', { rows: 2, required: true, placeholder: 'يُقاس بمقياس ليكرت من 5 درجات' }))}
          <div class="form-grid">
            ${field('الرمز', input('code', { required: true, placeholder: 'Q1' }))}
            ${field('موضع القياس', select('point', POINTS, 'end'))}
            ${field('الترتيب', input('sort', { type: 'number', value: questions.length, attrs: 'min="0" max="99"' }))}
          </div>
          <button class="btn small">${icon('plus', { size: 13 })} إضافة السؤال</button>
        </form>`)}
      <p class="hint">النتيجة = (متوسط الإجابات − 1) ÷ 4 × 100 (BR-03).
        ولا تُربط أسئلة الاستبانة إلا بمؤشرات أداتها «استبانة» (BR-12).</p>`, { ico: 'survey' });

    // --- السجل التشغيلي ---
    const recordPanel = section('قاعدة الحساب التشغيلية', `
      <form method="post" action="/admin/metric/indicator">
        ${hidden('op', 'update')}${hidden('id', ind.id)}${hidden('only', 'record_rule')}
        ${field('القاعدة', select('record_rule', RECORD_RULES, ind.record_rule, { placeholder: 'بلا قاعدة (لن يُحتسب)' }))}
        <button class="btn small">حفظ القاعدة</button>
      </form>
      <p class="hint">هذه القواعد مطبّقة في محرك الاحتساب: النظام يقرأ سجل الحضور أو الشكاوى
        أو الطلاب مباشرة ويحسب النسبة، فلا يحتاج المؤشر إلى إدخال يدوي.</p>`, { ico: 'metric' });

    ctx.render(ind.name, `
      <div class="crumbs"><a href="/admin">مركز الإدارة</a> ← <a href="/admin/metric">بنية المقياس</a>
        ← ${esc(sec?.name || '')} / ${esc(axis?.name || '')}</div>
      <div class="pagehead"><div>
        ${pageTitle(ind.name, { ico: 'target', extra: ind.is_active ? badge('مفعّل', 'good') : badge('معطّل', 'muted') })}
        <p class="meta"><code>${esc(ind.code)}</code> · ${esc(TOOL_LABEL[ind.tool] || ind.tool)} ·
          مالك المؤشر: ${esc(roleName(ind.owner_role))} · ${esc(samplePlanLabel(ind))}</p>
      </div><div>${deleteButton('/admin/metric/indicator', ind.id,
    measured ? 'قِيس فعلًا — عطّله بدل حذفه' : null)}</div></div>

      <div class="stats">
        ${statCard({ label: 'الوزن', value: fmtNum(ind.weight), ico: 'scale', sub: 'من 300 درجة' })}
        ${statCard({ label: 'قياسات مسجّلة', value: usage.verifications, ico: 'check', tone: usage.verifications ? 'info' : '' })}
        ${statCard({ label: 'مهام مرتبطة', value: usage.tasks, ico: 'tasks' })}
        ${statCard({ label: 'استثناءات غير منطبق', value: usage.exemptions, ico: 'alert', tone: usage.exemptions ? 'warn' : '' })}
      </div>

      ${measured ? `<div class="flash info">${icon('info', { size: 17 })}<span>
        هذا المؤشر قِيس فعلًا. تعديل وزنه يعيد احتساب درجات البرامج القائمة،
        وتغيير أداته أو دوريته يُلغي مهامه المعلّقة ويولّد غيرها.</span></div>` : ''}

      ${section('تعريف المؤشر', `
        <form method="post" action="/admin/metric/indicator">
          ${hidden('op', 'update')}${hidden('id', ind.id)}
          <div class="form-grid">
            ${field('الرمز', input('code', { value: ind.code, required: true }))}
            ${field('اسم المؤشر', input('name', { value: ind.name, required: true }))}
            ${field('المحور', select('axis_id', axesAll.map((a) => ({ value: a.id, label: `${a.section_name} / ${a.name}` })), ind.axis_id))}
            ${field('الوزن', input('weight', { type: 'number', value: ind.weight, required: true, attrs: 'step="0.5" min="0" max="300"' }))}
            ${field('أداة القياس', select('tool', TOOLS, ind.tool))}
            ${field('الدور المسؤول (مالك المؤشر)', select('owner_role', activeRoles().map((r) => ({ value: r.key, label: r.name })), ind.owner_role))}
            ${field('الدورية', select('periodicity', PERIODICITY, ind.periodicity))}
            ${field('نسبة العينة %', input('sample_pct', { type: 'number', value: ind.sample_pct ?? '', attrs: 'min="0" max="100"' }), 'تُترك فارغة لغير العينات')}
            ${field('الحد الأدنى للقياسات', input('min_count', { type: 'number', value: ind.min_count ?? '', attrs: 'min="0" max="200"' }))}
            ${field('الترتيب', input('sort', { type: 'number', value: ind.sort, attrs: 'min="0" max="999"' }))}
            ${field('الحالة', select('is_active', [{ value: '1', label: 'مفعّل' }, { value: '0', label: 'معطّل' }], String(ind.is_active)))}
          </div>
          ${field('الوصف', textarea('description', { value: ind.description || '', rows: 2 }))}
          <button class="btn">حفظ المؤشر</button>
        </form>`, { ico: 'target' })}

      ${ind.tool === 'checklist' ? itemsPanel : ''}
      ${ind.tool === 'survey' ? questionsPanel : ''}
      ${ind.tool === 'record' ? recordPanel : ''}`,
    { active: '/admin/metric', wide: true });
  });

  // ------------------------------ المؤشرات ------------------------------
  router.post('/admin/metric/indicator', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const op = ctx.body.op || 'update';

    if (op === 'delete') {
      const ind = get('SELECT * FROM indicators WHERE id = ?', ctx.body.id);
      if (!ind) return ctx.notFound();
      if (isMeasured(indicatorUsage(ind.id))) {
        return ctx.redirect(`/admin/metric/indicator/${ind.id}`,
          'المؤشر قِيس فعلًا — لا يُحذف حتى لا تضيع سجلاته. عطّله بدل ذلك.', 'err');
      }
      run('DELETE FROM indicators WHERE id = ?', ind.id);
      audit({ user: ctx.user, action: 'metric.indicator.delete', entityType: 'indicator', entityId: ind.id, before: ind, ip: ctx.ip });
      return ctx.redirect('/admin/metric', 'حُذف المؤشر.');
    }

    if (op === 'create') {
      const axisId = int(ctx.body.axis_id, 0);
      if (!get('SELECT 1 FROM metric_axes WHERE id = ?', axisId)) {
        return ctx.redirect('/admin/metric', 'المحور غير موجود.', 'err');
      }
      const code = String(ctx.body.code || '').trim();
      const name = String(ctx.body.name || '').trim();
      if (!CODE_RE.test(code) || !name) return ctx.redirect('/admin/metric', 'الرمز أو الاسم غير صحيح.', 'err');
      if (get('SELECT 1 FROM indicators WHERE code = ?', code)) {
        return ctx.redirect('/admin/metric', 'رمز المؤشر مستخدم مسبقًا.', 'err');
      }
      const tool = TOOLS.some((t) => t.value === ctx.body.tool) ? ctx.body.tool : 'checklist';
      const owner = roleKeys().includes(ctx.body.owner_role) ? ctx.body.owner_role : roleKeys()[0];
      const periodicity = PERIODICITY.some((p) => p.value === ctx.body.periodicity) ? ctx.body.periodicity : 'end';
      const weight = Math.max(0, Math.min(300, num(ctx.body.weight, 0)));
      const sort = Number(get('SELECT COALESCE(MAX(sort), 0) + 1 s FROM indicators WHERE axis_id = ?', axisId)?.s || 0);
      const res = run(
        `INSERT INTO indicators (axis_id, code, name, weight, tool, owner_role, periodicity, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        axisId, code, name, weight, tool, owner, periodicity, sort,
      );
      audit({ user: ctx.user, action: 'metric.indicator.create', entityType: 'indicator', entityId: Number(res.lastInsertRowid), after: { code, name, weight, tool, owner }, ip: ctx.ip });
      return ctx.redirect(`/admin/metric/indicator/${Number(res.lastInsertRowid)}`,
        'أُضيف المؤشر. أكمل خطة العينة وبنوده.');
    }

    // --- تحديث ---
    const ind = get('SELECT * FROM indicators WHERE id = ?', ctx.body.id);
    if (!ind) return ctx.notFound();
    const back = `/admin/metric/indicator/${ind.id}`;

    // حفظ حقل واحد فقط (نموذج قاعدة الحساب)
    if (ctx.body.only === 'record_rule') {
      const rule = RECORD_RULES.some((r) => r.value === ctx.body.record_rule) ? ctx.body.record_rule : null;
      run('UPDATE indicators SET record_rule = ? WHERE id = ?', rule, ind.id);
      audit({ user: ctx.user, action: 'metric.indicator.update', entityType: 'indicator', entityId: ind.id, before: { record_rule: ind.record_rule }, after: { record_rule: rule }, ip: ctx.ip });
      return ctx.redirect(back, 'حُدّثت قاعدة الحساب.');
    }

    const code = String(ctx.body.code ?? ind.code).trim();
    const name = String(ctx.body.name ?? ind.name).trim();
    if (!CODE_RE.test(code) || !name) return ctx.redirect(back, 'الرمز أو الاسم غير صحيح.', 'err');
    if (get('SELECT 1 FROM indicators WHERE code = ? AND id <> ?', code, ind.id)) {
      return ctx.redirect(back, 'الرمز مستخدم في مؤشر آخر.', 'err');
    }
    const axisId = ctx.body.axis_id === undefined ? ind.axis_id : int(ctx.body.axis_id, ind.axis_id);
    if (!get('SELECT 1 FROM metric_axes WHERE id = ?', axisId)) return ctx.redirect(back, 'المحور غير موجود.', 'err');

    const weight = Math.max(0, Math.min(300, num(ctx.body.weight, ind.weight)));
    const tool = TOOLS.some((t) => t.value === ctx.body.tool) ? ctx.body.tool : ind.tool;
    const owner = roleKeys().includes(ctx.body.owner_role) ? ctx.body.owner_role : ind.owner_role;
    const periodicity = PERIODICITY.some((p) => p.value === ctx.body.periodicity) ? ctx.body.periodicity : ind.periodicity;
    const samplePct = ctx.body.sample_pct === '' ? null : Math.max(0, Math.min(100, num(ctx.body.sample_pct, 0)));
    const minCount = ctx.body.min_count === '' ? null : Math.max(0, Math.min(200, int(ctx.body.min_count, 0)));
    const sort = Math.max(0, Math.min(999, int(ctx.body.sort, ind.sort)));
    const active = ctx.body.is_active === '0' ? 0 : 1;
    const description = ctx.body.description === undefined ? ind.description : String(ctx.body.description).trim() || null;

    // BR-12: تحويل المؤشر عن «استبانة» يفكّ ارتباط أسئلته، فلا يبقى سؤال معلّقًا بمؤشر لا يُقاس بها
    if (tool !== 'survey' && ind.tool === 'survey') {
      run('UPDATE question_bank SET indicator_id = NULL WHERE indicator_id = ?', ind.id);
    }

    run(`UPDATE indicators SET axis_id = ?, code = ?, name = ?, weight = ?, tool = ?, owner_role = ?,
           periodicity = ?, sample_pct = ?, min_count = ?, sort = ?, is_active = ?, description = ?
         WHERE id = ?`,
    axisId, code, name, weight, tool, owner, periodicity, samplePct, minCount, sort, active, description, ind.id);

    audit({
      user: ctx.user, action: 'metric.indicator.update', entityType: 'indicator', entityId: ind.id,
      before: { code: ind.code, weight: ind.weight, tool: ind.tool, owner_role: ind.owner_role, periodicity: ind.periodicity, is_active: ind.is_active },
      after: { code, weight, tool, owner_role: owner, periodicity, is_active: active }, ip: ctx.ip,
    });
    return ctx.redirect(back, 'حُدّث المؤشر. أعد توليد المهام لتطبيق التغيير على البرامج القائمة.');
  });

  // ------------------------------ بنود التحقق ------------------------------
  router.post('/admin/metric/item', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const op = ctx.body.op;

    if (op === 'delete') {
      const it = get('SELECT * FROM checklist_items WHERE id = ?', ctx.body.id);
      if (!it) return ctx.notFound();
      const back = `/admin/metric/indicator/${it.indicator_id}`;
      if (itemUsage(it.id)) {
        return ctx.redirect(back, 'البند مستخدم في قياسات مسجّلة — عطّله بدل حذفه حتى لا تضيع سجلاته.', 'err');
      }
      run('DELETE FROM checklist_items WHERE id = ?', it.id);
      audit({ user: ctx.user, action: 'metric.item.delete', entityType: 'checklist_item', entityId: it.id, before: it, ip: ctx.ip });
      return ctx.redirect(back, 'حُذف البند.');
    }

    const text = String(ctx.body.text || '').trim();
    const code = String(ctx.body.code || '').trim();
    if (!text || !CODE_RE.test(code)) return ctx.redirect('/admin/metric', 'نص البند أو رمزه غير صحيح.', 'err');
    const weight = Math.max(0.5, Math.min(20, num(ctx.body.weight, 1)));
    const sort = Math.max(0, Math.min(99, int(ctx.body.sort, 0)));

    if (op === 'update') {
      const it = get('SELECT * FROM checklist_items WHERE id = ?', ctx.body.id);
      if (!it) return ctx.notFound();
      const back = `/admin/metric/indicator/${it.indicator_id}`;
      if (get('SELECT 1 FROM checklist_items WHERE indicator_id = ? AND code = ? AND id <> ?', it.indicator_id, code, it.id)) {
        return ctx.redirect(back, 'الرمز مستخدم في بند آخر لنفس المؤشر.', 'err');
      }
      const active = ctx.body.is_active === '0' ? 0 : 1;
      run('UPDATE checklist_items SET code = ?, text = ?, weight = ?, sort = ?, is_active = ? WHERE id = ?',
        code, text, weight, sort, active, it.id);
      audit({ user: ctx.user, action: 'metric.item.update', entityType: 'checklist_item', entityId: it.id, before: it, after: { code, text, weight, is_active: active }, ip: ctx.ip });
      return ctx.redirect(back, 'حُدّث البند.');
    }

    const indicatorId = int(ctx.body.indicator_id, 0);
    const ind = get('SELECT * FROM indicators WHERE id = ?', indicatorId);
    if (!ind) return ctx.redirect('/admin/metric', 'المؤشر غير موجود.', 'err');
    const back = `/admin/metric/indicator/${ind.id}`;
    if (ind.tool !== 'checklist') return ctx.redirect(back, 'بنود التحقق لمؤشرات قوائم التحقق فقط.', 'err');
    if (get('SELECT 1 FROM checklist_items WHERE indicator_id = ? AND code = ?', ind.id, code)) {
      return ctx.redirect(back, 'الرمز مستخدم مسبقًا في هذا المؤشر.', 'err');
    }
    const res = run('INSERT INTO checklist_items (indicator_id, code, text, weight, sort) VALUES (?, ?, ?, ?, ?)',
      ind.id, code, text, weight, sort);
    audit({ user: ctx.user, action: 'metric.item.create', entityType: 'checklist_item', entityId: Number(res.lastInsertRowid), after: { code, text, weight }, ip: ctx.ip });
    return ctx.redirect(back, 'أُضيف البند.');
  });

  // ------------------------------ أسئلة الاستبانات ------------------------------
  router.post('/admin/metric/question', (ctx) => {
    if (!isManager(ctx.user)) return ctx.deny();
    const op = ctx.body.op;

    if (op === 'delete') {
      const q = get('SELECT * FROM question_bank WHERE id = ?', ctx.body.id);
      if (!q) return ctx.notFound();
      run('DELETE FROM question_bank WHERE id = ?', q.id);
      audit({ user: ctx.user, action: 'metric.question.delete', entityType: 'question_bank', entityId: q.id, before: q, ip: ctx.ip });
      return ctx.redirect(q.indicator_id ? `/admin/metric/indicator/${q.indicator_id}` : '/admin/metric',
        'حُذف السؤال من البنك. الاستبانات المنشأة سابقًا لا تتأثر.');
    }

    const text = String(ctx.body.text || '').trim();
    const code = String(ctx.body.code || '').trim();
    if (!text || !CODE_RE.test(code)) return ctx.redirect('/admin/metric', 'نص السؤال أو رمزه غير صحيح.', 'err');
    const point = POINTS.some((p) => p.value === ctx.body.point) ? ctx.body.point : 'end';
    const sort = Math.max(0, Math.min(99, int(ctx.body.sort, 0)));

    if (op === 'update') {
      const q = get('SELECT * FROM question_bank WHERE id = ?', ctx.body.id);
      if (!q) return ctx.notFound();
      const back = q.indicator_id ? `/admin/metric/indicator/${q.indicator_id}` : '/admin/metric';
      if (get('SELECT 1 FROM question_bank WHERE code = ? AND id <> ?', code, q.id)) {
        return ctx.redirect(back, 'رمز السؤال مستخدم مسبقًا.', 'err');
      }
      run('UPDATE question_bank SET code = ?, text = ?, point = ?, sort = ? WHERE id = ?', code, text, point, sort, q.id);
      audit({ user: ctx.user, action: 'metric.question.update', entityType: 'question_bank', entityId: q.id, before: q, after: { code, text, point }, ip: ctx.ip });
      return ctx.redirect(back, 'حُدّث السؤال.');
    }

    const ind = get('SELECT * FROM indicators WHERE id = ?', int(ctx.body.indicator_id, 0));
    if (!ind) return ctx.redirect('/admin/metric', 'المؤشر غير موجود.', 'err');
    const back = `/admin/metric/indicator/${ind.id}`;
    // BR-12: لا يُبنى سؤال استبانة إلا على مؤشر أداته استبانة
    if (ind.tool !== 'survey') {
      return ctx.redirect(back, 'لا تُربط أسئلة الاستبانة إلا بمؤشرات أداتها «استبانة» (BR-12).', 'err');
    }
    if (get('SELECT 1 FROM question_bank WHERE code = ?', code)) {
      return ctx.redirect(back, 'رمز السؤال مستخدم مسبقًا.', 'err');
    }
    const res = run('INSERT INTO question_bank (code, text, indicator_id, point, sort) VALUES (?, ?, ?, ?, ?)',
      code, text, ind.id, point, sort);
    audit({ user: ctx.user, action: 'metric.question.create', entityType: 'question_bank', entityId: Number(res.lastInsertRowid), after: { code, text, point, indicator: ind.code }, ip: ctx.ip });
    return ctx.redirect(back, 'أُضيف السؤال إلى البنك.');
  });

  // ------------------------------ إعادة التوليد ------------------------------
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
}

export { TOOLS, PERIODICITY, RECORD_RULES, RULE_LABEL, TOOL_LABEL, POINTS };
