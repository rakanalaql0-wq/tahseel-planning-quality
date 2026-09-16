import { all, get } from '../db/index.js';
import { esc, fmtDate, fmtNum, toCsv } from '../lib/util.js';
import { table, section, statusBadge, badge, progress, statCard } from '../views/ui.js';
import { send } from '../lib/http.js';
import { roleName } from '../lib/roles.js';
import { programsForUser, canAccessProgram } from '../lib/auth.js';
import { computeProgram, missingMeasurements, notMetItems } from '../lib/scoring.js';

/** مقارنة البرامج — البند 11 (UC-06): فصل النتيجة عن اكتمال القياس. */
function comparison(ctx) {
  const programs = programsForUser(ctx.user);
  const rows = programs.map((p) => {
    const r = computeProgram(p.id);
    return { p, r };
  });
  const closed = rows.filter((x) => x.p.status === 'closed');
  const avgScore = closed.length ? closed.reduce((s, x) => s + x.r.earned, 0) / closed.length : null;

  return `
  <div class="pagehead"><div><h1>التقارير ولوحات المؤشرات</h1>
    <p class="meta">مقارنة البرامج والفترات — النتيجة منفصلة عن اكتمال القياس (BR-11)</p></div></div>
  <div class="stats">
    ${statCard({ label: 'البرامج', value: rows.length })}
    ${statCard({ label: 'برامج مغلقة', value: closed.length })}
    ${statCard({ label: 'متوسط الدرجة النهائية', value: avgScore === null ? '—' : `${fmtNum(avgScore)} / 300`, tone: 'info' })}
  </div>
  ${section('مقارنة البرامج', table(
    ['البرنامج', 'الفترة', 'الحالة', 'الدرجة من 300', 'نتيجة الجودة', 'اكتمال القياس', 'القسم 1', 'القسم 2', 'القسم 3', ''],
    rows.map(({ p, r }) => [
      `<a href="/programs/${p.id}">${esc(p.name)}</a>`,
      `<small class="muted">${esc(p.term || '')} ${fmtDate(p.start_date)}</small>`,
      statusBadge(p.status),
      `<span class="num">${fmtNum(r.earned)}</span>`,
      progress(r.quality_pct), progress(r.coverage_pct),
      ...r.sections.map((s) => `<span class="num">${fmtNum(s.earned)}/${fmtNum(s.weight)}</span>`),
      `<a class="btn sec small" href="/reports/program/${p.id}">التقرير</a>`,
    ]), { empty: 'لا توجد برامج.' }),
    { actions: '<a class="btn sec small" href="/reports/programs.csv">تصدير Excel</a>' })}
  ${section('اتجاه الجودة عبر الفترات', table(['الفترة', 'عدد البرامج', 'متوسط الدرجة', 'متوسط الاكتمال'],
    Object.entries(rows.reduce((acc, { p, r }) => {
      const key = p.term || 'غير محدد';
      acc[key] = acc[key] || { n: 0, score: 0, cov: 0 };
      acc[key].n += 1; acc[key].score += r.earned; acc[key].cov += r.coverage_pct;
      return acc;
    }, {})).map(([term, v]) => [
      esc(term), `<span class="num">${v.n}</span>`,
      `<span class="num">${fmtNum(v.score / v.n)} / 300</span>`,
      progress(v.cov / v.n),
    ]), { empty: 'لا توجد بيانات.' }))}`;
}

