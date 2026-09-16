import { all, get, run } from '../db/index.js';
import { esc, fmtDate, fmtNum, int, today, addDays } from '../lib/util.js';
import {
  statCard, table, section, statusBadge, badge, progress, select, field, input, textarea, evidenceList, evidenceForm,
} from '../views/ui.js';
import { ROLES, ROLE_KEYS, roleName, can } from '../lib/roles.js';
import { programsForUser } from '../lib/auth.js';
import { computeProgram, missingMeasurements, notMetItems } from '../lib/scoring.js';
import { syncProgramTasks, closureReadiness, refreshNotifications } from '../lib/scheduler.js';
import { audit, auditForProgram } from '../lib/audit.js';
import { loadProgram, ensureOpen, programHead } from './_helpers.js';
import registerOperations from './operations.js';

/** قائمة البرامج + إنشاء برنامج جديد. */
function programsList(ctx) {
  const programs = programsForUser(ctx.user);
  const canCreate = ctx.user.global_role === 'admin' || ctx.user.global_role === 'quality_manager';
  const venues = all('SELECT * FROM venues ORDER BY name');

  const rows = programs.map((p) => {
    const r = computeProgram(p.id);
    return [
      `<a href="/programs/${p.id}">${esc(p.name)}</a><br><small class="muted">${esc(p.code || '')}</small>`,
      `<small class="muted">${fmtDate(p.start_date)} — ${fmtDate(p.end_date)}</small>`,
      statusBadge(p.status),
      `<span class="num">${fmtNum(r?.earned)} / 300</span>`,
      progress(r?.quality_pct, { label: 'الجودة' }),
      progress(r?.coverage_pct, { label: 'الاكتمال' }),
    ];
  });

  const createForm = canCreate ? section('إنشاء برنامج جديد', `
    <form method="post" action="/programs">
      <div class="form-grid">
        ${field('اسم البرنامج', input('name', { required: true }))}
        ${field('الرمز', input('code', { placeholder: 'PRG-002' }))}
        ${field('النوع', input('kind', { placeholder: 'دورة تدريبية' }))}
        ${field('الفترة', input('term', { placeholder: 'الفصل الأول 2026' }))}
        ${field('تاريخ البداية', input('start_date', { type: 'date', required: true }))}
        ${field('تاريخ النهاية', input('end_date', { type: 'date', required: true }))}
        ${field('القاعة/الموقع', select('venue_id', venues.map((v) => ({ value: v.id, label: `${v.name} — ${v.location || ''}` })), '', { placeholder: 'بدون تحديد' }))}
        ${field('عدد اللقاءات', input('planned_sessions', { type: 'number', value: 12, attrs: 'min="1" max="200"' }))}
        ${field('عدد الطلاب عند البداية', input('planned_students', { type: 'number', value: 0, attrs: 'min="0"' }))}
      </div>
      <label class="inline"><input type="checkbox" name="generate_sessions" value="1" checked style="width:auto"> توليد اللقاءات وجدول القياسات تلقائيًا</label>
      <p style="margin-top:.7rem"><button class="btn">إنشاء البرنامج</button></p>
    </form>`) : '';

  return `<div class="pagehead"><div><h1>البرامج</h1>
    <p class="meta">${programs.length} برنامجًا مسندًا إليك</p></div></div>
    ${section('قائمة البرامج', table(
      ['البرنامج', 'الفترة', 'الحالة', 'الدرجة من 300', 'نتيجة الجودة', 'اكتمال القياس'],
      rows, { empty: 'لا توجد برامج.' },
    ))}
    ${createForm}`;
}

