import { all, get, run } from '../db/index.js';
import { esc, fmtDate, fmtNum, token, int } from '../lib/util.js';
import { table, section, statusBadge, badge, progress, field, input, textarea, statCard } from '../views/ui.js';
import { bare } from '../views/layout.js';
import { html } from '../lib/http.js';
import { can } from '../lib/roles.js';
import { likertToPct } from '../lib/scoring.js';
import { audit } from '../lib/audit.js';
import { refreshNotifications } from '../lib/scheduler.js';
import { LIKERT } from '../db/framework.js';
import { loadProgram, programHead } from './_helpers.js';
import { canAccessProgram, programPerms } from '../lib/auth.js';

const POINT_LABEL = { mid: 'منتصف البرنامج', end: 'نهاية البرنامج', activity: 'بعد النشاط الرئيس' };

/** نقطة القياس المشتقة من دورية المؤشر وترتيب المهمة. */
function pointForTask(indicator, task) {
  if (indicator.periodicity === 'per_main_activity') return 'activity';
  if (indicator.periodicity === 'mid') return 'mid';
  if (indicator.periodicity === 'end') return 'end';
  if (indicator.periodicity === 'mid_end') return task.seq === 1 ? 'mid' : 'end';
  return 'end';
}

/** نتائج استبانة: متوسط كل سؤال محوّلًا إلى نسبة (BR-03). */
function surveyResults(surveyId) {
  const questions = all(
    `SELECT q.*, i.name AS indicator_name,
            AVG(a.value) AS avg_value, COUNT(a.id) AS answers
       FROM survey_questions q
       LEFT JOIN survey_answers a ON a.question_id = q.id
       LEFT JOIN indicators i ON i.id = q.indicator_id
      WHERE q.survey_id = ? GROUP BY q.id ORDER BY q.sort, q.id`, surveyId,
  );
  const responses = Number(get('SELECT COUNT(*) c FROM survey_responses WHERE survey_id = ?', surveyId)?.c || 0);
  const withData = questions.filter((q) => q.answers > 0);
  const overall = withData.length
    ? withData.reduce((s, q) => s + likertToPct(q.avg_value), 0) / withData.length
    : null;
  return { questions, responses, overall };
}

