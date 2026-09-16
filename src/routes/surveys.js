import { all, get, run } from '../db/index.js';
import { esc, fmtDate, fmtNum, token, int, toCsv } from '../lib/util.js';
import { table, section, statusBadge, badge, progress, input, textarea, statCard } from '../views/ui.js';
import { bare } from '../views/layout.js';
import { html, send } from '../lib/http.js';
import { can } from '../lib/roles.js';
import { likertToPct, minResponseRate, responseRate } from '../lib/scoring.js';
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

/** نتائج استبانة: متوسط كل سؤال محوّلًا إلى نسبة (BR-03) + نسبة الاستجابة. */
function surveyResults(surveyId) {
  const survey = get('SELECT * FROM surveys WHERE id = ?', surveyId);
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
  const threshold = minResponseRate();
  const rate = survey ? responseRate(survey, responses) : null;
  return {
    questions,
    responses,
    overall,
    rate,
    threshold,
    target: Number(survey?.target_count || 0),
    sufficient: rate !== null && rate >= threshold,
  };
}

/** وسم «عينة كافية / غير كافية». */
function sampleBadge(r) {
  if (r.rate === null) return badge('لم تُفتح بعد', 'muted');
  if (r.sufficient) return badge(`عينة كافية — ${fmtNum(r.rate)}%`, 'good');
  return badge(`عينة غير كافية — ${fmtNum(r.rate)}% (المطلوب ${fmtNum(r.threshold)}%)`, 'bad');
}

