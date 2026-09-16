import { all, get, run } from '../db/index.js';
import { esc, fmtDate, fmtNum, today, addDays, int } from '../lib/util.js';
import {
  statCard, table, section, statusBadge, dueBadge, badge, progress, evidenceList, evidenceForm,
  textarea, insightCard, insightList, healthBadge, priorityRow,
} from '../views/ui.js';
import { icon } from '../views/icons.js';
import { programDiagnostics, prioritizedTasks, portfolioHealth } from '../lib/insights.js';
import { ROLES, roleName } from '../lib/roles.js';
import { programsForUser, canAccessProgram } from '../lib/auth.js';
import { tasksForUser, refreshNotifications } from '../lib/scheduler.js';
import { computeProgram, missingMeasurements } from '../lib/scoring.js';
import { audit } from '../lib/audit.js';
import { recordVerificationFailures } from '../lib/actions.js';

/**
 * لوحة المستخدم الذكية.
 *
 * الفرق عن القائمة المسطّحة: تبدأ بـ«ابدأ بهذه» — أعلى مهمة أثرًا لا أقربها تاريخًا —
 * ثم ملاحظات تشخيصية تقول لماذا الدرجة منخفضة وما الإجراء، ثم التفاصيل.
 */
function dashboardBody(ctx) {
  const { user } = ctx;
  const t = tasksForUser(user.id);
  const programs = programsForUser(user);
  const now = today();
  const isManager = user.global_role === 'admin' || user.global_role === 'quality_manager';

  const myRoles = all(
    'SELECT DISTINCT role FROM program_assignments WHERE user_id = ?', user.id,
  ).map((r) => r.role);
  if (user.global_role === 'quality_manager' && !myRoles.includes('quality_manager')) myRoles.push('quality_manager');

  const priority = prioritizedTasks(user.id, { limit: 5 });
  const top = priority[0] || null;

  // ملاحظات تشخيصية من البرامج المسندة، مرتبة بالخطورة ثم الأثر
  const openPrograms = programs.filter((p) => p.status !== 'closed');
  const diagnostics = openPrograms.map((p) => ({ p, d: programDiagnostics(p.id) }));
  const myFindings = [];
  for (const { p, d } of diagnostics) {
    for (const f of d.findings) myFindings.push({ ...f, program: p });
  }
  myFindings.sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a.severity]
    - { critical: 0, warning: 1, info: 2 }[b.severity]) || b.impact - a.impact);

  const criticalCount = myFindings.filter((f) => f.severity === 'critical').length;
  const atRisk = myFindings.reduce((sum, f) => sum + (f.severity === 'critical' ? f.impact : 0), 0);

  const notifs = all(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY is_read, id DESC LIMIT 5', user.id,
  );

  const taskRow = (task) => [
    `<a href="/tasks/${task.id}">${esc(task.title)}</a>`,
    esc(task.program_name),
    dueBadge(task.due_date, now),
    badge(task.tool === 'checklist' ? 'قائمة تحقق' : task.tool === 'survey' ? 'استبانة' : 'سجل تشغيلي', 'muted'),
  ];

  const duties = myRoles.filter((r) => ROLES[r]).map((r) => `
    <div>
      <h3>${esc(ROLES[r].name)}</h3>
      <ul class="duties">${ROLES[r].duties.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
    </div>`).join('');

  // نظرة الجمعية لمدير الجودة: البرامج المهدَّدة أولًا
  const portfolio = isManager ? portfolioHealth(programs) : [];

  return `
  <div class="pagehead">
    <div><h1>لوحتي</h1>
      <p class="meta">${esc(user.full_name)} — ${myRoles.map(roleName).join('، ') || 'بلا دور مسند'}</p></div>
  </div>

  ${top ? `<section class="panel next-up">
    <header class="panel-head"><h2>${icon('target', { size: 17 })} ابدأ بهذه</h2>
      <div class="panel-actions">${badge(`أولوية ${top.priority}`, top.priority >= 70 ? 'bad' : 'warn')}</div>
    </header>
    <div class="panel-body">
      <h3 style="font-size:1.05rem"><a href="/tasks/${top.id}">${esc(top.title)}</a></h3>
      <p class="muted" style="font-size:.85rem">${esc(top.program_name)}</p>
      <div class="prio-why" style="margin:.5rem 0">${top.reasons.map((r) => badge(r, 'warn')).join(' ')}</div>
      <a class="btn" href="/tasks/${top.id}">${icon('check', { size: 15 })} تنفيذ الآن</a>
    </div>
  </section>` : ''}

  <div class="stats">
    ${statCard({ label: 'واجباتي اليوم', value: t.dueToday.length, ico: 'tasks', tone: t.dueToday.length ? 'warn' : '' })}
    ${statCard({ label: 'المتأخر', value: t.overdue.length, ico: 'alert', tone: t.overdue.length ? 'bad' : 'good' })}
    ${statCard({ label: 'المستحق قريبًا', value: t.soon.length, ico: 'calendar', tone: 'info' })}
    ${statCard({
      label: 'ملاحظات عاجلة',
      value: criticalCount,
      ico: 'alert',
      tone: criticalCount ? 'bad' : 'good',
      sub: atRisk ? `${fmtNum(atRisk)} درجة معرّضة للخطر` : '',
    })}
    ${statCard({ label: 'برامجي', value: programs.length, ico: 'programs' })}
  </div>

  ${myFindings.length ? section('ما يحتاج انتباهك',
    myFindings.slice(0, 6).map((f) => insightCard({
      ...f,
      title: `${f.title}`,
      detail: `${f.program.name} — ${f.detail}`,
    })).join(''),
    { actions: myFindings.length > 6 ? badge(`و${myFindings.length - 6} ملاحظة أخرى`, 'muted') : '' })
    : section('ما يحتاج انتباهك', insightList([], { empty: 'لا توجد ملاحظات عاجلة على برامجك.' }))}

  ${priority.length > 1 ? section('مهامك بترتيب الأولوية',
    `<ul class="prio-list">${priority.map((task) => priorityRow(task)).join('')}</ul>
     <p class="hint">الترتيب بالأثر لا بالتاريخ: وزن المؤشر في المقياس، والتأخر، وقرب انتهاء الفرصة.</p>`,
    { actions: '<a class="btn sec small" href="/tasks">كل واجباتي</a>' }) : ''}

  ${isManager && portfolio.length ? section('صحة البرامج — نظرة الجمعية',
    table(['البرنامج', 'الحالة', 'أبرز ملاحظة', 'الدرجة', 'الاكتمال'],
      portfolio.slice(0, 8).map((x) => [
        `<a href="/programs/${x.program.id}">${esc(x.program.name)}</a>`,
        healthBadge(x.health),
        x.top ? `<small>${esc(x.top.title)}</small>` : '<small class="muted">—</small>',
        `<span class="num">${fmtNum(x.score)}</span>`,
        progress(x.coverage),
      ]), { empty: 'لا توجد برامج قائمة.' }),
    { actions: '<a class="btn sec small" href="/reports">مركز التقارير</a>' }) : ''}

  <div class="grid two">
    ${section('واجباتي اليوم والمتأخر',
      table(['المهمة', 'البرنامج', 'الاستحقاق', 'الأداة'],
        [...t.overdue, ...t.dueToday].slice(0, 8).map(taskRow),
        { empty: 'لا توجد مهام مستحقة اليوم أو متأخرة. أحسنت.' }))}

    ${section('آخر التنبيهات',
      notifs.length ? `<ul class="evidence">${notifs.map((n) => `<li>
        ${n.is_read ? '' : '<strong>•</strong> '}<a href="${esc(n.link || '#')}">${esc(n.title)}</a>
        <small>${esc(n.body || '')}</small></li>`).join('')}</ul>`
        : '<p class="empty">لا توجد تنبيهات.</p>',
      { actions: '<a class="btn sec small" href="/notifications">الكل</a>' })}
  </div>

  ${section('برامجي',
    table(['البرنامج', 'الفترة', 'الحالة', 'الدرجة', 'اكتمال القياس'],
      programs.slice(0, 10).map((p) => {
        const r = computeProgram(p.id);
        return [
          `<a href="/programs/${p.id}">${esc(p.name)}</a>`,
          `<small class="muted">${fmtDate(p.start_date)} — ${fmtDate(p.end_date)}</small>`,
          statusBadge(p.status),
          `<span class="num">${fmtNum(r?.earned)} / ${fmtNum(r?.total_weight)}</span>`,
          progress(r?.coverage_pct),
        ];
      }), { empty: 'لم يُسند إليك أي برنامج بعد.' }))}

  ${duties ? section('مسؤوليات دوري وفق دليل المقياس', `<div class="grid two">${duties}</div>`) : ''}`;
}