/** نظرة عامة على البرنامج. */
function overview(ctx, program) {
  const r = computeProgram(program.id);
  const gaps = missingMeasurements(program.id);
  const tasks = get(
    `SELECT SUM(status = 'pending') pending, SUM(status = 'done') done,
            SUM(status = 'pending' AND due_date < date('now')) overdue
       FROM tasks WHERE program_id = ?`, program.id,
  );
  const students = get(
    `SELECT COUNT(*) total, SUM(status = 'withdrawn') withdrawn FROM students WHERE program_id = ?`, program.id,
  );
  const complaints = get(
    `SELECT COUNT(*) total, SUM(status <> 'closed') open FROM complaints WHERE program_id = ?`, program.id,
  );
  const actions = get(
    `SELECT COUNT(*) total, SUM(status IN ('open','in_progress')) open FROM corrective_actions WHERE program_id = ?`, program.id,
  );
  const team = all(
    `SELECT a.role, u.full_name FROM program_assignments a JOIN users u ON u.id = a.user_id
      WHERE a.program_id = ? ORDER BY a.role`, program.id,
  );

  const sectionRows = (r?.sections || []).map((s) => [
    esc(s.section.name),
    `<span class="num">${fmtNum(s.earned)} / ${fmtNum(s.weight)}</span>`,
    progress(s.score_pct, { label: 'الجودة' }),
    progress(s.coverage_pct, { label: 'الاكتمال' }),
  ]);

  return `
  <div class="stats">
    ${statCard({ label: 'الدرجة الحالية من 300', value: fmtNum(r?.earned), sub: `مقيس منها ${fmtNum(r?.measured_weight)} درجة` })}
    ${statCard({ label: 'نتيجة الجودة على المقيس', value: r?.quality_pct === null ? '—' : `${fmtNum(r.quality_pct)}%`, tone: (r?.quality_pct ?? 0) >= 85 ? 'good' : (r?.quality_pct ?? 0) >= 60 ? 'warn' : 'bad' })}
    ${statCard({ label: 'اكتمال القياس', value: `${fmtNum(r?.coverage_pct)}%`, tone: (r?.coverage_pct ?? 0) >= 90 ? 'good' : 'warn', sub: 'مستقل عن نتيجة الجودة (BR-11)' })}
    ${statCard({ label: 'مهام معلّقة', value: Number(tasks?.pending || 0), sub: `${Number(tasks?.overdue || 0)} متأخرة`, tone: Number(tasks?.overdue || 0) ? 'bad' : '' })}
    ${statCard({ label: 'الطلاب', value: Number(students?.total || 0), sub: `${Number(students?.withdrawn || 0)} منسحبون` })}
    ${statCard({ label: 'شكاوى مفتوحة', value: Number(complaints?.open || 0), tone: Number(complaints?.open || 0) ? 'warn' : 'good' })}
    ${statCard({ label: 'إجراءات مفتوحة', value: Number(actions?.open || 0), tone: Number(actions?.open || 0) ? 'warn' : 'good' })}
    ${statCard({ label: 'القياسات الناقصة', value: gaps.length, tone: gaps.length ? 'warn' : 'good' })}
  </div>

  <div class="grid two">
    ${section('الدرجة حسب الأقسام', table(['القسم', 'الدرجة', 'نتيجة الجودة', 'اكتمال القياس'], sectionRows),
      { actions: `<a class="btn sec small" href="/programs/${program.id}/metric">تفصيل المقياس</a>` })}
    ${section('فريق البرنامج', table(['الدور', 'المسؤول'],
      team.map((t) => [roleName(t.role), esc(t.full_name)]), { empty: 'لم تُسند الأدوار بعد.' }),
      { actions: `<a class="btn sec small" href="/programs/${program.id}/team">إدارة الأدوار</a>` })}
  </div>

  ${gaps.length ? section('القياسات الناقصة', table(['القسم', 'المؤشر', 'المنفّذ/المطلوب', 'المسؤول', 'خطة العينة'],
    gaps.map((g) => [
      esc(g.section), esc(g.indicator.name),
      `<span class="num">${g.completed} / ${g.required}</span>`,
      roleName(g.indicator.owner_role),
      `<small class="muted">${esc(g.sample_label)}</small>`,
    ])), { actions: badge('تمنع إقفال البرنامج', 'warn') }) : ''}`;
}