export default function register(router) {
  // قائمة استبانات البرنامج
  router.get('/programs/:id/surveys', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program } = loaded;
    const rows = all(
      `SELECT s.*, i.name AS indicator_name,
              (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS responses
         FROM surveys s
         LEFT JOIN tasks t ON t.id = s.task_id
         LEFT JOIN indicators i ON i.id = t.indicator_id
        WHERE s.program_id = ? ORDER BY s.id DESC`, program.id,
    );
    const pending = all(
      `SELECT t.*, i.name AS indicator_name FROM tasks t JOIN indicators i ON i.id = t.indicator_id
        WHERE t.program_id = ? AND t.kind = 'survey' AND t.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM surveys s WHERE s.task_id = t.id)
        ORDER BY t.due_date`, program.id,
    );
    ctx.render('الاستبانات', programHead(program, 'surveys') + `
      ${section('الاستبانات', table(['الاستبانة', 'نقطة القياس', 'المؤشر', 'الحالة', 'الاستجابات', 'النتيجة', ''],
        rows.map((s) => {
          const r = surveyResults(s.id);
          return [
            esc(s.title), esc(POINT_LABEL[s.point] || s.point), esc(s.indicator_name || '—'),
            statusBadge(s.status === 'open' ? 'in_progress' : s.status === 'closed' ? 'done' : 'draft'),
            `<span class="num">${s.responses}</span>`,
            progress(r.overall), `<a class="btn sec small" href="/surveys/${s.id}">فتح</a>`,
          ];
        }), { empty: 'لم تُنشأ استبانات بعد.' }))}
      ${section('استبانات مجدولة بانتظار التوليد', table(['المهمة', 'المؤشر', 'الاستحقاق', ''],
        pending.map((t) => [
          esc(t.title), esc(t.indicator_name), fmtDate(t.due_date),
          `<form method="post" action="/surveys/create" class="inline">
             <input type="hidden" name="task_id" value="${t.id}">
             <button class="btn small">توليد</button></form>`,
        ]), { empty: 'لا توجد استبانات مجدولة معلّقة.' }))}`, { active: '/programs' });
  });

  // توليد استبانة من مهمة
  router.post('/surveys/create', (ctx) => {
    const task = get('SELECT * FROM tasks WHERE id = ?', ctx.body.task_id);
    if (!task) return ctx.notFound('المهمة غير موجودة.');
    if (!canAccessProgram(ctx.user, task.program_id)) return ctx.deny();
    const perms = programPerms(ctx.user, task.program_id);
    if (!(can(perms, 'survey.manage.teacher') || can(perms, 'survey.manage.experience') || can(perms, '*'))) {
      return ctx.deny('إدارة الاستبانات من صلاحية مسؤول الجودة أو مسؤول الجودة العلمية.');
    }
    const existing = get('SELECT * FROM surveys WHERE task_id = ?', task.id);
    if (existing) { ctx.redirect(`/surveys/${existing.id}`); return; }

    const indicator = get('SELECT * FROM indicators WHERE id = ?', task.indicator_id);
    if (!indicator || indicator.tool !== 'survey') return ctx.deny('هذا المؤشر لا يُقاس باستبانة.');
    const point = pointForTask(indicator, task);
    const activity = task.activity_id ? get('SELECT * FROM activities WHERE id = ?', task.activity_id) : null;
    const title = activity
      ? `استبانة فاعلية النشاط: ${activity.name}`
      : `${indicator.name} — ${POINT_LABEL[point]}`;

    const res = run(
      `INSERT INTO surveys (task_id, program_id, title, point, activity_id, token, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`,
      task.id, task.program_id, title, point, task.activity_id || null, token(16), ctx.user.id,
    );
    const surveyId = Number(res.lastInsertRowid);

    // BR-12: الأسئلة تُبنى فقط من مؤشرات تُقاس بالاستبانة، فلا يحكم الطالب على السلامة العلمية.
    const bank = all(
      'SELECT * FROM question_bank WHERE indicator_id = ? AND point = ? ORDER BY sort',
      indicator.id, point,
    );
    bank.forEach((q, idx) => {
      run('INSERT INTO survey_questions (survey_id, code, text, indicator_id, sort) VALUES (?, ?, ?, ?, ?)',
        surveyId, q.code, q.text, q.indicator_id, idx + 1);
    });
    run("UPDATE tasks SET ref_type = 'survey', ref_id = ? WHERE id = ?", surveyId, task.id);
    audit({ user: ctx.user, action: 'survey.create', entityType: 'survey', entityId: surveyId, programId: task.program_id, after: { title, point, questions: bank.length }, ip: ctx.ip });
    ctx.redirect(`/surveys/${surveyId}`, `أُنشئت الاستبانة بـ${bank.length} أسئلة.`);
  });

  // إدارة استبانة
  router.get('/surveys/:sid', (ctx) => {
    const survey = get(
      `SELECT s.*, p.name AS program_name, p.status AS program_status
         FROM surveys s JOIN programs p ON p.id = s.program_id WHERE s.id = ?`, ctx.params.sid,
    );
    if (!survey) return ctx.notFound();
    if (!canAccessProgram(ctx.user, survey.program_id)) return ctx.deny();
    const perms = programPerms(ctx.user, survey.program_id);
    const editable = (can(perms, 'survey.manage.teacher') || can(perms, 'survey.manage.experience') || can(perms, '*'))
      && survey.program_status !== 'closed';
    const r = surveyResults(survey.id);
    const link = `${ctx.url.origin}/s/${survey.token}`;

    ctx.render(survey.title, `
      <div class="crumbs"><a href="/programs/${survey.program_id}/surveys">${esc(survey.program_name)} — الاستبانات</a></div>
      <div class="pagehead"><div>
        <h1>${esc(survey.title)}</h1>
        <p class="meta">${esc(POINT_LABEL[survey.point] || survey.point)} ·
          ${survey.status === 'open' ? badge('مفتوحة للتوزيع', 'good') : survey.status === 'closed' ? badge('مغلقة', 'muted') : badge('مسودة', 'warn')}
          · ${r.responses} استجابة</p>
      </div></div>

      <div class="stats">
        ${statCard({ label: 'الاستجابات', value: r.responses })}
        ${statCard({ label: 'النتيجة (BR-03)', value: r.overall === null ? '—' : `${fmtNum(r.overall)}%`, tone: 'info', sub: '(المتوسط − 1) ÷ 4 × 100' })}
        ${statCard({ label: 'عدد الأسئلة', value: r.questions.length })}
      </div>

      ${section('رابط التوزيع', survey.status === 'open'
        ? `<p><code>${esc(link)}</code></p>
           <p><button class="btn sec small" data-copy="${esc(link)}">نسخ الرابط</button>
           <a class="btn sec small" href="/s/${esc(survey.token)}" target="_blank" rel="noopener">معاينة</a></p>
           <p class="hint">الرابط عام ولا يتطلب تسجيل دخول؛ تُجمع الاستجابات دون ربطها بهوية الطالب.</p>`
        : survey.status === 'draft'
          ? '<p class="empty">الاستبانة مسودة — افتحها للتوزيع لتفعيل الرابط.</p>'
          : '<p class="empty">الاستبانة مغلقة ولم تعد تستقبل استجابات.</p>')}

      ${editable ? section('إدارة الاستبانة', `
        <div class="row-form">
          ${survey.status !== 'open' && survey.status !== 'closed' ? `<form method="post" action="/surveys/${survey.id}/open" class="inline"><button class="btn">فتح للتوزيع</button></form>` : ''}
          ${survey.status === 'open' ? `<form method="post" action="/surveys/${survey.id}/close" class="inline" data-confirm="إغلاق الاستبانة واعتماد النتيجة؟"><button class="btn">إغلاق واعتماد النتيجة</button></form>` : ''}
        </div>
        ${survey.status === 'draft' ? `
        <form method="post" action="/surveys/${survey.id}/questions" class="row-form">
          ${input('text', { placeholder: 'إضافة سؤال مخصص', required: true })}
          <button class="btn small sec">إضافة سؤال</button>
        </form>
        <p class="hint">الأسئلة المخصصة لا تُحتسب ضمن المؤشر ما لم تُربط به من مكتبة الأسئلة.</p>` : ''}`) : ''}

      ${section('الأسئلة والنتائج', table(['الرمز', 'السؤال', 'المؤشر', 'الاستجابات', 'المتوسط', 'النسبة'],
        r.questions.map((q) => [
          `<code>${esc(q.code)}</code>`, esc(q.text), esc(q.indicator_name || '—'),
          `<span class="num">${q.answers || 0}</span>`,
          `<span class="num">${q.avg_value ? fmtNum(q.avg_value, 2) : '—'}</span>`,
          q.answers ? progress(likertToPct(q.avg_value)) : '<span class="muted">—</span>',
        ]), { empty: 'لا توجد أسئلة.' }))}`, { active: '/programs' });
  });

  router.post('/surveys/:sid/questions', (ctx) => {
    const survey = get('SELECT * FROM surveys WHERE id = ?', ctx.params.sid);
    if (!survey) return ctx.notFound();
    if (!canAccessProgram(ctx.user, survey.program_id)) return ctx.deny();
    if (survey.status !== 'draft') return ctx.redirect(`/surveys/${survey.id}`, 'لا يمكن تعديل أسئلة استبانة مفتوحة أو مغلقة.', 'err');
    const text = String(ctx.body.text || '').trim();
    if (!text) return ctx.redirect(`/surveys/${survey.id}`, 'نص السؤال مطلوب.', 'err');
    const n = Number(get('SELECT COUNT(*) c FROM survey_questions WHERE survey_id = ?', survey.id).c) + 1;
    run('INSERT INTO survey_questions (survey_id, code, text, sort) VALUES (?, ?, ?, ?)',
      survey.id, `Q-X${n}`, text, n);
    audit({ user: ctx.user, action: 'survey.question.add', entityType: 'survey', entityId: survey.id, programId: survey.program_id, after: { text }, ip: ctx.ip });
    ctx.redirect(`/surveys/${survey.id}`, 'أُضيف السؤال.');
  });

  router.post('/surveys/:sid/open', (ctx) => {
    const survey = get('SELECT * FROM surveys WHERE id = ?', ctx.params.sid);
    if (!survey) return ctx.notFound();
    if (!canAccessProgram(ctx.user, survey.program_id)) return ctx.deny();
    const count = Number(get('SELECT COUNT(*) c FROM survey_questions WHERE survey_id = ?', survey.id).c);
    if (!count) return ctx.redirect(`/surveys/${survey.id}`, 'لا يمكن فتح استبانة بلا أسئلة.', 'err');
    run("UPDATE surveys SET status = 'open', opened_at = datetime('now') WHERE id = ?", survey.id);
    audit({ user: ctx.user, action: 'survey.open', entityType: 'survey', entityId: survey.id, programId: survey.program_id, ip: ctx.ip });
    ctx.redirect(`/surveys/${survey.id}`, 'فُتحت الاستبانة — وزّع الرابط على الطلاب.');
  });

  router.post('/surveys/:sid/close', (ctx) => {
    const survey = get('SELECT * FROM surveys WHERE id = ?', ctx.params.sid);
    if (!survey) return ctx.notFound();
    if (!canAccessProgram(ctx.user, survey.program_id)) return ctx.deny();
    run("UPDATE surveys SET status = 'closed', closed_at = datetime('now') WHERE id = ?", survey.id);
    if (survey.task_id) {
      run("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ?", survey.task_id);
    }
    const r = surveyResults(survey.id);
    audit({ user: ctx.user, action: 'survey.close', entityType: 'survey', entityId: survey.id, programId: survey.program_id, after: { responses: r.responses, result_pct: r.overall }, ip: ctx.ip });
    refreshNotifications({ programId: survey.program_id });
    ctx.redirect(`/surveys/${survey.id}`, `أُغلقت الاستبانة — النتيجة ${r.overall === null ? '—' : `${fmtNum(r.overall)}%`}.`);
  });

  // ------------------------------ الصفحة العامة للطالب ------------------
  router.get('/s/:token', (ctx) => {
    const survey = get('SELECT * FROM surveys WHERE token = ?', ctx.params.token);
    if (!survey || survey.status !== 'open') {
      html(ctx.res, bare({
        title: 'الاستبانة',
        body: `<div class="login-card"><h1>الاستبانة غير متاحة</h1>
          <p class="sub">الرابط غير صحيح أو أُغلقت الاستبانة.</p></div>`,
      }), 404);
      return;
    }
    const questions = all('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort, id', survey.id);
    html(ctx.res, bare({
      title: survey.title,
      body: `<div class="login-card">
        <h1>${esc(survey.title)}</h1>
        <p class="sub">جمعية تحصيل المعرفة — استبانة تجربة الطالب</p>
        <form method="post" action="/s/${esc(survey.token)}">
          ${questions.map((q, i) => `<div class="check-item">
            <div class="text">${i + 1}. ${esc(q.text)}</div>
            <div class="likert">${LIKERT.map((l) => `<label>
              <input type="radio" name="q_${q.id}" value="${l.value}" required> ${esc(l.label)}</label>`).join('')}</div>
          </div>`).join('')}
          <label class="field"><span class="field-label">ملاحظات أو مقترحات (اختياري)</span>
            ${textarea('comment', { rows: 3 })}</label>
          <button class="btn" style="width:100%">إرسال</button>
        </form>
        <p class="demo-list">إجاباتك سرية ولا تُربط باسمك، وتُستخدم لتحسين البرنامج.</p>
      </div>`,
    }));
  });

  router.post('/s/:token', (ctx) => {
    const survey = get('SELECT * FROM surveys WHERE token = ?', ctx.params.token);
    if (!survey || survey.status !== 'open') return ctx.notFound('الاستبانة غير متاحة.');
    const questions = all('SELECT * FROM survey_questions WHERE survey_id = ?', survey.id);
    const answers = [];
    for (const q of questions) {
      const v = int(ctx.body[`q_${q.id}`], 0);
      if (v >= 1 && v <= 5) answers.push({ q, v });
    }
    if (!answers.length) return ctx.notFound('لم تُستلم أي إجابة.');

    const res = run('INSERT INTO survey_responses (survey_id, respondent_key) VALUES (?, ?)', survey.id, token(8));
    const responseId = Number(res.lastInsertRowid);
    for (const a of answers) {
      run('INSERT INTO survey_answers (response_id, question_id, value) VALUES (?, ?, ?)', responseId, a.q.id, a.v);
    }
    const comment = String(ctx.body.comment || '').trim();
    if (comment) {
      run(`INSERT INTO complaints (program_id, ref_code, kind, source, title, body, sla_days, due_date, status)
           VALUES (?, ?, 'suggestion', 'استبانة', ?, ?, 5, date('now','+5 day'), 'open')`,
        survey.program_id, `S-${responseId}`,
        `ملاحظة من استبانة: ${survey.title}`.slice(0, 180), comment);
    }
    html(ctx.res, bare({
      title: 'شكرًا لك',
      body: `<div class="login-card"><h1>شكرًا لك</h1>
        <p class="sub">تم استلام إجابتك بنجاح. رأيك يسهم في تحسين برامج الجمعية.</p></div>`,
    }));
  });
}