export default function register(router) {
  // قائمة استبانات البرنامج
  router.get('/programs/:id/surveys', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const rows = all(
      `SELECT s.*, i.name AS indicator_name
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
    const threshold = minResponseRate();

    ctx.render('الاستبانات', programHead(program, 'surveys', perms) + `
      ${section('الاستبانات', table(['الاستبانة', 'نقطة القياس', 'المؤشر', 'الحالة', 'الاستجابات', 'كفاية العينة', 'النتيجة', ''],
        rows.map((s) => {
          const r = surveyResults(s.id);
          return [
            esc(s.title), esc(POINT_LABEL[s.point] || s.point), esc(s.indicator_name || '—'),
            statusBadge(s.status === 'open' ? 'in_progress' : s.status === 'closed' ? 'done' : 'draft'),
            `<span class="num">${r.responses}${r.target ? ` / ${r.target}` : ''}</span>`,
            sampleBadge(r),
            progress(r.overall), `<a class="btn sec small" href="/surveys/${s.id}">فتح</a>`,
          ];
        }), { empty: 'لم تُنشأ استبانات بعد.' }),
        { actions: badge(`الحد الأدنى المعتمد لنسبة الاستجابة: ${fmtNum(threshold)}%`, 'muted') })}
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
    const invites = all(
      `SELECT v.*, st.full_name FROM survey_invites v
         JOIN students st ON st.id = v.student_id
        WHERE v.survey_id = ? ORDER BY st.full_name`, survey.id,
    );
    const eligible = Number(get(
      "SELECT COUNT(*) c FROM students WHERE program_id = ? AND status <> 'withdrawn'", survey.program_id,
    )?.c || 0);

    const linkFor = (inv) => `${ctx.url.origin}/r/${inv.token}`;

    return ctx.render(survey.title, `
      <div class="crumbs"><a href="/programs/${survey.program_id}/surveys">${esc(survey.program_name)} — الاستبانات</a></div>
      <div class="pagehead"><div>
        <h1>${esc(survey.title)}</h1>
        <p class="meta">${esc(POINT_LABEL[survey.point] || survey.point)} ·
          ${survey.status === 'open' ? badge('مفتوحة للتوزيع', 'good') : survey.status === 'closed' ? badge('مغلقة', 'muted') : badge('مسودة', 'warn')}
          · ${sampleBadge(r)}</p>
      </div></div>

      <div class="stats">
        ${statCard({ label: 'الاستجابات', value: r.target ? `${r.responses} / ${r.target}` : r.responses })}
        ${statCard({
          label: 'نسبة الاستجابة',
          value: r.rate === null ? '—' : `${fmtNum(r.rate)}%`,
          tone: r.rate === null ? '' : r.sufficient ? 'good' : 'bad',
          sub: `الحد الأدنى المعتمد ${fmtNum(r.threshold)}%`,
        })}
        ${statCard({ label: 'النتيجة (BR-03)', value: r.overall === null ? '—' : `${fmtNum(r.overall)}%`, tone: 'info', sub: '(المتوسط − 1) ÷ 4 × 100' })}
        ${statCard({ label: 'عدد الأسئلة', value: r.questions.length })}
      </div>

      ${!r.sufficient && r.rate !== null ? `<div class="flash err">
        <strong>عينة غير كافية.</strong> نسبة الاستجابة ${fmtNum(r.rate)}% أقل من الحد المعتمد ${fmtNum(r.threshold)}%.
        النتيجة تُعرض للاطلاع، لكن هذا القياس <strong>لا يُحتسب ضمن اكتمال القياس</strong> ويظهر كقياس ناقص يمنع إقفال البرنامج.
      </div>` : ''}

      ${section('روابط التوزيع الفردية', survey.status === 'draft'
        ? `<p class="empty">الاستبانة مسودة. عند فتحها للتوزيع يولّد النظام رابطًا فريدًا لكل طالب نشط
             (${eligible} طالبًا حاليًا)، يُستخدم مرة واحدة فقط.</p>`
        : invites.length ? `
          <p class="hint">كل رابط خاص بطالب واحد ويُستخدم مرة واحدة. النظام يسجّل <strong>أن الطالب أجاب</strong>
            فقط، ولا يربط إجابته باسمه إطلاقًا — فالسرية محفوظة والتكرار ممنوع.</p>
          <p>
            <button class="btn sec small" data-copy="${esc(invites.map(linkFor).join('\n'))}">نسخ كل الروابط</button>
            <a class="btn sec small" href="/surveys/${survey.id}/invites.csv">تنزيل الروابط (Excel)</a>
          </p>
          ${table(['الطالب', 'الحالة', 'الرابط'], invites.map((inv) => [
            esc(inv.full_name),
            inv.used_at ? badge('أجاب', 'good') : badge('لم يُجب بعد', 'warn'),
            `<code style="font-size:.74rem">${esc(linkFor(inv))}</code>
             <button class="btn sec small" data-copy="${esc(linkFor(inv))}">نسخ</button>`,
          ]), { cls: 'compact' })}`
        : '<p class="empty">لا توجد روابط — لم يكن هناك طلاب نشطون وقت الفتح.</p>')}

      ${editable ? section('إدارة الاستبانة', `
        <div class="row-form">
          ${survey.status === 'draft' ? `<form method="post" action="/surveys/${survey.id}/open" class="inline"><button class="btn">فتح للتوزيع وتوليد الروابط</button></form>` : ''}
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

  router.get('/surveys/:sid/invites.csv', (ctx) => {
    const survey = get('SELECT * FROM surveys WHERE id = ?', ctx.params.sid);
    if (!survey) return ctx.notFound();
    if (!canAccessProgram(ctx.user, survey.program_id)) return ctx.deny();
    const invites = all(
      `SELECT v.token, v.used_at, st.full_name, st.phone FROM survey_invites v
         JOIN students st ON st.id = v.student_id WHERE v.survey_id = ? ORDER BY st.full_name`,
      survey.id,
    );
    const csv = toCsv(
      ['الطالب', 'الجوال', 'رابط الاستبانة', 'الحالة'],
      invites.map((i) => [
        i.full_name, i.phone || '', `${ctx.url.origin}/r/${i.token}`, i.used_at ? 'أجاب' : 'لم يُجب بعد',
      ]),
    );
    return send(ctx.res, 200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`روابط-${survey.title}.csv`)}`,
    });
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

  /** الفتح يولّد رمزًا فريدًا لكل طالب نشط ويثبّت عدد المستهدفين. */
  router.post('/surveys/:sid/open', (ctx) => {
    const survey = get('SELECT * FROM surveys WHERE id = ?', ctx.params.sid);
    if (!survey) return ctx.notFound();
    if (!canAccessProgram(ctx.user, survey.program_id)) return ctx.deny();
    if (survey.status !== 'draft') return ctx.redirect(`/surveys/${survey.id}`, 'الاستبانة ليست مسودة.', 'err');

    const count = Number(get('SELECT COUNT(*) c FROM survey_questions WHERE survey_id = ?', survey.id).c);
    if (!count) return ctx.redirect(`/surveys/${survey.id}`, 'لا يمكن فتح استبانة بلا أسئلة.', 'err');

    const students = all(
      "SELECT id FROM students WHERE program_id = ? AND status <> 'withdrawn' ORDER BY full_name",
      survey.program_id,
    );
    if (!students.length) {
      return ctx.redirect(`/surveys/${survey.id}`,
        'لا يوجد طلاب نشطون — سجّل الطلاب أولًا حتى يمكن قياس نسبة الاستجابة.', 'err');
    }
    for (const s of students) {
      run('INSERT OR IGNORE INTO survey_invites (survey_id, student_id, token) VALUES (?, ?, ?)',
        survey.id, s.id, token(18));
    }
    run("UPDATE surveys SET status = 'open', opened_at = datetime('now'), target_count = ? WHERE id = ?",
      students.length, survey.id);
    audit({ user: ctx.user, action: 'survey.open', entityType: 'survey', entityId: survey.id, programId: survey.program_id, after: { target_count: students.length }, ip: ctx.ip });
    ctx.redirect(`/surveys/${survey.id}`, `فُتحت الاستبانة — وُلّد ${students.length} رابطًا فرديًا للتوزيع.`);
  });

  router.post('/surveys/:sid/close', (ctx) => {
    const survey = get('SELECT * FROM surveys WHERE id = ?', ctx.params.sid);
    if (!survey) return ctx.notFound();
    if (!canAccessProgram(ctx.user, survey.program_id)) return ctx.deny();
    const r = surveyResults(survey.id);
    run("UPDATE surveys SET status = 'closed', closed_at = datetime('now') WHERE id = ?", survey.id);
    if (survey.task_id) {
      run("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ?", survey.task_id);
    }
    audit({
      user: ctx.user, action: 'survey.close', entityType: 'survey', entityId: survey.id, programId: survey.program_id,
      after: { responses: r.responses, target: r.target, rate: r.rate, sufficient: r.sufficient, result_pct: r.overall },
      ip: ctx.ip,
    });
    refreshNotifications({ programId: survey.program_id });
    const note = r.sufficient
      ? `النتيجة ${r.overall === null ? '—' : `${fmtNum(r.overall)}%`}.`
      : `تنبيه: العينة غير كافية (${fmtNum(r.rate)}%) — لن تُحتسب ضمن اكتمال القياس.`;
    ctx.redirect(`/surveys/${survey.id}`, `أُغلقت الاستبانة — ${note}`);
  });

  // ------------------------------ الصفحة العامة للطالب ------------------
  // الرابط فردي ويُستخدم مرة واحدة، والإجابة تُحفظ دون ربطها بهوية الطالب.

  const notice = (res, title, text, status = 200) => html(res, bare({
    title,
    body: `<div class="login-card"><h1>${esc(title)}</h1><p class="sub">${esc(text)}</p></div>`,
  }), status);

  router.get('/r/:token', (ctx) => {
    const invite = get(
      `SELECT v.*, s.id AS survey_id, s.title, s.status
         FROM survey_invites v JOIN surveys s ON s.id = v.survey_id WHERE v.token = ?`,
      ctx.params.token,
    );
    if (!invite) return notice(ctx.res, 'الرابط غير صحيح', 'تأكد من نسخ الرابط كاملًا.', 404);
    if (invite.status !== 'open') return notice(ctx.res, 'الاستبانة مغلقة', 'لم تعد الاستبانة تستقبل استجابات.', 410);
    if (invite.used_at) return notice(ctx.res, 'سبق أن أجبت', 'شكرًا لك — استُلمت إجابتك على هذه الاستبانة مسبقًا.');

    const questions = all('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort, id', invite.survey_id);
    return html(ctx.res, bare({
      title: invite.title,
      body: `<div class="login-card">
        <h1>${esc(invite.title)}</h1>
        <p class="sub">جمعية تحصيل المعرفة — استبانة تجربة الطالب</p>
        <form method="post" action="/r/${esc(invite.token)}">
          ${questions.map((q, i) => `<div class="check-item">
            <div class="text">${i + 1}. ${esc(q.text)}</div>
            <div class="likert">${LIKERT.map((l) => `<label>
              <input type="radio" name="q_${q.id}" value="${l.value}" required> ${esc(l.label)}</label>`).join('')}</div>
          </div>`).join('')}
          <label class="field"><span class="field-label">ملاحظات أو مقترحات (اختياري)</span>
            ${textarea('comment', { rows: 3 })}</label>
          <button class="btn" style="width:100%">إرسال</button>
        </form>
        <p class="demo-list">إجاباتك سرية ولا تُربط باسمك. الرابط خاص بك ويُستخدم مرة واحدة فقط.</p>
      </div>`,
    }));
  });

  router.post('/r/:token', (ctx) => {
    const invite = get(
      `SELECT v.*, s.id AS survey_id, s.program_id, s.title, s.status
         FROM survey_invites v JOIN surveys s ON s.id = v.survey_id WHERE v.token = ?`,
      ctx.params.token,
    );
    if (!invite) return notice(ctx.res, 'الرابط غير صحيح', 'تأكد من نسخ الرابط كاملًا.', 404);
    if (invite.status !== 'open') return notice(ctx.res, 'الاستبانة مغلقة', 'لم تعد الاستبانة تستقبل استجابات.', 410);
    if (invite.used_at) return notice(ctx.res, 'سبق أن أجبت', 'شكرًا لك — استُلمت إجابتك على هذه الاستبانة مسبقًا.');

    const questions = all('SELECT * FROM survey_questions WHERE survey_id = ?', invite.survey_id);
    const answers = [];
    for (const q of questions) {
      const v = int(ctx.body[`q_${q.id}`], 0);
      if (v >= 1 && v <= 5) answers.push({ q, v });
    }
    if (!answers.length) return notice(ctx.res, 'لم تُستلم إجابة', 'يرجى الإجابة على الأسئلة ثم الإرسال.', 400);

    // لا يُحفظ أي ربط بين الاستجابة والدعوة أو الطالب — فقط أن الدعوة استُهلكت.
    const res = run('INSERT INTO survey_responses (survey_id, respondent_key) VALUES (?, ?)', invite.survey_id, token(8));
    const responseId = Number(res.lastInsertRowid);
    for (const a of answers) {
      run('INSERT INTO survey_answers (response_id, question_id, value) VALUES (?, ?, ?)', responseId, a.q.id, a.v);
    }
    run("UPDATE survey_invites SET used_at = datetime('now') WHERE id = ?", invite.id);

    const comment = String(ctx.body.comment || '').trim();
    if (comment) {
      run(`INSERT INTO complaints (program_id, ref_code, kind, source, title, body, sla_days, due_date, status)
           VALUES (?, ?, 'suggestion', 'استبانة', ?, ?, 5, date('now','+5 day'), 'open')`,
        invite.program_id, `S-${responseId}`,
        `ملاحظة من استبانة: ${invite.title}`.slice(0, 180), comment);
    }
    return notice(ctx.res, 'شكرًا لك', 'تم استلام إجابتك بنجاح. رأيك يسهم في تحسين برامج الجمعية.');
  });
}