/** شجرة المقياس الكاملة. */
function metricView(ctx, program, perms) {
  const r = computeProgram(program.id);
  const rows = [];
  for (const s of r.sections) {
    rows.push({ cls: 'section-row', cells: [
      `<strong>${esc(s.section.name)}</strong>`,
      `<span class="num">${fmtNum(s.earned)} / ${fmtNum(s.weight)}</span>`
        + (s.exempt_weight ? `<br><small class="muted">مستثنى ${fmtNum(s.exempt_weight)}</small>` : ''),
      progress(s.score_pct), progress(s.coverage_pct), '',
    ] });
    for (const a of s.axes) {
      rows.push({ cls: 'axis-row', cells: [
        `— ${esc(a.axis.name)}`,
        `<span class="num">${fmtNum(a.earned)} / ${fmtNum(a.weight)}</span>`,
        progress(a.score_pct), progress(a.coverage_pct), '',
      ] });
      for (const n of a.indicators) {
        const tool = { checklist: 'قائمة تحقق', survey: 'استبانة', record: 'سجل تشغيلي' }[n.indicator.tool];
        rows.push({ cls: n.exempt ? 'exempt-row' : '', cells: [
          `<span style="padding-inline-start:1.2rem">${esc(n.indicator.name)}</span>
           ${n.exempt ? ` ${badge('غير منطبق', 'muted')}` : ''}
           <br><small class="muted">${esc(n.indicator.code)} · ${tool} · ${roleName(n.indicator.owner_role)} · ${esc(n.sample_label)}</small>
           ${n.exempt ? `<br><small class="muted">السبب: ${esc(n.exemption.reason)}</small>` : ''}`,
          n.exempt
            ? `<small class="muted">مستثنى (${fmtNum(n.weight)})</small>`
            : `<span class="num">${fmtNum(n.earned)} / ${fmtNum(n.weight)}</span>`,
          n.exempt ? '<span class="muted">—</span>' : progress(n.score_pct),
          n.exempt ? '<span class="muted">—</span>'
            : `${progress(n.coverage_pct)}<small class="muted num">${n.completed} من ${n.required}</small>
               ${n.insufficient?.length ? `<br>${badge(`${n.insufficient.length} عينة غير كافية`, 'bad')}` : ''}`,
          n.exempt ? ''
            : n.indicator.tool === 'checklist'
              ? `<a class="btn sec small" href="/programs/${program.id}/indicator/${n.indicator.id}">السجل</a>`
              : n.indicator.tool === 'survey'
                ? `<a class="btn sec small" href="/programs/${program.id}/surveys">الاستبانات</a>` : '',
        ] });
      }
    }
  }
  const body = `<div class="table-wrap"><table class="compact">
    <thead><tr><th>القسم / المحور / المؤشر</th><th>الدرجة</th><th>نتيجة الجودة</th><th>اكتمال القياس</th><th></th></tr></thead>
    <tbody>${rows.map((x) => `<tr class="${x.cls}">${x.cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr class="section-row"><td><strong>الإجمالي</strong></td>
      <td class="num"><strong>${fmtNum(r.earned)} / ${fmtNum(r.total_weight)}</strong></td>
      <td>${progress(r.quality_pct)}</td><td>${progress(r.coverage_pct)}</td><td></td></tr></tfoot>
  </table></div>`;

  const notMet = notMetItems(program.id);
  const canExempt = can(perms, 'indicator.exempt') && program.status !== 'closed';
  const exemptable = all(
    `SELECT i.id, i.code, i.name, i.weight, a.name AS axis_name, s.name AS section_name
       FROM indicators i
       JOIN metric_axes a ON a.id = i.axis_id
       JOIN metric_sections s ON s.id = a.section_id
      WHERE i.is_active = 1
        AND i.id NOT IN (SELECT indicator_id FROM indicator_exemptions WHERE program_id = ?)
      ORDER BY i.sort`, program.id,
  );

  return `
  <div class="stats">
    ${statCard({
      label: 'الدرجة المحققة',
      value: `${fmtNum(r.earned)} / ${fmtNum(r.total_weight)}`,
      sub: r.exempt_weight ? `الوزن المنطبق بعد استثناء ${fmtNum(r.exempt_weight)} درجة` : 'الوزن الكامل للمقياس',
    })}
    ${statCard({
      label: 'الدرجة المعيارية من 300',
      value: r.normalized_score === null ? '—' : fmtNum(r.normalized_score),
      tone: 'info',
      sub: r.exempt_weight ? 'تُستخدم لمقارنة البرامج المختلفة الاستثناءات' : 'مطابقة للدرجة المحققة',
    })}
    ${statCard({ label: 'نتيجة الجودة', value: r.quality_pct === null ? '—' : `${fmtNum(r.quality_pct)}%`, tone: 'info' })}
    ${statCard({ label: 'اكتمال القياس', value: `${fmtNum(r.coverage_pct)}%`, tone: 'warn' })}
    ${statCard({ label: 'الوزن المقيس', value: `${fmtNum(r.measured_weight)} / ${fmtNum(r.total_weight)}` })}
    ${r.exempt_weight ? statCard({ label: 'وزن مستثنى (غير منطبق)', value: fmtNum(r.exempt_weight), tone: 'muted', sub: `${r.exemptions.length} مؤشرًا` }) : ''}
  </div>
  ${section('شجرة المقياس', body, { actions: `<a class="btn sec small" href="/reports/program/${program.id}/export.csv">تصدير Excel</a>` })}
  ${section('العناصر غير المتحققة والجزئية', table(['المؤشر', 'العنصر', 'الحالة', 'الملاحظة'],
    notMet.map((i) => [
      esc(i.indicator_name), esc(i.item_text),
      i.state === 50 ? badge('جزئي', 'warn') : badge('غير متحقق', 'bad'),
      esc(i.note || '—'),
    ]), { empty: 'لا توجد عناصر غير متحققة.' }),
    { actions: `<a class="btn sec small" href="/programs/${program.id}/actions">الإجراءات التصحيحية</a>` })}

  ${section('المؤشرات غير المنطبقة', `
    <p class="hint">المؤشر الموسوم «غير منطبق» يخرج وزنه من المقياس ومن اكتمال القياس،
      فلا يظهر كقياس ناقص ولا يمنع الإقفال. السبب إلزامي ويُسجَّل في سجل التدقيق،
      والوسم من صلاحية مدير التخطيط والجودة وحده.</p>
    ${table(['المؤشر', 'الوزن المستثنى', 'السبب', 'الموسِم', 'التاريخ', ''],
      r.exemptions.map((e) => {
        const ind = get('SELECT * FROM indicators WHERE id = ?', e.indicator_id);
        return [
          `${esc(ind?.name || '—')}<br><small class="muted">${esc(ind?.code || '')}</small>`,
          `<span class="num">${fmtNum(ind?.weight)}</span>`,
          esc(e.reason), esc(e.by_name || '—'), fmtDate(e.created_at),
          canExempt ? `<form method="post" action="/programs/${program.id}/exemptions/remove" class="inline"
              data-confirm="سيعود المؤشر إلى المقياس وتُولَّد مهامه من جديد. متابعة؟">
            <input type="hidden" name="indicator_id" value="${e.indicator_id}">
            <button class="btn small sec">إعادة التطبيق</button></form>` : '',
        ];
      }), { empty: 'كل المؤشرات منطبقة على هذا البرنامج.' })}
    ${canExempt ? `
    <form method="post" action="/programs/${program.id}/exemptions" style="margin-top:.8rem">
      <div class="form-grid">
        ${field('المؤشر', select('indicator_id',
          exemptable.map((i) => ({ value: i.id, label: `${i.section_name} ← ${i.name} (${fmtNum(i.weight)})` })),
          '', { required: true, placeholder: 'اختر المؤشر غير المنطبق' }))}
        ${field('سبب عدم الانطباق', input('reason', { required: true, placeholder: 'مثال: البرنامج عن بُعد ولا يتضمن قاعات' }))}
      </div>
      <button class="btn">وسم المؤشر «غير منطبق»</button>
    </form>` : ''}`)}`;
}

export default function register(router) {
  router.get('/programs', (ctx) => ctx.render('البرامج', programsList(ctx), { active: '/programs' }));

  router.post('/programs', (ctx) => {
    if (!(ctx.user.global_role === 'admin' || ctx.user.global_role === 'quality_manager')) return ctx.deny();
    const b = ctx.body;
    const name = String(b.name || '').trim();
    if (!name) return ctx.redirect('/programs', 'اسم البرنامج مطلوب.', 'err');
    const code = String(b.code || '').trim() || null;
    if (code && get('SELECT 1 FROM programs WHERE code = ?', code)) {
      return ctx.redirect('/programs', 'رمز البرنامج مستخدم مسبقًا.', 'err');
    }
    const sessionsCount = Math.min(200, Math.max(0, int(b.planned_sessions, 0)));
    const startDate = String(b.start_date || today()).slice(0, 10);
    const res = run(
      `INSERT INTO programs (name, code, kind, term, start_date, end_date, venue_id, planned_sessions, planned_students, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      name, code, String(b.kind || '').trim() || null, String(b.term || '').trim() || null,
      startDate, String(b.end_date || '').slice(0, 10) || null,
      int(b.venue_id, 0) || null, sessionsCount, int(b.planned_students, 0), ctx.user.id,
    );
    const id = Number(res.lastInsertRowid);

    if (b.generate_sessions && sessionsCount > 0) {
      const endDate = String(b.end_date || '').slice(0, 10) || addDays(startDate, sessionsCount * 3);
      const spanDays = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86_400_000));
      for (let i = 1; i <= sessionsCount; i += 1) {
        run('INSERT INTO sessions (program_id, seq, title, session_date, venue_id) VALUES (?, ?, ?, ?, ?)',
          id, i, `اللقاء ${i}`, addDays(startDate, Math.round((spanDays * (i - 1)) / Math.max(1, sessionsCount - 1 || 1))),
          int(b.venue_id, 0) || null);
      }
    }
    // مدير الجودة المنشئ يُسند تلقائيًا
    run('INSERT OR IGNORE INTO program_assignments (program_id, user_id, role) VALUES (?, ?, ?)',
      id, ctx.user.id, 'quality_manager');
    syncProgramTasks(id);
    audit({ user: ctx.user, action: 'program.create', entityType: 'program', entityId: id, programId: id, after: { name, code }, ip: ctx.ip });
    ctx.redirect(`/programs/${id}/team`, 'أُنشئ البرنامج وتم توليد جدول القياسات. أسند الأدوار الآن.');
  });

  router.get('/programs/:id', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program } = loaded;
    ctx.render(program.name, programHead(program, '',
      `<a class="btn sec small" href="/reports/program/${program.id}">تقرير البرنامج</a>`) + overview(ctx, program),
    { active: '/programs' });
  });

  router.get('/programs/:id/metric', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    ctx.render('المقياس', programHead(loaded.program, 'metric') + metricView(ctx, loaded.program, loaded.perms),
      { active: '/programs', wide: true });
  });

  // سجل قياسات مؤشر واحد
  router.get('/programs/:id/indicator/:indId', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program } = loaded;
    const ind = get('SELECT * FROM indicators WHERE id = ?', ctx.params.indId);
    if (!ind) return ctx.notFound();
    const rows = all(
      `SELECT v.*, u.full_name AS by_name, s.seq AS session_seq
         FROM verifications v LEFT JOIN users u ON u.id = v.completed_by
         LEFT JOIN sessions s ON s.id = v.session_id
        WHERE v.program_id = ? AND v.indicator_id = ? AND v.status = 'submitted'
        ORDER BY v.completed_at DESC`, program.id, ind.id,
    );
    const pending = all(
      "SELECT * FROM tasks WHERE program_id = ? AND indicator_id = ? AND status = 'pending' ORDER BY due_date",
      program.id, ind.id,
    );
    ctx.render(ind.name, programHead(program, 'metric') + `
      <h2>${esc(ind.name)} <small class="muted">${esc(ind.code)}</small></h2>
      ${ind.description ? `<p class="hint">${esc(ind.description)}</p>` : ''}
      ${section('القياسات المنفّذة', table(['التاريخ', 'اللقاء', 'المنفّذ', 'النتيجة', ''],
        rows.map((v) => [
          fmtDate(v.completed_at), v.session_seq ?? '—', esc(v.by_name || '—'),
          progress(v.score_pct), `<a class="btn sec small" href="/verifications/${v.id}">التفاصيل</a>`,
        ]), { empty: 'لم تُنفّذ قياسات بعد.' }))}
      ${section('القياسات المجدولة المعلّقة', table(['المهمة', 'الاستحقاق', 'المسؤول'],
        pending.map((t) => [
          `<a href="/tasks/${t.id}">${esc(t.title)}</a>`, fmtDate(t.due_date), roleName(t.assigned_role),
        ]), { empty: 'لا توجد مهام معلّقة لهذا المؤشر.' }))}`,
    { active: '/programs' });
  });

  // ------------------------------ «غير منطبق» ---------------------------
  router.post('/programs/:id/exemptions', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'indicator.exempt' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;

    const indicatorId = int(ctx.body.indicator_id, 0);
    const reason = String(ctx.body.reason || '').trim();
    const indicator = get('SELECT * FROM indicators WHERE id = ? AND is_active = 1', indicatorId);
    if (!indicator) return ctx.redirect(`/programs/${program.id}/metric`, 'المؤشر غير موجود.', 'err');
    if (!reason) return ctx.redirect(`/programs/${program.id}/metric`, 'سبب عدم الانطباق إلزامي.', 'err');

    // لا يُستثنى مؤشر له قياسات معتمدة — الاستثناء كان سيخفيها بلا أثر ظاهر.
    const verifications = Number(get(
      "SELECT COUNT(*) c FROM verifications WHERE program_id = ? AND indicator_id = ? AND status = 'submitted'",
      program.id, indicatorId,
    )?.c || 0);
    const responses = Number(get(
      `SELECT COUNT(*) c FROM survey_responses r
         JOIN surveys s ON s.id = r.survey_id
         JOIN survey_questions q ON q.survey_id = s.id AND q.indicator_id = ?
        WHERE s.program_id = ?`,
      indicatorId, program.id,
    )?.c || 0);
    if (verifications || responses) {
      return ctx.redirect(`/programs/${program.id}/metric`,
        `لا يمكن وسم «${indicator.name}» غير منطبق: توجد له قياسات معتمدة (${verifications} تحققًا و${responses} استجابة).`,
        'err');
    }

    run('INSERT OR IGNORE INTO indicator_exemptions (program_id, indicator_id, reason, created_by) VALUES (?, ?, ?, ?)',
      program.id, indicatorId, reason, ctx.user.id);
    const res = syncProgramTasks(program.id);
    audit({
      user: ctx.user, action: 'indicator.exempt', entityType: 'indicator', entityId: indicatorId,
      programId: program.id, after: { indicator: indicator.code, weight: indicator.weight, reason },
      ip: ctx.ip,
    });
    ctx.redirect(`/programs/${program.id}/metric`,
      `وُسم «${indicator.name}» غير منطبق — خرجت ${fmtNum(indicator.weight)} درجة من المقياس، وأُلغيت ${res.cancelled} مهمة معلّقة.`);
  });

  router.post('/programs/:id/exemptions/remove', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'indicator.exempt' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const indicatorId = int(ctx.body.indicator_id, 0);
    const row = get('SELECT * FROM indicator_exemptions WHERE program_id = ? AND indicator_id = ?', program.id, indicatorId);
    if (!row) return ctx.notFound('لا يوجد استثناء لهذا المؤشر.');
    run('DELETE FROM indicator_exemptions WHERE id = ?', row.id);
    const res = syncProgramTasks(program.id);
    refreshNotifications({ programId: program.id });
    audit({
      user: ctx.user, action: 'indicator.reapply', entityType: 'indicator', entityId: indicatorId,
      programId: program.id, before: { reason: row.reason }, ip: ctx.ip,
    });
    ctx.redirect(`/programs/${program.id}/metric`,
      `أُعيد المؤشر إلى المقياس — وُلّدت ${res.created} مهمة.`);
  });

  // ------------------------------ اللقاءات ------------------------------
  router.get('/programs/:id/sessions', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const rows = all(
      `SELECT s.*, v.name AS venue_name, t.full_name AS teacher_name,
              (SELECT COUNT(*) FROM tasks k WHERE k.session_id = s.id) AS task_count
         FROM sessions s LEFT JOIN venues v ON v.id = s.venue_id
         LEFT JOIN teachers t ON t.id = s.teacher_id
        WHERE s.program_id = ? ORDER BY s.seq`, program.id,
    );
    const venues = all('SELECT * FROM venues ORDER BY name');
    const teachers = all('SELECT * FROM teachers ORDER BY full_name');
    const editable = can(perms, 'session.manage') && program.status !== 'closed';
    ctx.render('اللقاءات', programHead(program, 'sessions') + `
      ${section(`اللقاءات (${rows.length} من ${program.planned_sessions} مخططة)`,
        table(['#', 'العنوان', 'التاريخ', 'القاعة', 'المعلم', 'الحالة', 'قياسات مجدولة'],
          rows.map((s) => [
            `<span class="num">${s.seq}</span>`, esc(s.title || '—'), fmtDate(s.session_date),
            esc(s.venue_name || '—'), esc(s.teacher_name || '—'), statusBadge(s.status),
            `<span class="num">${s.task_count}</span>`,
          ]), { empty: 'لم تُعرّف لقاءات بعد.' }),
        { actions: editable ? `<form method="post" action="/programs/${program.id}/sessions/sync" class="inline">
            <button class="btn sec small">إعادة توليد جدول القياسات</button></form>` : '' })}
      ${editable ? section('إضافة لقاء', `
        <form method="post" action="/programs/${program.id}/sessions">
          <div class="form-grid">
            ${field('رقم اللقاء', input('seq', { type: 'number', value: rows.length + 1, required: true, attrs: 'min="1"' }))}
            ${field('العنوان', input('title', { value: `اللقاء ${rows.length + 1}` }))}
            ${field('التاريخ', input('session_date', { type: 'date', required: true }))}
            ${field('القاعة', select('venue_id', venues.map((v) => ({ value: v.id, label: v.name })), program.venue_id, { placeholder: 'بدون' }))}
            ${field('المعلم', select('teacher_id', teachers.map((t) => ({ value: t.id, label: t.full_name })), '', { placeholder: 'بدون' }))}
          </div>
          <button class="btn">إضافة اللقاء</button>
        </form>`) : ''}`, { active: '/programs' });
  });

  router.post('/programs/:id/sessions', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'session.manage' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const seq = int(ctx.body.seq, 0);
    if (seq < 1) return ctx.redirect(`/programs/${program.id}/sessions`, 'رقم اللقاء غير صحيح.', 'err');
    if (get('SELECT 1 FROM sessions WHERE program_id = ? AND seq = ?', program.id, seq)) {
      return ctx.redirect(`/programs/${program.id}/sessions`, 'رقم اللقاء مستخدم مسبقًا.', 'err');
    }
    run('INSERT INTO sessions (program_id, seq, title, session_date, venue_id, teacher_id) VALUES (?, ?, ?, ?, ?, ?)',
      program.id, seq, String(ctx.body.title || `اللقاء ${seq}`).trim(),
      String(ctx.body.session_date || '').slice(0, 10) || null,
      int(ctx.body.venue_id, 0) || null, int(ctx.body.teacher_id, 0) || null);
    syncProgramTasks(program.id);
    audit({ user: ctx.user, action: 'session.create', entityType: 'session', entityId: seq, programId: program.id, after: ctx.body, ip: ctx.ip });
    ctx.redirect(`/programs/${program.id}/sessions`, 'أُضيف اللقاء وأُعيد توليد جدول القياسات.');
  });

  router.post('/programs/:id/sessions/sync', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'session.manage' }); if (!loaded) return;
    if (!ensureOpen(ctx, loaded.program)) return;
    const res = syncProgramTasks(loaded.program.id);
    refreshNotifications({ programId: loaded.program.id });
    audit({ user: ctx.user, action: 'tasks.sync', entityType: 'program', entityId: loaded.program.id, programId: loaded.program.id, after: res, ip: ctx.ip });
    ctx.redirect(`/programs/${loaded.program.id}/sessions`, `تم التوليد: ${res.created} مهمة جديدة، ${res.cancelled} ملغاة.`);
  });

  // ------------------------------ الطلاب ------------------------------
  router.get('/programs/:id/students', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const rows = all('SELECT * FROM students WHERE program_id = ? ORDER BY full_name', program.id);
    const editable = can(perms, 'student.manage') && program.status !== 'closed';
    ctx.render('الطلاب', programHead(program, 'students') + `
      ${section(`الطلاب (${rows.length})`, table(['الاسم', 'الجوال', 'الحالة', 'تاريخ الانضمام', 'سبب الانسحاب'],
        rows.map((s) => [esc(s.full_name), esc(s.phone || '—'), statusBadge(s.status), fmtDate(s.joined_at), esc(s.withdraw_reason || '—')]),
        { empty: 'لم يُسجَّل طلاب بعد.' }))}
      ${editable ? section('إضافة طلاب', `
        <form method="post" action="/programs/${program.id}/students">
          ${field('أسماء الطلاب (اسم في كل سطر)', textarea('names', { rows: 6, required: true, placeholder: 'أحمد محمد\nعبدالله سالم' }))}
          <button class="btn">إضافة</button>
        </form>`) : ''}`, { active: '/programs' });
  });

  router.post('/programs/:id/students', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'student.manage' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const names = String(ctx.body.names || '').split('\n').map((n) => n.trim()).filter(Boolean);
    for (const n of names) {
      run('INSERT INTO students (program_id, full_name, joined_at) VALUES (?, ?, ?)', program.id, n, today());
    }
    audit({ user: ctx.user, action: 'student.bulk_add', entityType: 'program', entityId: program.id, programId: program.id, after: { count: names.length }, ip: ctx.ip });
    ctx.redirect(`/programs/${program.id}/students`, `أُضيف ${names.length} طالبًا.`);
  });

  // ------------------------------ الخطة والمحتوى ------------------------
  router.get('/programs/:id/plan', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const plan = get('SELECT * FROM plans WHERE program_id = ?', program.id) || {};
    const evid = all("SELECT * FROM evidences WHERE entity_type = 'plan' AND entity_id = ? ORDER BY id DESC", program.id);
    const editable = can(perms, 'plan.review') && program.status !== 'closed';
    ctx.render('الخطة والمحتوى', programHead(program, 'plan') + `
      ${section('الخطة المعتمدة', editable ? `
        <form method="post" action="/programs/${program.id}/plan">
          ${field('الأهداف', textarea('objectives', { value: plan.objectives || '', rows: 3 }))}
          ${field('المخرجات', textarea('outcomes', { value: plan.outcomes || '', rows: 3 }))}
          ${field('الجدول الزمني', textarea('timeline', { value: plan.timeline || '', rows: 2 }))}
          ${field('المحتوى المقرر (التسلسل)', textarea('content_outline', { value: plan.content_outline || '', rows: 4 }))}
          ${field('ملاحظة التغيير المعتمد', textarea('change_note', { value: plan.change_note || '', rows: 2 }))}
          <label class="inline"><input type="checkbox" name="is_approved" value="1" ${plan.is_approved ? 'checked' : ''} style="width:auto"> اعتماد الخطة</label>
          <p style="margin-top:.7rem"><button class="btn">حفظ الخطة</button></p>
        </form>` : `
        <p><strong>الأهداف:</strong> ${esc(plan.objectives || '—')}</p>
        <p><strong>المخرجات:</strong> ${esc(plan.outcomes || '—')}</p>
        <p><strong>الجدول الزمني:</strong> ${esc(plan.timeline || '—')}</p>
        <p><strong>المحتوى المقرر:</strong> ${esc(plan.content_outline || '—')}</p>
        <p>${plan.is_approved ? badge('معتمدة', 'good') : badge('غير معتمدة', 'warn')}</p>`)}
      ${section('شواهد الخطة', evidenceList(evid) + (editable ? evidenceForm('plan', program.id, `/programs/${program.id}/plan`) : ''))}`,
    { active: '/programs' });
  });

  router.post('/programs/:id/plan', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'plan.review' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const before = get('SELECT * FROM plans WHERE program_id = ?', program.id);
    const b = ctx.body;
    const approved = b.is_approved ? 1 : 0;
    if (before) {
      run(`UPDATE plans SET objectives = ?, outcomes = ?, timeline = ?, content_outline = ?, change_note = ?,
                  is_approved = ?, approved_by = ?, approved_at = ?, updated_at = datetime('now')
            WHERE program_id = ?`,
        b.objectives || null, b.outcomes || null, b.timeline || null, b.content_outline || null, b.change_note || null,
        approved, approved ? ctx.user.id : null, approved ? today() : null, program.id);
    } else {
      run(`INSERT INTO plans (program_id, objectives, outcomes, timeline, content_outline, change_note, is_approved, approved_by, approved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        program.id, b.objectives || null, b.outcomes || null, b.timeline || null, b.content_outline || null,
        b.change_note || null, approved, approved ? ctx.user.id : null, approved ? today() : null);
    }
    audit({ user: ctx.user, action: 'plan.update', entityType: 'plan', entityId: program.id, programId: program.id, before, after: b, ip: ctx.ip });
    ctx.redirect(`/programs/${program.id}/plan`, 'حُفظت الخطة.');
  });

  // ------------------------------ الفريق والأدوار -----------------------
  router.get('/programs/:id/team', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const rows = all(
      `SELECT a.*, u.full_name, u.username FROM program_assignments a
         JOIN users u ON u.id = a.user_id WHERE a.program_id = ? ORDER BY a.role`, program.id,
    );
    const users = all("SELECT * FROM users WHERE is_active = 1 ORDER BY full_name");
    const editable = can(perms, 'program.assign');
    ctx.render('الفريق والأدوار', programHead(program, 'team') + `
      ${section('الأدوار المسندة', table(['الدور', 'المسؤول', 'الحساب', ''],
        rows.map((a) => [
          roleName(a.role), esc(a.full_name), `<code>${esc(a.username)}</code>`,
          editable ? `<form method="post" action="/programs/${program.id}/team/remove" class="inline" data-confirm="إزالة هذا الإسناد؟">
            <input type="hidden" name="assignment_id" value="${a.id}">
            <button class="btn small danger">إزالة</button></form>` : '',
        ]), { empty: 'لم تُسند الأدوار بعد.' }))}
      ${editable ? section('إسناد دور', `
        <form method="post" action="/programs/${program.id}/team">
          <div class="form-grid">
            ${field('المستخدم', select('user_id', users.map((u) => ({ value: u.id, label: `${u.full_name} (${u.username})` })), '', { required: true, placeholder: 'اختر المستخدم' }))}
            ${field('الدور', select('role', ROLE_KEYS.map((k) => ({ value: k, label: ROLES[k].name })), '', { required: true, placeholder: 'اختر الدور' }))}
          </div>
          <button class="btn">إسناد</button>
        </form>
        <p class="hint">عند الإسناد تُحوَّل المهام المعلّقة الخاصة بالدور تلقائيًا إلى المستخدم الجديد.</p>`) : ''}
      ${section('مسؤوليات الأدوار وفق الوثيقة', `<div class="grid two">${ROLE_KEYS.map((k) => `
        <div><h3>${esc(ROLES[k].name)}</h3>
        <ul class="duties">${ROLES[k].duties.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`).join('')}</div>`)}`,
    { active: '/programs' });
  });

  router.post('/programs/:id/team', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'program.assign' }); if (!loaded) return;
    const { program } = loaded;
    const userId = int(ctx.body.user_id, 0);
    const role = String(ctx.body.role || '');
    if (!userId || !ROLE_KEYS.includes(role)) return ctx.redirect(`/programs/${program.id}/team`, 'بيانات الإسناد غير مكتملة.', 'err');
    run('INSERT OR IGNORE INTO program_assignments (program_id, user_id, role) VALUES (?, ?, ?)', program.id, userId, role);
    syncProgramTasks(program.id);
    // إعادة إسناد المهام المعلّقة لهذا الدور
    run("UPDATE tasks SET assigned_user_id = ? WHERE program_id = ? AND assigned_role = ? AND status = 'pending'",
      userId, program.id, role);
    audit({ user: ctx.user, action: 'program.assign', entityType: 'program', entityId: program.id, programId: program.id, after: { userId, role }, ip: ctx.ip });
    ctx.redirect(`/programs/${program.id}/team`, 'تم الإسناد وتحويل المهام المعلّقة.');
  });

  router.post('/programs/:id/team/remove', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'program.assign' }); if (!loaded) return;
    const a = get('SELECT * FROM program_assignments WHERE id = ? AND program_id = ?', ctx.body.assignment_id, loaded.program.id);
    if (!a) return ctx.notFound();
    run('DELETE FROM program_assignments WHERE id = ?', a.id);
    run("UPDATE tasks SET assigned_user_id = NULL WHERE program_id = ? AND assigned_role = ? AND assigned_user_id = ? AND status = 'pending'",
      a.program_id, a.role, a.user_id);
    audit({ user: ctx.user, action: 'program.unassign', entityType: 'program', entityId: a.program_id, programId: a.program_id, before: a, ip: ctx.ip });
    ctx.redirect(`/programs/${loaded.program.id}/team`, 'أُزيل الإسناد.');
  });

  // ------------------------------ سجل التدقيق --------------------------
  router.get('/programs/:id/audit', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const rows = auditForProgram(loaded.program.id, 300);
    ctx.render('سجل التدقيق', programHead(loaded.program, 'audit') + section('آخر 300 عملية',
      table(['التاريخ', 'المستخدم', 'العملية', 'الكيان', 'التفاصيل'],
        rows.map((a) => [
          `<small class="num">${esc(a.created_at)}</small>`, esc(a.user_name || '—'), `<code>${esc(a.action)}</code>`,
          `${esc(a.entity_type || '—')}#${a.entity_id ?? '—'}`,
          `<small class="muted">${esc(String(a.after_json || '').slice(0, 120))}</small>`,
        ]), { empty: 'لا توجد عمليات مسجلة.' })), { active: '/programs', wide: true });
  });

  // ------------------------------ إقفال البرنامج -----------------------
  router.get('/programs/:id/close', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const r = closureReadiness(program.id);
    const score = computeProgram(program.id);
    const blocker = (label, list, render) => section(`${label} (${list.length})`,
      list.length ? `<ul class="duties">${list.map(render).join('')}</ul>` : '<p class="empty">لا توجد ملاحظات.</p>');

    ctx.render('إقفال البرنامج', programHead(program, 'close') + `
      <div class="stats">
        ${statCard({ label: 'اكتمال القياس', value: `${fmtNum(r.coverage_pct)}%`, tone: r.coverage_pct >= 100 ? 'good' : 'warn' })}
        ${statCard({ label: 'الدرجة من 300', value: fmtNum(score?.earned) })}
        ${statCard({ label: 'قياسات ناقصة', value: r.gaps.length, tone: r.gaps.length ? 'bad' : 'good' })}
        ${statCard({ label: 'شكاوى غير مغلقة', value: r.openComplaints.length, tone: r.openComplaints.length ? 'bad' : 'good' })}
        ${statCard({ label: 'شكاوى بلا تحقق نهائي', value: r.unverifiedComplaints.length, tone: r.unverifiedComplaints.length ? 'warn' : 'good' })}
        ${statCard({ label: 'إجراءات مفتوحة', value: r.openActions.length, tone: r.openActions.length ? 'warn' : 'good' })}
      </div>
      ${blocker('القياسات الناقصة', r.gaps, (g) => `<li>${esc(g.indicator.name)} — ${g.completed} من ${g.required} (${esc(g.sample_label)})</li>`)}
      ${blocker('الشكاوى غير المغلقة', r.openComplaints, (c) => `<li>${esc(c.title)}</li>`)}
      ${blocker('شكاوى مغلقة بلا تحقق نهائي', r.unverifiedComplaints, (c) => `<li>${esc(c.title)}</li>`)}
      ${blocker('شكاوى مغلقة بلا شواهد', r.complaintsNoEvidence, (c) => `<li>${esc(c.title)}</li>`)}
      ${blocker('إجراءات تصحيحية مفتوحة', r.openActions, (a) => `<li>${esc(a.title)}</li>`)}
      ${section('الإقفال', program.status === 'closed'
        ? `<p>${badge('البرنامج مغلق', 'muted')} بتاريخ ${fmtDate(program.closed_at)} — الدرجة النهائية
           <strong class="num">${fmtNum(program.final_score)} / 300</strong>، اكتمال القياس ${fmtNum(program.final_coverage)}%.</p>`
        : can(perms, 'program.close')
          ? `<p>${r.ready ? badge('مستوفٍ لشروط الإقفال', 'good') : badge('توجد نواقص ظاهرة أعلاه', 'warn')}</p>
             <form method="post" action="/programs/${program.id}/close" data-confirm="سيتم إقفال البرنامج وتثبيت الدرجة النهائية. متابعة؟">
               ${field('ملاحظة الإقفال', textarea('note', { rows: 2 }))}
               ${!r.ready ? `<label class="inline"><input type="checkbox" name="force" value="1" required style="width:auto">
                 أقرّ بالاطلاع على النواقص أعلاه وأعتمد الإقفال استثناءً</label><br>` : ''}
               <button class="btn" style="margin-top:.6rem">إقفال البرنامج واعتماد الدرجة النهائية</button>
             </form>`
          : '<p class="empty">الإقفال من صلاحية مسؤول البرنامج أو مدير التخطيط والجودة.</p>')}`,
    { active: '/programs' });
  });

  router.post('/programs/:id/close', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'program.close' }); if (!loaded) return;
    const { program } = loaded;
    if (program.status === 'closed') return ctx.redirect(`/programs/${program.id}/close`, 'البرنامج مغلق مسبقًا.', 'err');
    const r = closureReadiness(program.id);
    // البند 12: تمنع المنصة الإقفال دون إظهار القياسات الناقصة بوضوح
    if (!r.ready && !ctx.body.force) {
      return ctx.redirect(`/programs/${program.id}/close`, 'لا يمكن الإقفال قبل معالجة النواقص أو الإقرار بها.', 'err');
    }
    const score = computeProgram(program.id);
    run(`UPDATE programs SET status = 'closed', closed_at = datetime('now'), final_score = ?, final_coverage = ? WHERE id = ?`,
      score.earned, score.coverage_pct, program.id);
    run("UPDATE tasks SET status = 'cancelled' WHERE program_id = ? AND status = 'pending'", program.id);
    audit({
      user: ctx.user, action: 'program.close', entityType: 'program', entityId: program.id, programId: program.id,
      before: { status: program.status },
      after: { final_score: score.earned, final_coverage: score.coverage_pct, forced: Boolean(ctx.body.force), note: ctx.body.note || null },
      ip: ctx.ip,
    });
    ctx.redirect(`/reports/program/${program.id}`, `أُقفل البرنامج — الدرجة النهائية ${fmtNum(score.earned)} من 300.`);
  });

  registerOperations(router);
}