/** نموذج قائمة التحقق لمهمة. */
function checklistForm(task, indicator, items, verification, existing) {
  const values = new Map(existing.map((e) => [e.checklist_item_id, e]));
  return `<form method="post" action="/tasks/${task.id}/verify">
    ${items.map((item) => {
      const cur = values.get(item.id);
      const state = cur ? String(cur.state) : null;
      const opt = (v, label, cls) => `<label class="${cls}">
        <input type="radio" name="state_${item.id}" value="${v}" data-state required${state === String(v) ? ' checked' : ''}> ${label}</label>`;
      return `<div class="check-item">
        <div class="text">${esc(item.text)}</div>
        <div class="states">
          ${opt(100, 'متحقق — 100%', 's100')}
          ${opt(50, 'جزئي — 50%', 's50')}
          ${opt(0, 'غير متحقق — 0%', 's0')}
        </div>
        <div class="note-box">
          ${textarea(`note_${item.id}`, { value: cur?.note || '', rows: 2, placeholder: 'الملاحظة إلزامية عند «جزئي» أو «غير متحقق» (BR-04)' })}
        </div>
      </div>`;
    }).join('')}
    <label class="field"><span class="field-label">ملاحظات عامة على عملية التحقق</span>
      ${textarea('notes', { value: verification?.notes || '', rows: 2 })}</label>
    <label class="inline"><input type="checkbox" name="auto_action" value="1" checked style="width:auto"> إنشاء إجراء تصحيحي تلقائيًا للعناصر غير المتحققة</label>
    <p style="margin-top:.8rem"><button class="btn">اعتماد التحقق واحتساب النتيجة</button></p>
  </form>`;
}

