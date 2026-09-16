import { all, get, run } from '../db/index.js';
import { esc, fmtDate, fmtNum, today, addDays, int } from '../lib/util.js';
import { statCard, table, section, statusBadge, dueBadge, badge, progress, evidenceList, evidenceForm, textarea } from '../views/ui.js';
import { ROLES, roleName } from '../lib/roles.js';
import { programsForUser, canAccessProgram } from '../lib/auth.js';
import { tasksForUser, refreshNotifications } from '../lib/scheduler.js';
import { computeProgram, missingMeasurements } from '../lib/scoring.js';
import { audit } from '../lib/audit.js';

/** لوحة المستخدم — البند 4: كل دور يرى واجباته فقط. */
function dashboardBody(ctx) {
  const { user } = ctx;
  const t = tasksForUser(user.id);
  const programs = programsForUser(user);
  const now = today();

  const myRoles = all(
    'SELECT DISTINCT role FROM program_assignments WHERE user_id = ?', user.id,
  ).map((r) => r.role);
  if (user.global_role === 'quality_manager' && !myRoles.includes('quality_manager')) myRoles.push('quality_manager');

  const notifs = all(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY is_read, id DESC LIMIT 6', user.id,
  );

  // القياسات الناقصة في البرامج التي يعمل عليها المستخدم
  const gaps = [];
  for (const p of programs.filter((x) => x.status !== 'closed')) {
    for (const g of missingMeasurements(p.id)) {
      const mine = user.global_role === 'admin' || user.global_role === 'quality_manager'
        || myRoles.includes(g.indicator.owner_role);
      if (mine) gaps.push({ ...g, program: p });
    }
  }

  // الشواهد المطلوبة: عناصر غير متحققة بلا شاهد مرفق
  const evidenceNeeded = programs.length ? all(
    `SELECT v.id, v.program_id, p.name AS program_name, i.name AS indicator_name, v.completed_at
       FROM verifications v
       JOIN programs p ON p.id = v.program_id
       JOIN indicators i ON i.id = v.indicator_id
      WHERE v.status = 'submitted' AND v.completed_by = ?
        AND EXISTS (SELECT 1 FROM verification_items vi WHERE vi.verification_id = v.id AND vi.state < 100)
        AND NOT EXISTS (SELECT 1 FROM evidences e WHERE e.entity_type = 'verification' AND e.entity_id = v.id)
      ORDER BY v.completed_at DESC LIMIT 10`,
    user.id,
  ) : [];

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

  return `
  <div class="pagehead">
    <div><h1>لوحتي</h1>
      <p class="meta">${esc(user.full_name)} — ${myRoles.map(roleName).join('، ') || 'بلا دور مسند'}</p></div>
  </div>

  <div class="stats">
    ${statCard({ label: 'واجباتي اليوم', value: t.dueToday.length, tone: t.dueToday.length ? 'warn' : '' })}
    ${statCard({ label: 'المستحق قريبًا', value: t.soon.length, tone: 'info' })}
    ${statCard({ label: 'المتأخر', value: t.overdue.length, tone: t.overdue.length ? 'bad' : 'good' })}
    ${statCard({ label: 'القياسات الناقصة', value: gaps.length, tone: gaps.length ? 'warn' : 'good' })}
    ${statCard({ label: 'الشواهد المطلوبة', value: evidenceNeeded.length, tone: evidenceNeeded.length ? 'warn' : 'good' })}
    ${statCard({ label: 'برامجي', value: programs.length })}
  </div>

  ${section('واجباتي اليوم والمتأخر',
    table(['المهمة', 'البرنامج', 'الاستحقاق', 'الأداة'],
      [...t.overdue, ...t.dueToday].map(taskRow),
      { empty: 'لا توجد مهام مستحقة اليوم أو متأخرة. أحسنت.' }),
    { actions: '<a class="btn sec small" href="/tasks">كل واجباتي</a>' })}

  <div class="grid two">
    ${section('المستحق قريبًا (7 أيام)',
      table(['المهمة', 'البرنامج', 'الاستحقاق', 'الأداة'], t.soon.map(taskRow),
        { empty: 'لا توجد مهام مستحقة خلال الأسبوع القادم.' }))}

    ${section('آخر التنبيهات',
      notifs.length ? `<ul class="evidence">${notifs.map((n) => `<li>
        ${n.is_read ? '' : '<strong>•</strong> '}<a href="${esc(n.link || '#')}">${esc(n.title)}</a>
        <small>${esc(n.body || '')}</small></li>`).join('')}</ul>`
        : '<p class="empty">لا توجد تنبيهات.</p>',
      { actions: '<a class="btn sec small" href="/notifications">الكل</a>' })}
  </div>

  ${gaps.length ? section('القياسات الناقصة المرتبطة بدوري',
    table(['البرنامج', 'المؤشر', 'المنفّذ/المطلوب', 'خطة العينة'],
      gaps.slice(0, 15).map((g) => [
        `<a href="/programs/${g.program.id}/metric">${esc(g.program.name)}</a>`,
        esc(g.indicator.name),
        `<span class="num">${g.completed} / ${g.required}</span>`,
        `<small class="muted">${esc(g.sample_label)}</small>`,
      ])) ) : ''}

  ${evidenceNeeded.length ? section('الشواهد المطلوبة',
    table(['البرنامج', 'المؤشر', 'تاريخ التحقق', ''],
      evidenceNeeded.map((e) => [
        esc(e.program_name), esc(e.indicator_name), fmtDate(e.completed_at),
        `<a class="btn sec small" href="/verifications/${e.id}">إرفاق شاهد</a>`,
      ]))) : ''}

  ${section('برامجي',
    table(['البرنامج', 'الفترة', 'الحالة', 'الدرجة من 300', 'اكتمال القياس'],
      programs.slice(0, 10).map((p) => {
        const r = computeProgram(p.id);
        return [
          `<a href="/programs/${p.id}">${esc(p.name)}</a>`,
          `<small class="muted">${fmtDate(p.start_date)} — ${fmtDate(p.end_date)}</small>`,
          statusBadge(p.status),
          `<span class="num">${fmtNum(r?.earned)} / 300</span>`,
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
  router.get('/', (ctx) => ctx.render('لوحتي', dashboardBody(ctx), { active: '/' }));

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

    // إجراءات تصحيحية للعناصر غير المتحققة
    if (ctx.body.auto_action) {
      const ind = get('SELECT name FROM indicators WHERE id = ?', task.indicator_id);
      for (const s of saved.filter((x) => x.state === 0)) {
        run(`INSERT INTO corrective_actions (program_id, kind, origin_type, origin_id, title, description, owner_id, due_date, created_by)
             VALUES (?, 'corrective', 'verification', ?, ?, ?, ?, ?, ?)`,
          task.program_id, verification.id,
          `معالجة: ${s.item.text}`.slice(0, 180),
          `نتج عن تحقق «${ind?.name || ''}». الملاحظة: ${s.note}`,
          task.assigned_user_id, addDays(today(), 7), ctx.user.id);
      }
    }

    audit({
      user: ctx.user, action: 'verification.submit', entityType: 'verification', entityId: verification.id,
      programId: task.program_id, after: { score_pct: scorePct, items: saved.map((s) => ({ item: s.item.code, state: s.state })) }, ip: ctx.ip,
    });
    refreshNotifications({ programId: task.program_id });
    ctx.redirect(`/verifications/${verification.id}`, `تم اعتماد التحقق — النتيجة ${fmtNum(scorePct)}%.`);
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
