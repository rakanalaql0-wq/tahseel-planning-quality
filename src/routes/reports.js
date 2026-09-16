import { all, get } from '../db/index.js';
import { esc, fmtDate, fmtNum, toCsv } from '../lib/util.js';
import { table, section, statusBadge, badge, progress, statCard, insightCard, insightList, compareBar } from '../views/ui.js';
import { send } from '../lib/http.js';
import { roleName } from '../lib/roles.js';
import { programsForUser, canAccessProgram } from '../lib/auth.js';
import { computeProgram, missingMeasurements, notMetItems } from '../lib/scoring.js';
import { termTrend, weakestIndicators, programBenchmark } from '../lib/benchmark.js';
import { portfolioHealth, programDiagnostics } from '../lib/insights.js';
import { programImpact } from '../lib/impact.js';
import { impactKindLabel } from '../db/framework.js';

/**
 * مركز التقارير الموحّد.
 * كل ما يخص القراءة والمقارنة والتصدير في مكان واحد بدل توزّعها على شاشات.
 */
function reportsCenter(ctx) {
  const programs = programsForUser(ctx.user);
  const rows = programs.map((p) => ({ p, r: computeProgram(p.id) }));
  const closed = rows.filter((x) => x.p.status === 'closed');
  const avgScore = closed.length
    ? closed.reduce((s, x) => s + (x.r.normalized_score ?? x.r.earned), 0) / closed.length : null;

  const trend = termTrend();
  const weakest = weakestIndicators(5);
  const portfolio = portfolioHealth(programs);
  const atRisk = portfolio.filter((x) => x.health === 'critical');

  return `
  <div class="pagehead"><div><h1>مركز التقارير</h1>
    <p class="meta">المقارنة والمعايرة والاتجاه والتصدير — النتيجة منفصلة عن اكتمال القياس (BR-11)</p></div></div>

  <div class="stats">
    ${statCard({ label: 'البرامج', value: rows.length, ico: 'programs' })}
    ${statCard({ label: 'برامج مغلقة', value: closed.length, ico: 'check' })}
    ${statCard({
      label: 'متوسط الجودة',
      value: avgScore === null ? '—' : `${fmtNum(avgScore)} / 300`,
      ico: 'metric', tone: 'info', sub: 'بالدرجة المعيارية',
    })}
    ${statCard({
      label: 'برامج تحتاج تدخلًا',
      value: atRisk.length, ico: 'alert',
      tone: atRisk.length ? 'bad' : 'good',
    })}
  </div>

  ${atRisk.length ? section('برامج تحتاج تدخلًا عاجلًا',
    atRisk.slice(0, 4).map((x) => insightCard({
      severity: 'critical',
      title: x.program.name,
      detail: x.top ? `${x.top.title} — ${x.top.detail}` : `${x.critical} ملاحظة عاجلة`,
      href: `/programs/${x.program.id}`,
      action: 'فتح البرنامج',
    })).join('')) : ''}

  ${section('مقارنة البرامج', table(
    ['البرنامج', 'الفترة', 'الحالة', 'الدرجة المحققة', 'المعيارية من 300', 'نتيجة الجودة', 'اكتمال القياس', ''],
    rows.map(({ p, r }) => [
      `<a href="/programs/${p.id}">${esc(p.name)}</a>`,
      `<small class="muted">${esc(p.term || '')} ${fmtDate(p.start_date)}</small>`,
      statusBadge(p.status),
      `<span class="num">${fmtNum(r.earned)} / ${fmtNum(r.total_weight)}</span>`
        + (r.exempt_weight ? `<br>${badge(`مستثنى ${fmtNum(r.exempt_weight)}`, 'muted')}` : ''),
      `<span class="num">${r.normalized_score === null ? '—' : fmtNum(r.normalized_score)}</span>`,
      progress(r.quality_pct), progress(r.coverage_pct),
      `<a class="btn sec small" href="/reports/program/${p.id}">التقرير</a>`,
    ]), { empty: 'لا توجد برامج.' }),
    { actions: '<a class="btn sec small" href="/reports/programs.csv">تصدير Excel</a>' })}

  <div class="grid two">
    ${section('اتجاه الأداء عبر الفترات', table(
      ['الفترة', 'البرامج', 'متوسط الدرجة', 'التغيّر', 'متوسط الاكتمال'],
      trend.map((t) => [
        esc(t.term), `<span class="num">${t.programs}</span>`,
        `<span class="num">${fmtNum(t.avgScore)} / 300</span>`,
        t.delta === null ? '<span class="muted">—</span>'
          : badge(`${t.delta > 0 ? '▲ +' : t.delta < 0 ? '▼ ' : ''}${fmtNum(t.delta)}`,
            t.delta > 0 ? 'good' : t.delta < 0 ? 'bad' : 'muted'),
        progress(t.avgCoverage),
      ]), { empty: 'تحتاج فترتين على الأقل لرسم الاتجاه.' }),
      { actions: badge('هل نتحسّن؟', 'muted') })}

    ${section('أضعف المؤشرات على مستوى الجمعية',
      weakest.length ? `<ul class="evidence">${weakest.map((w) => `<li>
        ${esc(w.indicator.name)}
        <small>متوسط ${fmtNum(w.avg)}% عبر ${w.programs} برنامجًا · وزنه ${fmtNum(w.indicator.weight)} درجة</small>
      </li>`).join('')}</ul>
      <p class="hint">ضعف متكرر في كل البرامج يعني خللًا مؤسسيًا لا خطأ برنامج واحد.</p>`
        : '<p class="empty">لا توجد بيانات كافية للمعايرة.</p>')}
  </div>`;
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
  const im = programImpact(program.id);

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
    ${statCard({ label: 'الدرجة المحققة', value: `${fmtNum(r.earned)} / ${fmtNum(r.total_weight)}`, sub: r.exempt_weight ? `مستثنى ${fmtNum(r.exempt_weight)} درجة (غير منطبق)` : `الوزن المقيس ${fmtNum(r.measured_weight)}` })}
    ${statCard({ label: 'الدرجة المعيارية من 300', value: r.normalized_score === null ? '—' : fmtNum(r.normalized_score), tone: 'info' })}
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
      <td class="num"><strong>${fmtNum(r.earned)} / ${fmtNum(r.total_weight)}</strong></td>
      <td>${progress(r.quality_pct)}</td><td>${progress(r.coverage_pct)}</td></tr></tfoot></table></div>`)}

  ${section('فريق البرنامج', table(['الدور', 'المسؤول'], team.map((t) => [roleName(t.role), esc(t.full_name)])))}

  ${section('الاستبانات', table(['الاستبانة', 'نقطة القياس', 'الحالة', 'الاستجابات'],
    surveys.map((s) => [esc(s.title), esc({ mid: 'المنتصف', end: 'النهاية', activity: 'نشاط' }[s.point] || s.point),
      statusBadge(s.status === 'open' ? 'in_progress' : s.status === 'closed' ? 'done' : 'draft'), `<span class="num">${s.responses}</span>`]),
    { empty: 'لا توجد استبانات.' }))}

  ${im.has_data ? section('قياس الأثر التعليمي — مستقل عن مقياس الـ300', `
    <p class="hint">هذا القسم يجيب عن سؤال مختلف عن مقياس الجودة: هل تعلّم الطالب فعلًا؟
      ولا تدخل نتائجه في الدرجة ولا في اكتمال القياس.</p>
    <div class="stats">
      ${statCard({ label: 'متوسط القبلي', value: im.pre_pct === null ? '—' : `${fmtNum(im.pre_pct)}%`, tone: 'info' })}
      ${statCard({ label: 'متوسط البعدي', value: im.post_pct === null ? '—' : `${fmtNum(im.post_pct)}%`, tone: 'good' })}
      ${statCard({ label: 'مكسب التعلم المعياري', value: im.normalized_gain === null ? '—' : `${fmtNum(im.normalized_gain)}%` })}
      ${statCard({ label: 'نسبة الإتقان', value: im.mastery_rate === null ? '—' : `${fmtNum(im.mastery_rate)}%` })}
      ${statCard({ label: 'من تحسّن مستواه', value: im.improved_rate === null ? '—' : `${fmtNum(im.improved_rate)}%`, sub: im.paired_count ? `${im.improved_count} من ${im.paired_count}` : '' })}
    </div>
    ${table(['الأداة', 'النوع', 'التاريخ', 'المقيسون', 'المتوسط', 'نسبة الإتقان'],
      im.tools.map((t) => [
        esc(t.tool.name), esc(impactKindLabel(t.tool.kind)), fmtDate(t.tool.applied_at),
        `<span class="num">${t.measured} / ${t.eligible}</span>`,
        t.avg_pct === null ? '<span class="muted">—</span>' : progress(t.avg_pct),
        t.mastery_rate === null ? '<span class="muted">—</span>' : progress(t.mastery_rate),
      ]))}`) : ''}

  ${r.exemptions.length ? section('المؤشرات غير المنطبقة', table(['المؤشر', 'الوزن المستثنى', 'السبب', 'الموسِم'],
    r.exemptions.map((e) => {
      const ind = get('SELECT name, code, weight FROM indicators WHERE id = ?', e.indicator_id);
      return [
        `${esc(ind?.name || '—')} <small class="muted">${esc(ind?.code || '')}</small>`,
        `<span class="num">${fmtNum(ind?.weight)}</span>`, esc(e.reason), esc(e.by_name || '—'),
      ];
    })), { actions: badge(`إجمالي الوزن المستثنى ${fmtNum(r.exempt_weight)} درجة`, 'muted') }) : ''}

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
  rows.push(['الدرجة المحققة', fmtNum(r.earned), 'من الوزن المنطبق', fmtNum(r.total_weight), 'وزن مستثنى', fmtNum(r.exempt_weight)]);
  rows.push(['الدرجة المعيارية من 300', r.normalized_score === null ? '' : fmtNum(r.normalized_score), 'نتيجة الجودة %', fmtNum(r.quality_pct), 'اكتمال القياس %', fmtNum(r.coverage_pct)]);
  rows.push([]);
  rows.push(['القسم', 'المحور', 'المؤشر', 'الوزن', 'الدرجة المحققة', 'نتيجة الجودة %', 'اكتمال القياس %', 'المنفّذ', 'المطلوب', 'المسؤول', 'خطة العينة']);
  for (const s of r.sections) {
    for (const a of s.axes) {
      for (const n of a.indicators) {
        rows.push([
          s.section.name, a.axis.name, n.indicator.name, fmtNum(n.weight),
          n.exempt ? 'غير منطبق' : fmtNum(n.earned),
          n.exempt ? '' : (n.score_pct === null ? '' : fmtNum(n.score_pct)),
          n.exempt ? '' : fmtNum(n.coverage_pct),
          n.completed, n.required, roleName(n.indicator.owner_role),
          n.exempt ? `غير منطبق: ${n.exemption.reason}` : n.sample_label,
        ]);
      }
    }
    rows.push([`إجمالي ${s.section.name}`, '', '', fmtNum(s.weight), fmtNum(s.earned), s.score_pct === null ? '' : fmtNum(s.score_pct), fmtNum(s.coverage_pct)]);
  }
  rows.push(['الإجمالي', '', '', fmtNum(r.total_weight), fmtNum(r.earned), fmtNum(r.quality_pct), fmtNum(r.coverage_pct)]);
  if (r.exempt_weight) {
    rows.push([]);
    rows.push(['المؤشرات غير المنطبقة', 'الوزن المستثنى', 'السبب']);
    for (const e of r.exemptions) {
      const ind = get('SELECT name, weight FROM indicators WHERE id = ?', e.indicator_id);
      rows.push([ind?.name || '', fmtNum(ind?.weight), e.reason]);
    }
  }
  return toCsv([], rows);
}

export default function register(router) {
  router.get('/reports', (ctx) => ctx.render('مركز التقارير', reportsCenter(ctx), { active: '/reports', wide: true }));

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
        fmtNum(r.earned), fmtNum(r.total_weight),
        r.normalized_score === null ? '' : fmtNum(r.normalized_score),
        r.quality_pct === null ? '' : fmtNum(r.quality_pct), fmtNum(r.coverage_pct),
        ...r.sections.map((s) => fmtNum(s.earned)),
      ];
    });
    const csv = toCsv(
      ['البرنامج', 'الرمز', 'الفترة', 'من', 'إلى', 'الحالة', 'الدرجة المحققة', 'الوزن المنطبق',
        'المعيارية من 300', 'نتيجة الجودة %', 'اكتمال القياس %', 'القسم 1', 'القسم 2', 'القسم 3'],
      rows,
    );
    send(ctx.res, 200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''%D8%A7%D9%84%D8%A8%D8%B1%D8%A7%D9%85%D8%AC.csv",
    });
  });
}