export default function register(router) {
  router.get('/app', (ctx) => ctx.render('لوحتي', dashboardBody(ctx), { active: '/app' }));

  router.get('/tasks', (ctx) => {
    const t = tasksForUser(ctx.user.id);
    const now = today();
    const rows = (list) => list.map((task) => [
      `<a href="/tasks/${task.id}">${esc(task.title)}</a>`,
      esc(task.program_name),
      dueBadge(task.due_date, now),
      badge(task.tool === 'checklist' ? 'قائمة تحقق' : task.tool === 'survey' ? 'استبانة' : 'سجل تشغيلي', 'muted'),
    ]);
    const done = all(
      `SELECT t.*, p.name AS program_name, i.tool FROM tasks t
        JOIN programs p ON p.id = t.program_id
        LEFT JOIN indicators i ON i.id = t.indicator_id
       WHERE t.assigned_user_id = ? AND t.status = 'done'
       ORDER BY t.completed_at DESC LIMIT 25`,
      ctx.user.id,
    );
    const head = ['المهمة', 'البرنامج', 'الاستحقاق', 'الأداة'];
    ctx.render('واجباتي', `
      <h1>واجباتي</h1>
      ${section(`المتأخر (${t.overdue.length})`, table(head, rows(t.overdue), { empty: 'لا توجد مهام متأخرة.' }))}
      ${section(`اليوم (${t.dueToday.length})`, table(head, rows(t.dueToday), { empty: 'لا توجد مهام مستحقة اليوم.' }))}
      ${section(`قريبًا (${t.soon.length})`, table(head, rows(t.soon), { empty: 'لا توجد مهام قريبة.' }))}
      ${section(`لاحقًا (${t.later.length})`, table(head, rows(t.later), { empty: 'لا توجد مهام لاحقة.' }))}
      ${section('آخر المهام المنجزة', table(['المهمة', 'البرنامج', 'تاريخ الإنجاز'],
        done.map((d) => [esc(d.title), esc(d.program_name), fmtDate(d.completed_at)]),
        { empty: 'لم تُنجز مهام بعد.' }))}
    `, { active: '/tasks' });
  });

  router.get('/tasks/:id', (ctx) => {
    const task = get(
      `SELECT t.*, p.name AS program_name, p.status AS program_status, i.name AS indicator_name,
              i.tool, i.description, i.code AS indicator_code, s.seq AS session_seq, s.session_date
         FROM tasks t JOIN programs p ON p.id = t.program_id
         LEFT JOIN indicators i ON i.id = t.indicator_id
         LEFT JOIN sessions s ON s.id = t.session_id
        WHERE t.id = ?`, ctx.params.id,
    );
    if (!task) return ctx.notFound();
    if (!canAccessProgram(ctx.user, task.program_id)) return ctx.deny();

    const isOwner = task.assigned_user_id === ctx.user.id
      || ctx.user.global_role === 'admin' || ctx.user.global_role === 'quality_manager';

    const header = `<div class="crumbs"><a href="/programs/${task.program_id}">${esc(task.program_name)}</a> ← واجباتي</div>
      <div class="pagehead">
        <div><h1>${esc(task.title)}</h1>
          <p class="meta">${esc(task.indicator_code || '')} · الدور المسؤول: ${roleName(task.assigned_role)}
          · الاستحقاق: ${fmtDate(task.due_date)} ${statusBadge(task.status)}</p>
          ${task.description ? `<p class="hint">${esc(task.description)}</p>` : ''}
        </div>
      </div>`;

    if (task.status === 'done' && task.ref_type === 'verification') {
      ctx.redirect(`/verifications/${task.ref_id}`);
      return;
    }

    if (task.kind === 'checklist') {
      if (!isOwner) return ctx.deny('هذه المهمة مسندة لمستخدم آخر.');
      if (task.program_status === 'closed') return ctx.deny('البرنامج مغلق ولا يقبل قياسات جديدة.');
      let verification = get("SELECT * FROM verifications WHERE task_id = ? AND status = 'draft'", task.id);
      if (!verification) {
        run(`INSERT INTO verifications (task_id, program_id, indicator_id, session_id) VALUES (?, ?, ?, ?)`,
          task.id, task.program_id, task.indicator_id, task.session_id);
        verification = get('SELECT * FROM verifications WHERE task_id = ? ORDER BY id DESC LIMIT 1', task.id);
      }
      const items = all('SELECT * FROM checklist_items WHERE indicator_id = ? ORDER BY sort, id', task.indicator_id);
      const existing = all('SELECT * FROM verification_items WHERE verification_id = ?', verification.id);
      ctx.render(task.title, `${header}
        ${section('قائمة التحقق', checklistForm(task, task.indicator_id, items, verification, existing),
          { actions: badge('متحقق 100% · جزئي 50% · غير متحقق 0%', 'muted') })}`);
      return;
    }

    if (task.kind === 'survey') {
      const survey = get('SELECT * FROM surveys WHERE task_id = ?', task.id);
      if (survey) { ctx.redirect(`/surveys/${survey.id}`); return; }
      ctx.render(task.title, `${header}
        ${section('إنشاء الاستبانة', `
          <p>لم تُنشأ استبانة لهذه المهمة بعد. يولّد النظام الأسئلة من مكتبة الأسئلة المرتبطة بالمؤشر.</p>
          <form method="post" action="/surveys/create">
            <input type="hidden" name="task_id" value="${task.id}">
            <button class="btn">توليد الاستبانة وفتحها للتوزيع</button>
          </form>`)}`);
      return;
    }

    // سجل تشغيلي: توجيه المستخدم إلى الشاشة المناسبة
    const targets = {
      attendance_rate: ['الحضور والانضباط', `/programs/${task.program_id}/attendance`],
      discipline_documented: ['الحالات والمتابعة', `/programs/${task.program_id}/discipline`],
      complaint_sla: ['الشكاوى والمقترحات', `/programs/${task.program_id}/complaints`],
      continuity_intent: ['الاستمرارية', `/programs/${task.program_id}/continuity`],
      continuity_actual: ['الاستمرارية', `/programs/${task.program_id}/continuity`],
    };
    const ind = get('SELECT record_rule FROM indicators WHERE id = ?', task.indicator_id);
    const target = targets[ind?.record_rule] || ['البرنامج', `/programs/${task.program_id}`];
    ctx.render(task.title, `${header}
      ${section('سجل تشغيلي', `
        <p>يُحتسب هذا المؤشر تلقائيًا من السجلات التشغيلية. أكمل السجل ثم اعتمد المهمة.</p>
        <p><a class="btn sec" href="${target[1]}">فتح شاشة ${esc(target[0])}</a></p>
        <form method="post" action="/tasks/${task.id}/complete" style="margin-top:.8rem">
          <button class="btn">اعتماد اكتمال السجل</button>
        </form>`)}`);
  });

  router.post('/tasks/:id/verify', (ctx) => {
    const task = get('SELECT * FROM tasks WHERE id = ?', ctx.params.id);
    if (!task) return ctx.notFound();
    if (!canAccessProgram(ctx.user, task.program_id)) return ctx.deny();
    const isOwner = task.assigned_user_id === ctx.user.id || ctx.user.global_role === 'admin';
    if (!isOwner) return ctx.deny('هذه المهمة مسندة لمستخدم آخر.');

    const verification = get("SELECT * FROM verifications WHERE task_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1", task.id);
    if (!verification) return ctx.notFound('لا توجد عملية تحقق مفتوحة لهذه المهمة.');

    const items = all('SELECT * FROM checklist_items WHERE indicator_id = ? ORDER BY sort, id', task.indicator_id);
    let weighted = 0;
    let totalWeight = 0;
    const saved = [];
    for (const item of items) {
      const raw = ctx.body[`state_${item.id}`];
      if (raw === undefined) return ctx.redirect(`/tasks/${task.id}`, 'يجب تحديد حالة كل عنصر قبل الاعتماد.', 'err');
      const state = int(raw, -1);
      if (![0, 50, 100].includes(state)) return ctx.redirect(`/tasks/${task.id}`, 'قيمة الحالة غير صحيحة.', 'err');
      const note = String(ctx.body[`note_${item.id}`] || '').trim();
      // BR-04: الملاحظة إلزامية عند جزئي أو غير متحقق
      if (state < 100 && !note) {
        return ctx.redirect(`/tasks/${task.id}`, 'الملاحظة إلزامية عند «جزئي» أو «غير متحقق» (BR-04).', 'err');
      }
      weighted += state * Number(item.weight);
      totalWeight += Number(item.weight);
      saved.push({ item, state, note });
    }
    const scorePct = totalWeight ? weighted / totalWeight : 0;

    run('DELETE FROM verification_items WHERE verification_id = ?', verification.id);
    for (const s of saved) {
      run('INSERT INTO verification_items (verification_id, checklist_item_id, state, note) VALUES (?, ?, ?, ?)',
        verification.id, s.item.id, s.state, s.note || null);
    }
    run(`UPDATE verifications SET score_pct = ?, notes = ?, status = 'submitted',
                completed_by = ?, completed_at = datetime('now') WHERE id = ?`,
      scorePct, String(ctx.body.notes || '').trim() || null, ctx.user.id, verification.id);
    run(`UPDATE tasks SET status = 'done', completed_at = datetime('now'), ref_type = 'verification', ref_id = ?
          WHERE id = ?`, verification.id, task.id);

    // إجراءات تصحيحية ذكية: المشكلة الواحدة إجراء واحد بعدّاد تكرار،
    // وعودتها بعد إغلاق إجراءها تُفتح كـ«تكرار» بأولوية أعلى.
    let actionSummary = null;
    if (ctx.body.auto_action) {
      const ind = get('SELECT name FROM indicators WHERE id = ?', task.indicator_id);
      actionSummary = recordVerificationFailures({
        programId: task.program_id,
        indicatorId: task.indicator_id,
        indicatorName: ind?.name || '',
        failures: saved.filter((x) => x.state < 100),
        ownerId: task.assigned_user_id,
        userId: ctx.user.id,
        verificationId: verification.id,
      });
    }

    audit({
      user: ctx.user, action: 'verification.submit', entityType: 'verification', entityId: verification.id,
      programId: task.program_id, after: { score_pct: scorePct, items: saved.map((s) => ({ item: s.item.code, state: s.state })) }, ip: ctx.ip,
    });
    refreshNotifications({ programId: task.program_id });
    let msg = `تم اعتماد التحقق — النتيجة ${fmtNum(scorePct)}%.`;
    if (actionSummary) {
      const parts = [];
      if (actionSummary.created) parts.push(`${actionSummary.created} إجراءً جديدًا`);
      if (actionSummary.merged) parts.push(`${actionSummary.merged} مشكلة متكررة دُمجت في إجراء قائم`);
      if (actionSummary.recurred) parts.push(`${actionSummary.recurred} مشكلة عادت بعد إغلاق إجراءها`);
      if (parts.length) msg += ` (${parts.join('، ')})`;
    }
    ctx.redirect(`/verifications/${verification.id}`, msg);
  });

  router.post('/tasks/:id/complete', (ctx) => {
    const task = get('SELECT * FROM tasks WHERE id = ?', ctx.params.id);
    if (!task) return ctx.notFound();
    if (!canAccessProgram(ctx.user, task.program_id)) return ctx.deny();
    run("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ?", task.id);
    audit({ user: ctx.user, action: 'task.complete', entityType: 'task', entityId: task.id, programId: task.program_id, ip: ctx.ip });
    ctx.redirect('/tasks', 'تم اعتماد اكتمال المهمة.');
  });

  router.get('/verifications/:id', (ctx) => {
    const v = get(
      `SELECT v.*, i.name AS indicator_name, i.code AS indicator_code, p.name AS program_name,
              u.full_name AS by_name, s.seq AS session_seq
         FROM verifications v
         JOIN indicators i ON i.id = v.indicator_id
         JOIN programs p ON p.id = v.program_id
         LEFT JOIN users u ON u.id = v.completed_by
         LEFT JOIN sessions s ON s.id = v.session_id
        WHERE v.id = ?`, ctx.params.id,
    );
    if (!v) return ctx.notFound();
    if (!canAccessProgram(ctx.user, v.program_id)) return ctx.deny();
    const items = all(
      `SELECT vi.*, ci.text FROM verification_items vi
         JOIN checklist_items ci ON ci.id = vi.checklist_item_id
        WHERE vi.verification_id = ? ORDER BY ci.sort`, v.id,
    );
    const evid = all("SELECT * FROM evidences WHERE entity_type = 'verification' AND entity_id = ? ORDER BY id DESC", v.id);
    const stateBadge = (s) => (s === 100 ? badge('متحقق', 'good') : s === 50 ? badge('جزئي', 'warn') : badge('غير متحقق', 'bad'));

    ctx.render('نتيجة التحقق', `
      <div class="crumbs"><a href="/programs/${v.program_id}">${esc(v.program_name)}</a> ← التحقق</div>
      <div class="pagehead"><div>
        <h1>${esc(v.indicator_name)}</h1>
        <p class="meta">${esc(v.indicator_code)} ${v.session_seq ? `· اللقاء ${v.session_seq}` : ''}
          · نفّذه ${esc(v.by_name || '—')} في ${fmtDate(v.completed_at)}</p>
      </div><div>${progress(v.score_pct, { label: 'النتيجة' })}</div></div>
      ${section('عناصر التحقق', table(['العنصر', 'الحالة', 'الملاحظة'],
        items.map((i) => [esc(i.text), stateBadge(i.state), esc(i.note || '—')])))}
      ${v.notes ? section('ملاحظات عامة', `<p>${esc(v.notes)}</p>`) : ''}
      ${section('الشواهد', evidenceList(evid) + evidenceForm('verification', v.id, `/verifications/${v.id}`))}
    `);
  });

  router.get('/notifications', (ctx) => {
    const rows = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 200', ctx.user.id);
    run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', ctx.user.id);
    const tone = { overdue: 'bad', due_soon: 'warn', sample_gap: 'warn', not_met: 'bad', info: 'info' };
    ctx.render('التنبيهات', `
      <h1>التنبيهات</h1>
      ${section('كل التنبيهات', table(['النوع', 'العنوان', 'التفاصيل', 'التاريخ'],
        rows.map((n) => [
          badge({ overdue: 'متأخر', due_soon: 'قريب الاستحقاق', sample_gap: 'نقص عينة', not_met: 'غير متحقق', info: 'معلومة' }[n.type] || n.type, tone[n.type] || ''),
          n.link ? `<a href="${esc(n.link)}">${esc(n.title)}</a>` : esc(n.title),
          esc(n.body || ''), fmtDate(n.created_at),
        ]), { empty: 'لا توجد تنبيهات.' }))}
    `);
  });
}