/** تقرير برنامج كامل قابل للطباعة كـ PDF. */
function programReport(program) {
  const r = computeProgram(program.id);
  const gaps = missingMeasurements(program.id);
  const notMet = notMetItems(program.id);
  const team = all(
    `SELECT a.role, u.full_name FROM program_assignments a JOIN users u ON u.id = a.user_id
      WHERE a.program_id = ? ORDER BY a.role`, program.id,
  );
  const complaints = all('SELECT * FROM complaints WHERE program_id = ? ORDER BY id', program.id);
  const actions = all('SELECT * FROM corrective_actions WHERE program_id = ? ORDER BY status, due_date', program.id);
  const surveys = all(
    `SELECT s.*, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS responses
       FROM surveys s WHERE s.program_id = ? ORDER BY s.id`, program.id,
  );
  const students = get(
    `SELECT COUNT(*) total, SUM(status = 'withdrawn') withdrawn, SUM(intent_continue = 1) intent_yes,
            SUM(intent_continue IS NOT NULL) intent_asked FROM students WHERE program_id = ?`, program.id,
  );

  const metricRows = [];
  for (const s of r.sections) {
    metricRows.push(`<tr class="section-row"><td><strong>${esc(s.section.name)}</strong></td>
      <td class="num"><strong>${fmtNum(s.earned)} / ${fmtNum(s.weight)}</strong></td>
      <td>${progress(s.score_pct)}</td><td>${progress(s.coverage_pct)}</td></tr>`);
    for (const a of s.axes) {
      for (const n of a.indicators) {
        metricRows.push(`<tr><td><span style="padding-inline-start:1rem">${esc(n.indicator.name)}</span>
          <br><small class="muted">${esc(a.axis.name)} · ${esc(n.sample_label)} · ${roleName(n.indicator.owner_role)}</small></td>
          <td class="num">${fmtNum(n.earned)} / ${fmtNum(n.weight)}</td>
          <td>${progress(n.score_pct)}</td>
          <td>${progress(n.coverage_pct)}<small class="muted num">${n.completed} من ${n.required}</small></td></tr>`);
      }
    }
  }

  return `
  <div class="pagehead"><div>
    <h1>تقرير البرنامج: ${esc(program.name)} ${statusBadge(program.status)}</h1>
    <p class="meta">${esc(program.code || '')} · ${esc(program.term || '')} ·
      ${fmtDate(program.start_date)} — ${fmtDate(program.end_date)} · ${esc(program.venue_name || '')}</p>
  </div><div>
    <a class="btn sec small" href="/reports/program/${program.id}/export.csv">تصدير Excel</a>
    <button class="btn sec small" onclick="window.print()">طباعة / PDF</button>
  </div></div>

  <div class="stats">
    ${statCard({ label: 'الدرجة من 300', value: fmtNum(r.earned), sub: `الوزن المقيس ${fmtNum(r.measured_weight)}` })}
    ${statCard({ label: 'نتيجة الجودة', value: r.quality_pct === null ? '—' : `${fmtNum(r.quality_pct)}%`, tone: 'info' })}
    ${statCard({ label: 'اكتمال القياس', value: `${fmtNum(r.coverage_pct)}%`, tone: r.coverage_pct >= 100 ? 'good' : 'warn' })}
    ${statCard({ label: 'الطلاب', value: Number(students?.total || 0), sub: `${Number(students?.withdrawn || 0)} انسحاب` })}
    ${statCard({ label: 'الاستمرار الفعلي', value: Number(students?.total) ? `${(((Number(students.total) - Number(students.withdrawn)) / Math.max(Number(students.total), Number(program.planned_students || 0))) * 100).toFixed(1)}%` : '—' })}
    ${statCard({ label: 'الشكاوى', value: complaints.length, sub: `${complaints.filter((c) => c.status !== 'closed').length} مفتوحة` })}
  </div>

  ${section('تفصيل المقياس', `<div class="table-wrap"><table class="compact">
    <thead><tr><th>القسم / المؤشر</th><th>الدرجة</th><th>نتيجة الجودة</th><th>اكتمال القياس</th></tr></thead>
    <tbody>${metricRows.join('')}</tbody>
    <tfoot><tr class="section-row"><td><strong>الإجمالي</strong></td>
      <td class="num"><strong>${fmtNum(r.earned)} / 300</strong></td>
      <td>${progress(r.quality_pct)}</td><td>${progress(r.coverage_pct)}</td></tr></tfoot></table></div>`)}

  ${section('فريق البرنامج', table(['الدور', 'المسؤول'], team.map((t) => [roleName(t.role), esc(t.full_name)])))}

  ${section('الاستبانات', table(['الاستبانة', 'نقطة القياس', 'الحالة', 'الاستجابات'],
    surveys.map((s) => [esc(s.title), esc({ mid: 'المنتصف', end: 'النهاية', activity: 'نشاط' }[s.point] || s.point),
      statusBadge(s.status === 'open' ? 'in_progress' : s.status === 'closed' ? 'done' : 'draft'), `<span class="num">${s.responses}</span>`]),
    { empty: 'لا توجد استبانات.' }))}

  ${section('القياسات الناقصة', table(['المؤشر', 'المنفّذ/المطلوب', 'خطة العينة', 'المسؤول'],
    gaps.map((g) => [esc(g.indicator.name), `<span class="num">${g.completed} / ${g.required}</span>`,
      `<small class="muted">${esc(g.sample_label)}</small>`, roleName(g.indicator.owner_role)]),
    { empty: 'اكتملت جميع القياسات المطلوبة.' }))}

  ${section('العناصر غير المتحققة والجزئية', table(['المؤشر', 'العنصر', 'الحالة', 'الملاحظة'],
    notMet.map((i) => [esc(i.indicator_name), esc(i.item_text),
      i.state === 50 ? badge('جزئي', 'warn') : badge('غير متحقق', 'bad'), esc(i.note || '—')]),
    { empty: 'لا توجد ملاحظات.' }))}

  ${section('الشكاوى والمقترحات', table(['الرمز', 'العنوان', 'الحالة', 'الاستحقاق', 'الإغلاق', 'التحقق النهائي'],
    complaints.map((c) => [esc(c.ref_code || `#${c.id}`), esc(c.title), statusBadge(c.status),
      fmtDate(c.due_date), fmtDate(c.closed_at), c.verified_at ? badge('تم', 'good') : badge('لم يتم', 'muted')]),
    { empty: 'لا توجد شكاوى.' }))}

  ${section('الإجراءات التصحيحية والتحسينية', table(['العنوان', 'النوع', 'الموعد', 'الحالة'],
    actions.map((a) => [esc(a.title), a.kind === 'improvement' ? 'تحسيني' : 'تصحيحي',
      fmtDate(a.due_date), statusBadge(a.status)]), { empty: 'لا توجد إجراءات.' }))}`;
}

function programCsv(program) {
  const r = computeProgram(program.id);
  const rows = [];
  rows.push(['البرنامج', program.name, '', '', '', '']);
  rows.push(['الفترة', program.term || '', 'من', program.start_date || '', 'إلى', program.end_date || '']);
  rows.push(['الدرجة من 300', fmtNum(r.earned), 'نتيجة الجودة %', fmtNum(r.quality_pct), 'اكتمال القياس %', fmtNum(r.coverage_pct)]);
  rows.push([]);
  rows.push(['القسم', 'المحور', 'المؤشر', 'الوزن', 'الدرجة المحققة', 'نتيجة الجودة %', 'اكتمال القياس %', 'المنفّذ', 'المطلوب', 'المسؤول', 'خطة العينة']);
  for (const s of r.sections) {
    for (const a of s.axes) {
      for (const n of a.indicators) {
        rows.push([
          s.section.name, a.axis.name, n.indicator.name, fmtNum(n.weight), fmtNum(n.earned),
          n.score_pct === null ? '' : fmtNum(n.score_pct), fmtNum(n.coverage_pct),
          n.completed, n.required, roleName(n.indicator.owner_role), n.sample_label,
        ]);
      }
    }
    rows.push([`إجمالي ${s.section.name}`, '', '', fmtNum(s.weight), fmtNum(s.earned), s.score_pct === null ? '' : fmtNum(s.score_pct), fmtNum(s.coverage_pct)]);
  }
  rows.push(['الإجمالي', '', '', fmtNum(r.total_weight), fmtNum(r.earned), fmtNum(r.quality_pct), fmtNum(r.coverage_pct)]);
  return toCsv([], rows);
}

export default function register(router) {
  router.get('/reports', (ctx) => ctx.render('التقارير', comparison(ctx), { active: '/reports', wide: true }));

  router.get('/reports/program/:pid', (ctx) => {
    const program = get(
      `SELECT p.*, v.name AS venue_name FROM programs p LEFT JOIN venues v ON v.id = p.venue_id WHERE p.id = ?`,
      ctx.params.pid,
    );
    if (!program) return ctx.notFound();
    if (!canAccessProgram(ctx.user, program.id)) return ctx.deny();
    ctx.render(`تقرير ${program.name}`, programReport(program), { active: '/reports', wide: true });
  });

  router.get('/reports/program/:pid/export.csv', (ctx) => {
    const program = get('SELECT * FROM programs WHERE id = ?', ctx.params.pid);
    if (!program) return ctx.notFound();
    if (!canAccessProgram(ctx.user, program.id)) return ctx.deny();
    send(ctx.res, 200, programCsv(program), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${program.code || program.name}.csv`)}`,
    });
  });

  router.get('/reports/programs.csv', (ctx) => {
    const programs = programsForUser(ctx.user);
    const rows = programs.map((p) => {
      const r = computeProgram(p.id);
      return [
        p.name, p.code || '', p.term || '', p.start_date || '', p.end_date || '', p.status,
        fmtNum(r.earned), fmtNum(r.total_weight), r.quality_pct === null ? '' : fmtNum(r.quality_pct), fmtNum(r.coverage_pct),
        ...r.sections.map((s) => fmtNum(s.earned)),
      ];
    });
    const csv = toCsv(
      ['البرنامج', 'الرمز', 'الفترة', 'من', 'إلى', 'الحالة', 'الدرجة', 'من', 'نتيجة الجودة %', 'اكتمال القياس %',
        'القسم 1', 'القسم 2', 'القسم 3'],
      rows,
    );
    send(ctx.res, 200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''%D8%A7%D9%84%D8%A8%D8%B1%D8%A7%D9%85%D8%AC.csv",
    });
  });
}
