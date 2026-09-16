import { all, get, run } from '../db/index.js';
import { esc, fmtDate, int, today, addDays } from '../lib/util.js';
import {
  table, section, statusBadge, badge, select, field, input, textarea, evidenceList, evidenceForm, statCard, progress,
} from '../views/ui.js';
import { can } from '../lib/roles.js';
import { audit } from '../lib/audit.js';
import { scheduleMainActivityTask, refreshNotifications } from '../lib/scheduler.js';
import { loadProgram, ensureOpen, programHead } from './_helpers.js';

const SLA_DEFAULT = 5;

export default function register(router) {
  // ------------------------------ الحضور ------------------------------
  router.get('/programs/:id/attendance', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const sessions = all('SELECT * FROM sessions WHERE program_id = ? ORDER BY seq', program.id);
    const current = ctx.query.session
      ? sessions.find((s) => String(s.id) === String(ctx.query.session))
      : sessions.find((s) => s.status === 'held') || sessions[0];
    const students = all("SELECT * FROM students WHERE program_id = ? AND status <> 'withdrawn' ORDER BY full_name", program.id);
    const marks = current
      ? new Map(all('SELECT * FROM attendance WHERE session_id = ?', current.id).map((a) => [a.student_id, a]))
      : new Map();
    const editable = can(perms, 'attendance.manage') && program.status !== 'closed';

    const summary = all(
      `SELECT s.seq, s.id,
              COUNT(a.id) AS recorded,
              SUM(a.state = 'present') AS present,
              SUM(a.state = 'absent') AS absent
         FROM sessions s LEFT JOIN attendance a ON a.session_id = s.id
        WHERE s.program_id = ? GROUP BY s.id ORDER BY s.seq`, program.id,
    );

    const states = [
      ['present', 'حاضر'], ['late', 'متأخر'], ['excused', 'بعذر'], ['absent', 'غائب'],
    ];

    ctx.render('الحضور', programHead(program, 'attendance') + `
      ${section('تسجيل الحضور', current ? `
        <form method="get" class="row-form">
          ${select('session', sessions.map((s) => ({ value: s.id, label: `اللقاء ${s.seq} — ${fmtDate(s.session_date)}` })), current.id, { attrs: 'onchange="this.form.submit()"' })}
          <noscript><button class="btn small">عرض</button></noscript>
        </form>
        <form method="post" action="/programs/${program.id}/attendance">
          <input type="hidden" name="session_id" value="${current.id}">
          ${table(['الطالب', 'الحالة', 'ملاحظة'], students.map((s) => {
            const m = marks.get(s.id);
            return [
              esc(s.full_name),
              editable
                ? `<div class="states">${states.map(([v, l]) => `<label><input type="radio" name="state_${s.id}" value="${v}"${(m?.state || 'present') === v ? ' checked' : ''}> ${l}</label>`).join('')}</div>`
                : statusBadge(m?.state || 'absent'),
              editable ? input(`note_${s.id}`, { value: m?.note || '', placeholder: 'اختياري' }) : esc(m?.note || '—'),
            ];
          }), { empty: 'لا يوجد طلاب نشطون.' })}
          ${editable && students.length ? '<button class="btn" style="margin-top:.6rem">حفظ الحضور</button>' : ''}
        </form>` : '<p class="empty">عرّف اللقاءات أولًا.</p>')}
      ${section('ملخص الحضور حسب اللقاءات', table(['اللقاء', 'مسجَّل', 'حاضر', 'غائب'],
        summary.map((s) => [
          `<a href="/programs/${program.id}/attendance?session=${s.id}">اللقاء ${s.seq}</a>`,
          `<span class="num">${s.recorded || 0}</span>`,
          `<span class="num">${s.present || 0}</span>`,
          `<span class="num">${s.absent || 0}</span>`,
        ]), { empty: 'لا توجد لقاءات.' }))}`, { active: '/programs' });
  });

  router.post('/programs/:id/attendance', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'attendance.manage' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const sessionId = int(ctx.body.session_id, 0);
    const session = get('SELECT * FROM sessions WHERE id = ? AND program_id = ?', sessionId, program.id);
    if (!session) return ctx.notFound('اللقاء غير موجود.');
    const students = all("SELECT * FROM students WHERE program_id = ? AND status <> 'withdrawn'", program.id);
    let saved = 0;
    for (const s of students) {
      const state = String(ctx.body[`state_${s.id}`] || '');
      if (!['present', 'absent', 'late', 'excused'].includes(state)) continue;
      const note = String(ctx.body[`note_${s.id}`] || '').trim() || null;
      run(`INSERT INTO attendance (session_id, student_id, state, note, recorded_by)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (session_id, student_id)
           DO UPDATE SET state = excluded.state, note = excluded.note,
                         recorded_by = excluded.recorded_by, recorded_at = datetime('now')`,
        sessionId, s.id, state, note, ctx.user.id);
      saved += 1;
    }
    run("UPDATE sessions SET status = 'held' WHERE id = ? AND status = 'planned'", sessionId);
    audit({ user: ctx.user, action: 'attendance.save', entityType: 'session', entityId: sessionId, programId: program.id, after: { saved }, ip: ctx.ip });
    ctx.redirect(`/programs/${program.id}/attendance?session=${sessionId}`, `حُفظ حضور ${saved} طالبًا.`);
  });

  // ------------------------------ المعلمون ------------------------------
  router.get('/programs/:id/teachers', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const teachers = all(
      `SELECT DISTINCT t.*, u.full_name AS verifier
         FROM teachers t
         LEFT JOIN users u ON u.id = t.verified_by
        WHERE t.id IN (SELECT teacher_id FROM sessions WHERE program_id = ? AND teacher_id IS NOT NULL)
           OR NOT EXISTS (SELECT 1 FROM sessions WHERE program_id = ? AND teacher_id IS NOT NULL)
        ORDER BY t.full_name`, program.id, program.id,
    );
    const editable = can(perms, 'teacher.verify') && program.status !== 'closed';
    const statusMap = { pending: badge('بانتظار التحقق', 'warn'), approved: badge('مناسب ومعتمد', 'good'), rejected: badge('غير مناسب', 'bad') };

    ctx.render('المعلمون', programHead(program, 'teachers') + `
      ${section('المعلمون والتحقق من مناسبتهم', teachers.length ? teachers.map((t) => {
        const evid = all("SELECT * FROM evidences WHERE entity_type = 'teacher' AND entity_id = ? ORDER BY id DESC", t.id);
        return `<div class="check-item">
          <div class="text">${esc(t.full_name)} ${statusMap[t.suitability_status] || ''}</div>
          <p class="hint">${esc(t.specialization || '—')} · وثائق: ${esc(t.credentials_note || '—')} · تزكية: ${esc(t.recommendation_ref || '—')}</p>
          ${t.verified_at ? `<p class="hint">تحقق: ${esc(t.verifier || '—')} في ${fmtDate(t.verified_at)} — ${esc(t.verify_note || '')}</p>` : ''}
          ${evidenceList(evid)}
          ${editable ? `<form method="post" action="/programs/${program.id}/teachers/verify" class="row-form">
            <input type="hidden" name="teacher_id" value="${t.id}">
            ${select('status', [{ value: 'approved', label: 'مناسب ومعتمد' }, { value: 'rejected', label: 'غير مناسب' }, { value: 'pending', label: 'بانتظار التحقق' }], t.suitability_status)}
            ${input('note', { value: t.verify_note || '', placeholder: 'نتيجة التحقق ومستنده' })}
            <button class="btn small">توثيق نتيجة التحقق</button>
          </form>
          ${evidenceForm('teacher', t.id, `/programs/${program.id}/teachers`)}` : ''}
        </div>`;
      }).join('') : '<p class="empty">لا يوجد معلمون مرتبطون بهذا البرنامج.</p>')}
      ${editable ? section('إضافة معلم', `
        <form method="post" action="/programs/${program.id}/teachers">
          <div class="form-grid">
            ${field('الاسم', input('full_name', { required: true }))}
            ${field('الجوال', input('phone'))}
            ${field('التخصص', input('specialization'))}
            ${field('وثائق الإثبات', input('credentials_note'))}
            ${field('التزكية المعتبرة', input('recommendation_ref'))}
          </div>
          <button class="btn">إضافة</button>
        </form>`) : ''}`, { active: '/programs' });
  });

  router.post('/programs/:id/teachers', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'teacher.verify' }); if (!loaded) return;
    if (!ensureOpen(ctx, loaded.program)) return;
    const name = String(ctx.body.full_name || '').trim();
    if (!name) return ctx.redirect(`/programs/${loaded.program.id}/teachers`, 'اسم المعلم مطلوب.', 'err');
    run(`INSERT INTO teachers (full_name, phone, specialization, credentials_note, recommendation_ref)
         VALUES (?, ?, ?, ?, ?)`,
      name, ctx.body.phone || null, ctx.body.specialization || null,
      ctx.body.credentials_note || null, ctx.body.recommendation_ref || null);
    audit({ user: ctx.user, action: 'teacher.create', entityType: 'teacher', entityId: null, programId: loaded.program.id, after: { name }, ip: ctx.ip });
    ctx.redirect(`/programs/${loaded.program.id}/teachers`, 'أُضيف المعلم.');
  });

  router.post('/programs/:id/teachers/verify', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'teacher.verify' }); if (!loaded) return;
    if (!ensureOpen(ctx, loaded.program)) return;
    const t = get('SELECT * FROM teachers WHERE id = ?', ctx.body.teacher_id);
    if (!t) return ctx.notFound();
    const status = String(ctx.body.status || 'pending');
    if (!['pending', 'approved', 'rejected'].includes(status)) return ctx.deny('حالة غير صحيحة.');
    run(`UPDATE teachers SET suitability_status = ?, verify_note = ?, verified_by = ?, verified_at = datetime('now') WHERE id = ?`,
      status, String(ctx.body.note || '').trim() || null, ctx.user.id, t.id);
    audit({ user: ctx.user, action: 'teacher.verify', entityType: 'teacher', entityId: t.id, programId: loaded.program.id, before: { status: t.suitability_status }, after: { status }, ip: ctx.ip });
    ctx.redirect(`/programs/${loaded.program.id}/teachers`, 'وُثّقت نتيجة التحقق.');
  });

  // ------------------------------ الأنشطة ------------------------------
  router.get('/programs/:id/activities', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const rows = all(
      `SELECT a.*, (SELECT s.id FROM surveys s WHERE s.activity_id = a.id LIMIT 1) AS survey_id
         FROM activities a WHERE a.program_id = ? ORDER BY a.activity_date DESC, a.id DESC`, program.id,
    );
    const editable = can(perms, 'activity.manage') && program.status !== 'closed';
    ctx.render('الأنشطة', programHead(program, 'activities') + `
      ${section('سجل الأنشطة', table(['النشاط', 'النوع', 'رئيس؟', 'التاريخ', 'الحالة', 'قياس الفاعلية'],
        rows.map((a) => [
          esc(a.name), esc(a.kind || '—'), a.is_main ? badge('رئيس', 'info') : '—',
          fmtDate(a.activity_date), statusBadge(a.status),
          a.survey_id ? `<a class="btn sec small" href="/surveys/${a.survey_id}">الاستبانة</a>`
            : a.is_main ? badge('بانتظار التوليد', 'warn') : '—',
        ]), { empty: 'لم تُسجَّل أنشطة بعد.' }),
        { actions: badge('BR-09: فاعلية النشاط الرئيس تقاس مباشرة بعد كل نشاط', 'muted') })}
      ${editable ? section('تسجيل نشاط', `
        <form method="post" action="/programs/${program.id}/activities">
          <div class="form-grid">
            ${field('اسم النشاط', input('name', { required: true }))}
            ${field('النوع', input('kind', { placeholder: 'إثرائي / تطبيقي' }))}
            ${field('التاريخ', input('activity_date', { type: 'date', value: today() }))}
            ${field('الحالة', select('status', [{ value: 'planned', label: 'مخطط' }, { value: 'done', label: 'منفّذ' }], 'planned'))}
          </div>
          ${field('ملاحظات', textarea('notes', { rows: 2 }))}
          <label class="inline"><input type="checkbox" name="is_main" value="1" style="width:auto"> نشاط رئيس (يولّد استبانة فاعلية من 3 أسئلة عند الإنجاز)</label>
          <p style="margin-top:.7rem"><button class="btn">حفظ النشاط</button></p>
        </form>`) : ''}`, { active: '/programs' });
  });

  router.post('/programs/:id/activities', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'activity.manage' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const name = String(ctx.body.name || '').trim();
    if (!name) return ctx.redirect(`/programs/${program.id}/activities`, 'اسم النشاط مطلوب.', 'err');
    const isMain = ctx.body.is_main ? 1 : 0;
    const status = ['planned', 'done', 'cancelled'].includes(ctx.body.status) ? ctx.body.status : 'planned';
    const res = run(
      `INSERT INTO activities (program_id, name, kind, is_main, activity_date, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      program.id, name, ctx.body.kind || null, isMain,
      String(ctx.body.activity_date || today()).slice(0, 10), ctx.body.notes || null, status, ctx.user.id,
    );
    const id = Number(res.lastInsertRowid);
    let msg = 'حُفظ النشاط.';
    if (isMain && status === 'done') {
      scheduleMainActivityTask(id);
      msg = 'حُفظ النشاط وأُنشئت مهمة قياس فاعلية النشاط الرئيس.';
    }
    audit({ user: ctx.user, action: 'activity.create', entityType: 'activity', entityId: id, programId: program.id, after: { name, isMain, status }, ip: ctx.ip });
    ctx.redirect(`/programs/${program.id}/activities`, msg);
  });

  // ------------------------------ الشكاوى ------------------------------
  router.get('/programs/:id/complaints', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const rows = all(
      `SELECT c.*, u.full_name AS assignee, v.full_name AS verifier,
              (SELECT COUNT(*) FROM evidences e WHERE e.entity_type = 'complaint' AND e.entity_id = c.id) AS evidence_count
         FROM complaints c LEFT JOIN users u ON u.id = c.assigned_to
         LEFT JOIN users v ON v.id = c.verified_by
        WHERE c.program_id = ? ORDER BY c.status = 'closed', c.due_date`, program.id,
    );
    const team = all(
      `SELECT u.id, u.full_name FROM program_assignments a JOIN users u ON u.id = a.user_id
        WHERE a.program_id = ? GROUP BY u.id ORDER BY u.full_name`, program.id,
    );
    const editable = can(perms, 'complaint.manage') && program.status !== 'closed';
    const canVerify = can(perms, 'complaint.verify');
    const now = today();

    ctx.render('الشكاوى والمقترحات', programHead(program, 'complaints') + `
      ${section('السجل', table(['الرمز', 'العنوان', 'النوع', 'المسؤول', 'المدة (SLA)', 'الحالة', 'الشواهد', 'التحقق النهائي', ''],
        rows.map((c) => {
          const late = c.status !== 'closed' && c.due_date && c.due_date < now;
          return [
            esc(c.ref_code || `#${c.id}`), esc(c.title),
            c.kind === 'suggestion' ? badge('مقترح', 'info') : badge('شكوى', 'warn'),
            esc(c.assignee || '—'),
            `${fmtDate(c.due_date)} ${late ? badge('متجاوز', 'bad') : ''}`,
            statusBadge(c.status),
            c.evidence_count ? badge(`${c.evidence_count}`, 'good') : badge('بلا شواهد', 'warn'),
            c.verified_at ? badge(`تحقق: ${c.verifier || ''}`, 'good') : badge('لم يتم', 'muted'),
            `<a class="btn sec small" href="/complaints/${c.id}">فتح</a>`,
          ];
        }), { empty: 'لا توجد شكاوى أو مقترحات.' }),
        { actions: badge(canVerify ? 'لك صلاحية التحقق النهائي' : 'التحقق النهائي لمدير التخطيط والجودة', 'muted') })}
      ${editable ? section('تسجيل شكوى أو مقترح', `
        <form method="post" action="/programs/${program.id}/complaints">
          <div class="form-grid">
            ${field('العنوان', input('title', { required: true }))}
            ${field('النوع', select('kind', [{ value: 'complaint', label: 'شكوى' }, { value: 'suggestion', label: 'مقترح' }], 'complaint'))}
            ${field('المصدر', input('source', { placeholder: 'طالب / ولي أمر / معلم' }))}
            ${field('المسؤول', select('assigned_to', team.map((t) => ({ value: t.id, label: t.full_name })), ctx.user.id, { placeholder: 'بدون' }))}
            ${field('مدة المعالجة بالأيام', input('sla_days', { type: 'number', value: SLA_DEFAULT, attrs: 'min="1" max="60"' }))}
          </div>
          ${field('التفاصيل', textarea('body', { rows: 3 }))}
          <button class="btn">تسجيل</button>
        </form>`) : ''}`, { active: '/programs' });
  });

  router.post('/programs/:id/complaints', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'complaint.manage' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const title = String(ctx.body.title || '').trim();
    if (!title) return ctx.redirect(`/programs/${program.id}/complaints`, 'عنوان الشكوى مطلوب.', 'err');
    const sla = Math.min(60, Math.max(1, int(ctx.body.sla_days, SLA_DEFAULT)));
    const nextNum = Number(get('SELECT COUNT(*) c FROM complaints WHERE program_id = ?', program.id).c) + 1;
    const res = run(
      `INSERT INTO complaints (program_id, ref_code, kind, source, title, body, sla_days, due_date, assigned_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      program.id, `C-${String(nextNum).padStart(3, '0')}`,
      ctx.body.kind === 'suggestion' ? 'suggestion' : 'complaint',
      ctx.body.source || null, title, ctx.body.body || null, sla, addDays(today(), sla),
      int(ctx.body.assigned_to, 0) || null,
    );
    audit({ user: ctx.user, action: 'complaint.create', entityType: 'complaint', entityId: Number(res.lastInsertRowid), programId: program.id, after: { title, sla }, ip: ctx.ip });
    ctx.redirect(`/programs/${program.id}/complaints`, 'سُجّلت الشكوى وحُدّدت مدة المعالجة.');
  });

  router.get('/complaints/:cid', (ctx) => {
    const c = get(
      `SELECT c.*, p.name AS program_name, p.status AS program_status,
              u.full_name AS assignee, v.full_name AS verifier
         FROM complaints c JOIN programs p ON p.id = c.program_id
         LEFT JOIN users u ON u.id = c.assigned_to LEFT JOIN users v ON v.id = c.verified_by
        WHERE c.id = ?`, ctx.params.cid,
    );
    if (!c) return ctx.notFound();
    ctx.params.id = c.program_id;
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { perms } = loaded;
    const evid = all("SELECT * FROM evidences WHERE entity_type = 'complaint' AND entity_id = ? ORDER BY id DESC", c.id);
    const editable = can(perms, 'complaint.manage') && c.program_status !== 'closed';
    const canVerify = can(perms, 'complaint.verify');

    ctx.render(c.title, `
      <div class="crumbs"><a href="/programs/${c.program_id}/complaints">${esc(c.program_name)} — الشكاوى</a></div>
      <div class="pagehead"><div>
        <h1>${esc(c.ref_code || '')} — ${esc(c.title)} ${statusBadge(c.status)}</h1>
        <p class="meta">المصدر: ${esc(c.source || '—')} · المسؤول: ${esc(c.assignee || '—')} ·
          فُتحت ${fmtDate(c.opened_at)} · تستحق المعالجة ${fmtDate(c.due_date)} (${c.sla_days} أيام)</p>
      </div></div>
      ${section('التفاصيل', `<p>${esc(c.body || '—')}</p>
        ${c.closed_at ? `<p class="hint">أُغلقت ${fmtDate(c.closed_at)} — ${esc(c.close_note || '')}</p>` : ''}
        ${c.verified_at ? `<p class="hint">التحقق النهائي: ${esc(c.verifier || '')} في ${fmtDate(c.verified_at)}</p>` : ''}`)}
      ${editable && c.status !== 'closed' ? section('المعالجة', `
        <form method="post" action="/complaints/${c.id}/update" class="row-form">
          ${select('status', [{ value: 'open', label: 'مفتوحة' }, { value: 'in_progress', label: 'قيد المعالجة' }], c.status)}
          <button class="btn small sec">تحديث الحالة</button>
        </form>
        <form method="post" action="/complaints/${c.id}/close">
          ${field('ملاحظة الإغلاق', textarea('close_note', { rows: 2, required: true }))}
          <button class="btn">إغلاق الشكوى</button>
        </form>`) : ''}
      ${canVerify && c.status === 'closed' && !c.verified_at ? section('التحقق النهائي', `
        <p class="hint">يتحقق مدير التخطيط والجودة في نهاية البرنامج من إغلاق الشكاوى واستكمال توثيقها.</p>
        <form method="post" action="/complaints/${c.id}/verify">
          <button class="btn">اعتماد التحقق النهائي</button>
        </form>`) : ''}
      ${section('الشواهد', evidenceList(evid) + (editable ? evidenceForm('complaint', c.id, `/complaints/${c.id}`) : ''))}`,
    { active: '/programs' });
  });

  router.post('/complaints/:cid/update', (ctx) => {
    const c = get('SELECT * FROM complaints WHERE id = ?', ctx.params.cid);
    if (!c) return ctx.notFound();
    ctx.params.id = c.program_id;
    const loaded = loadProgram(ctx, { perm: 'complaint.manage' }); if (!loaded) return;
    const status = ['open', 'in_progress'].includes(ctx.body.status) ? ctx.body.status : 'open';
    run('UPDATE complaints SET status = ? WHERE id = ?', status, c.id);
    audit({ user: ctx.user, action: 'complaint.update', entityType: 'complaint', entityId: c.id, programId: c.program_id, before: { status: c.status }, after: { status }, ip: ctx.ip });
    ctx.redirect(`/complaints/${c.id}`, 'حُدّثت الحالة.');
  });

  router.post('/complaints/:cid/close', (ctx) => {
    const c = get('SELECT * FROM complaints WHERE id = ?', ctx.params.cid);
    if (!c) return ctx.notFound();
    ctx.params.id = c.program_id;
    const loaded = loadProgram(ctx, { perm: 'complaint.manage' }); if (!loaded) return;
    const note = String(ctx.body.close_note || '').trim();
    if (!note) return ctx.redirect(`/complaints/${c.id}`, 'ملاحظة الإغلاق مطلوبة للتوثيق.', 'err');
    run("UPDATE complaints SET status = 'closed', closed_at = datetime('now'), close_note = ? WHERE id = ?", note, c.id);
    audit({ user: ctx.user, action: 'complaint.close', entityType: 'complaint', entityId: c.id, programId: c.program_id, before: { status: c.status }, after: { status: 'closed', note }, ip: ctx.ip });
    ctx.redirect(`/complaints/${c.id}`, 'أُغلقت الشكوى. أرفق الشواهد لاستكمال التوثيق.');
  });

  router.post('/complaints/:cid/verify', (ctx) => {
    const c = get('SELECT * FROM complaints WHERE id = ?', ctx.params.cid);
    if (!c) return ctx.notFound();
    ctx.params.id = c.program_id;
    const loaded = loadProgram(ctx, { perm: 'complaint.verify' }); if (!loaded) return;
    if (c.status !== 'closed') return ctx.redirect(`/complaints/${c.id}`, 'لا يمكن التحقق قبل إغلاق الشكوى.', 'err');
    run("UPDATE complaints SET verified_by = ?, verified_at = datetime('now') WHERE id = ?", ctx.user.id, c.id);
    audit({ user: ctx.user, action: 'complaint.verify', entityType: 'complaint', entityId: c.id, programId: c.program_id, after: { verified_by: ctx.user.id }, ip: ctx.ip });
    ctx.redirect(`/complaints/${c.id}`, 'اعتُمد التحقق النهائي.');
  });

  // ------------------------------ المتابعة والانضباط --------------------
  router.get('/programs/:id/discipline', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const rows = all(
      `SELECT d.*, s.full_name AS student_name FROM discipline_cases d
         LEFT JOIN students s ON s.id = d.student_id
        WHERE d.program_id = ? ORDER BY d.status = 'closed', d.opened_at DESC`, program.id,
    );
    const students = all('SELECT * FROM students WHERE program_id = ? ORDER BY full_name', program.id);
    const editable = can(perms, 'discipline.manage') && program.status !== 'closed';
    const kinds = [
      { value: 'attendance', label: 'انقطاع أو تأخر متكرر' },
      { value: 'behavior', label: 'سلوك' },
      { value: 'academic', label: 'تعثر دراسي' },
    ];
    ctx.render('المتابعة والانضباط', programHead(program, 'discipline') + `
      ${section('الحالات المتعثرة والإجراءات', table(['الطالب', 'النوع', 'الوصف', 'الإجراء', 'قناة التواصل', 'الحالة', ''],
        rows.map((d) => [
          esc(d.student_name || '—'),
          esc(kinds.find((k) => k.value === d.kind)?.label || d.kind),
          esc(d.description), esc(d.action || '—'), esc(d.channel || '—'), statusBadge(d.status),
          editable && d.status !== 'closed' ? `<form method="post" action="/programs/${program.id}/discipline/close" class="inline">
            <input type="hidden" name="case_id" value="${d.id}"><button class="btn small sec">إغلاق</button></form>` : '',
        ]), { empty: 'لا توجد حالات مسجلة.' }))}
      ${editable ? section('تسجيل حالة', `
        <form method="post" action="/programs/${program.id}/discipline">
          <div class="form-grid">
            ${field('الطالب', select('student_id', students.map((s) => ({ value: s.id, label: s.full_name })), '', { placeholder: 'غير محدد' }))}
            ${field('النوع', select('kind', kinds, 'attendance'))}
            ${field('قناة التواصل', input('channel', { placeholder: 'اتصال / رسالة / لقاء' }))}
          </div>
          ${field('الوصف', textarea('description', { rows: 2, required: true }))}
          ${field('الإجراء المتخذ', textarea('action', { rows: 2 }))}
          <button class="btn">تسجيل الحالة</button>
        </form>`) : ''}`, { active: '/programs' });
  });

  router.post('/programs/:id/discipline', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'discipline.manage' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const description = String(ctx.body.description || '').trim();
    if (!description) return ctx.redirect(`/programs/${program.id}/discipline`, 'وصف الحالة مطلوب.', 'err');
    const res = run(
      `INSERT INTO discipline_cases (program_id, student_id, kind, description, action, channel, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      program.id, int(ctx.body.student_id, 0) || null,
      ['attendance', 'behavior', 'academic'].includes(ctx.body.kind) ? ctx.body.kind : 'attendance',
      description, String(ctx.body.action || '').trim() || null, ctx.body.channel || null, ctx.user.id,
    );
    audit({ user: ctx.user, action: 'discipline.create', entityType: 'discipline_case', entityId: Number(res.lastInsertRowid), programId: program.id, after: { description }, ip: ctx.ip });
    ctx.redirect(`/programs/${program.id}/discipline`, 'سُجّلت الحالة.');
  });

  router.post('/programs/:id/discipline/close', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'discipline.manage' }); if (!loaded) return;
    const c = get('SELECT * FROM discipline_cases WHERE id = ? AND program_id = ?', ctx.body.case_id, loaded.program.id);
    if (!c) return ctx.notFound();
    run("UPDATE discipline_cases SET status = 'closed', closed_at = datetime('now') WHERE id = ?", c.id);
    audit({ user: ctx.user, action: 'discipline.close', entityType: 'discipline_case', entityId: c.id, programId: c.program_id, ip: ctx.ip });
    ctx.redirect(`/programs/${loaded.program.id}/discipline`, 'أُغلقت الحالة.');
  });

  // ------------------------------ الاستمرارية ---------------------------
  router.get('/programs/:id/continuity', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const students = all('SELECT * FROM students WHERE program_id = ? ORDER BY full_name', program.id);
    const stats = get(
      `SELECT COUNT(*) total, SUM(status = 'withdrawn') withdrawn,
              SUM(intent_continue = 1) intent_yes, SUM(intent_continue IS NOT NULL) intent_asked
         FROM students WHERE program_id = ?`, program.id,
    );
    const startCount = Math.max(Number(stats?.total || 0), Number(program.planned_students || 0));
    const stayed = Number(stats?.total || 0) - Number(stats?.withdrawn || 0);
    const editable = can(perms, 'continuity.manage') && program.status !== 'closed';

    ctx.render('الاستمرارية', programHead(program, 'continuity') + `
      <div class="stats">
        ${statCard({ label: 'أعداد البداية', value: startCount })}
        ${statCard({ label: 'المستمرون', value: stayed, tone: 'good' })}
        ${statCard({ label: 'الانسحابات', value: Number(stats?.withdrawn || 0), tone: Number(stats?.withdrawn || 0) ? 'warn' : 'good' })}
        ${statCard({ label: 'الاستمرار الفعلي', value: startCount ? `${((stayed / startCount) * 100).toFixed(1)}%` : '—', sub: 'BR-10 — 15 درجة' })}
        ${statCard({ label: 'نية الاستمرار', value: Number(stats?.intent_asked || 0) ? `${((Number(stats.intent_yes) / Number(stats.intent_asked)) * 100).toFixed(1)}%` : '—', sub: `سُئل ${Number(stats?.intent_asked || 0)} — 5 درجات` })}
      </div>
      ${section('حالة الطلاب ونية الاستمرار', `
        <form method="post" action="/programs/${program.id}/continuity">
          ${table(['الطالب', 'الحالة', 'سبب الانسحاب', 'نية الاستمرار'], students.map((s) => [
            esc(s.full_name),
            editable ? select(`status_${s.id}`, [
              { value: 'active', label: 'مستمر' }, { value: 'completed', label: 'أكمل' }, { value: 'withdrawn', label: 'منسحب' },
            ], s.status) : statusBadge(s.status),
            editable ? input(`reason_${s.id}`, { value: s.withdraw_reason || '', placeholder: 'عند الانسحاب' }) : esc(s.withdraw_reason || '—'),
            editable ? select(`intent_${s.id}`, [
              { value: '', label: 'لم يُسأل' }, { value: '1', label: 'نعم' }, { value: '0', label: 'لا' },
            ], s.intent_continue === null || s.intent_continue === undefined ? '' : String(s.intent_continue))
              : (s.intent_continue === 1 ? badge('نعم', 'good') : s.intent_continue === 0 ? badge('لا', 'bad') : badge('لم يُسأل', 'muted')),
          ]), { empty: 'لا يوجد طلاب.' })}
          ${editable && students.length ? '<button class="btn" style="margin-top:.6rem">حفظ الاستمرارية</button>' : ''}
        </form>
        <p class="hint">BR-10: 5 درجات لنية الاستمرار + 15 درجة للاستمرار الفعلي.
        تُجمع نية الاستمرار من استبانة النهاية أو التواصل المباشر وتُسجَّل هنا لكل طالب.</p>`)}`,
    { active: '/programs' });
  });

  router.post('/programs/:id/continuity', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'continuity.manage' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const students = all('SELECT * FROM students WHERE program_id = ?', program.id);
    let changed = 0;
    for (const s of students) {
      const status = String(ctx.body[`status_${s.id}`] || s.status);
      if (!['active', 'completed', 'withdrawn'].includes(status)) continue;
      const reason = String(ctx.body[`reason_${s.id}`] || '').trim() || null;
      const intentRaw = ctx.body[`intent_${s.id}`];
      const intent = intentRaw === '1' ? 1 : intentRaw === '0' ? 0 : null;
      run(`UPDATE students SET status = ?, withdraw_reason = ?, intent_continue = ?,
                  withdrawn_at = CASE WHEN ? = 'withdrawn' AND withdrawn_at IS NULL THEN date('now')
                                      WHEN ? <> 'withdrawn' THEN NULL ELSE withdrawn_at END
            WHERE id = ?`, status, reason, intent, status, status, s.id);
      changed += 1;
    }
    audit({ user: ctx.user, action: 'continuity.save', entityType: 'program', entityId: program.id, programId: program.id, after: { changed }, ip: ctx.ip });
    ctx.redirect(`/programs/${program.id}/continuity`, 'حُفظت بيانات الاستمرارية.');
  });

  // ------------------------------ الإجراءات (كانبان) --------------------
  router.get('/programs/:id/actions', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const rows = all(
      `SELECT a.*, u.full_name AS owner_name FROM corrective_actions a
         LEFT JOIN users u ON u.id = a.owner_id WHERE a.program_id = ? ORDER BY a.due_date`, program.id,
    );
    const team = all(
      `SELECT u.id, u.full_name FROM program_assignments a JOIN users u ON u.id = a.user_id
        WHERE a.program_id = ? GROUP BY u.id ORDER BY u.full_name`, program.id,
    );
    const editable = can(perms, 'action.manage') && program.status !== 'closed';
    const now = today();
    const cols = [
      ['open', 'مفتوح'], ['in_progress', 'قيد التنفيذ'], ['done', 'منجز'], ['cancelled', 'ملغى'],
    ];
    const card = (a) => `<div class="card">
      <div class="t">${esc(a.title)}</div>
      <small>${a.kind === 'improvement' ? 'تحسيني' : 'تصحيحي'} · ${esc(a.owner_name || 'بلا مسؤول')} ·
        ${a.due_date ? (a.due_date < now && a.status !== 'done' ? `<span style="color:var(--bad)">${fmtDate(a.due_date)}</span>` : fmtDate(a.due_date)) : 'بلا موعد'}</small>
      ${a.description ? `<div><small class="muted">${esc(a.description).slice(0, 160)}</small></div>` : ''}
      ${editable ? `<form method="post" action="/programs/${program.id}/actions/move" class="row-form">
        <input type="hidden" name="action_id" value="${a.id}">
        ${select('status', cols.map(([v, l]) => ({ value: v, label: l })), a.status)}
        <button class="btn small sec">نقل</button></form>` : ''}
    </div>`;

    ctx.render('الإجراءات التصحيحية والتحسينية', programHead(program, 'actions') + `
      ${section('لوحة الإجراءات', `<div class="kanban">${cols.map(([key, label]) => `
        <div class="col"><h3>${esc(label)} (${rows.filter((a) => a.status === key).length})</h3>
        ${rows.filter((a) => a.status === key).map(card).join('') || '<p class="empty">—</p>'}</div>`).join('')}</div>`)}
      ${editable ? section('إضافة إجراء', `
        <form method="post" action="/programs/${program.id}/actions">
          <div class="form-grid">
            ${field('العنوان', input('title', { required: true }))}
            ${field('النوع', select('kind', [{ value: 'corrective', label: 'تصحيحي' }, { value: 'improvement', label: 'تحسيني' }], 'corrective'))}
            ${field('المسؤول', select('owner_id', team.map((t) => ({ value: t.id, label: t.full_name })), ctx.user.id, { placeholder: 'بدون' }))}
            ${field('الموعد', input('due_date', { type: 'date', value: addDays(today(), 7) }))}
          </div>
          ${field('الوصف', textarea('description', { rows: 2 }))}
          <button class="btn">إضافة</button>
        </form>`) : ''}`, { active: '/programs' });
  });

  router.post('/programs/:id/actions', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'action.manage' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const title = String(ctx.body.title || '').trim();
    if (!title) return ctx.redirect(`/programs/${program.id}/actions`, 'عنوان الإجراء مطلوب.', 'err');
    const res = run(
      `INSERT INTO corrective_actions (program_id, kind, origin_type, title, description, owner_id, due_date, created_by)
       VALUES (?, ?, 'manual', ?, ?, ?, ?, ?)`,
      program.id, ctx.body.kind === 'improvement' ? 'improvement' : 'corrective',
      title, ctx.body.description || null, int(ctx.body.owner_id, 0) || null,
      String(ctx.body.due_date || '').slice(0, 10) || null, ctx.user.id,
    );
    audit({ user: ctx.user, action: 'action.create', entityType: 'corrective_action', entityId: Number(res.lastInsertRowid), programId: program.id, after: { title }, ip: ctx.ip });
    ctx.redirect(`/programs/${program.id}/actions`, 'أُضيف الإجراء.');
  });

  router.post('/programs/:id/actions/move', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'action.manage' }); if (!loaded) return;
    const a = get('SELECT * FROM corrective_actions WHERE id = ? AND program_id = ?', ctx.body.action_id, loaded.program.id);
    if (!a) return ctx.notFound();
    const status = ['open', 'in_progress', 'done', 'cancelled'].includes(ctx.body.status) ? ctx.body.status : a.status;
    run(`UPDATE corrective_actions SET status = ?, closed_at = CASE WHEN ? IN ('done','cancelled') THEN datetime('now') ELSE NULL END WHERE id = ?`,
      status, status, a.id);
    audit({ user: ctx.user, action: 'action.move', entityType: 'corrective_action', entityId: a.id, programId: a.program_id, before: { status: a.status }, after: { status }, ip: ctx.ip });
    refreshNotifications({ programId: a.program_id });
    ctx.redirect(`/programs/${loaded.program.id}/actions`, 'حُدّثت حالة الإجراء.');
  });
}
