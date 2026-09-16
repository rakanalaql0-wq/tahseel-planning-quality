import { all, get, run } from '../db/index.js';
import { esc, fmtDate, fmtNum, num, today, toCsv } from '../lib/util.js';
import {
  table, section, badge, statCard, progress, select, field, input, textarea,
} from '../views/ui.js';
import { send } from '../lib/http.js';
import { can } from '../lib/roles.js';
import { audit } from '../lib/audit.js';
import { programImpact, toolSummary, resultsByTool } from '../lib/impact.js';
import { IMPACT_KINDS, impactKindLabel } from '../db/framework.js';
import { loadProgram, ensureOpen, programHead } from './_helpers.js';

/**
 * تبويب قياس الأثر — مستقل عن مقياس الـ300.
 * مقياس الجودة يقيس جودة العملية؛ هذه الوحدة تقيس ما تعلّمه الطالب فعلًا.
 */

const SEPARATION_NOTE = 'قياس الأثر مستقل تمامًا عن مقياس الجودة (300 درجة): '
  + 'لا يدخل في الدرجة ولا في اكتمال القياس، ويُقرأ إلى جانبها لا بدلًا عنها.';

function kindBadge(kind) {
  const tone = { pre: 'info', post: 'good', practical: 'warn' }[kind] || '';
  return badge(impactKindLabel(kind), tone);
}

function overview(program, editable) {
  const im = programImpact(program.id);

  const gainTone = im.normalized_gain === null ? ''
    : im.normalized_gain >= 60 ? 'good' : im.normalized_gain >= 30 ? 'warn' : 'bad';

  return `
  <div class="flash info">${esc(SEPARATION_NOTE)}</div>

  <div class="stats">
    ${statCard({ label: 'متوسط القياس القبلي', value: im.pre_pct === null ? '—' : `${fmtNum(im.pre_pct)}%`, tone: 'info' })}
    ${statCard({ label: 'متوسط القياس البعدي', value: im.post_pct === null ? '—' : `${fmtNum(im.post_pct)}%`, tone: 'good' })}
    ${statCard({ label: 'الفرق (نقاط مئوية)', value: im.delta === null ? '—' : `${im.delta > 0 ? '+' : ''}${fmtNum(im.delta)}` })}
    ${statCard({
      label: 'مكسب التعلم المعياري',
      value: im.normalized_gain === null ? '—' : `${fmtNum(im.normalized_gain)}%`,
      tone: gainTone,
      sub: '(بعدي − قبلي) ÷ (100 − قبلي)',
    })}
    ${statCard({ label: 'نسبة الإتقان', value: im.mastery_rate === null ? '—' : `${fmtNum(im.mastery_rate)}%`, sub: 'من بلغوا حد الإتقان في القياس البعدي/العملي' })}
    ${statCard({ label: 'التقييم العملي', value: im.practical_pct === null ? '—' : `${fmtNum(im.practical_pct)}%` })}
    ${statCard({ label: 'الطلاب المقيسون قبليًا وبعديًا', value: im.paired_count })}
    ${statCard({
      label: 'نسبة من تحسّن مستواه',
      value: im.improved_rate === null ? '—' : `${fmtNum(im.improved_rate)}%`,
      tone: (im.improved_rate ?? 0) >= 70 ? 'good' : 'warn',
      sub: im.paired_count ? `${im.improved_count} من ${im.paired_count}` : '',
    })}
  </div>

  ${section('أدوات القياس ونتائجها', table(
    ['الأداة', 'النوع', 'التاريخ', 'الدرجة العظمى', 'حد الإتقان', 'مَن قيس', 'تغطية القياس', 'المتوسط', 'نسبة الإتقان', ''],
    im.tools.map((s) => [
      esc(s.tool.name), kindBadge(s.tool.kind), fmtDate(s.tool.applied_at),
      `<span class="num">${fmtNum(s.tool.max_score)}</span>`,
      `<span class="num">${fmtNum(s.tool.mastery_pct)}%</span>`,
      `<span class="num">${s.measured} / ${s.eligible}</span>`,
      progress(s.coverage_pct),
      s.avg_pct === null ? '<span class="muted">—</span>' : progress(s.avg_pct),
      s.mastery_rate === null ? '<span class="muted">—</span>' : progress(s.mastery_rate),
      `<a class="btn sec small" href="/impact/tool/${s.tool.id}">${editable ? 'إدخال الدرجات' : 'التفاصيل'}</a>`,
    ]),
    { empty: 'لم تُعرَّف أدوات قياس أثر بعد.' },
  ), { actions: im.has_data ? `<a class="btn sec small" href="/programs/${program.id}/impact.csv">تصدير Excel</a>` : '' })}

  ${editable ? section('إضافة أداة قياس', `
    <form method="post" action="/programs/${program.id}/impact">
      <div class="form-grid">
        ${field('اسم الأداة', input('name', { required: true, placeholder: 'الاختبار القبلي لأحكام التلاوة' }))}
        ${field('النوع', select('kind', IMPACT_KINDS, 'pre', { required: true }))}
        ${field('الدرجة العظمى', input('max_score', { type: 'number', value: 100, attrs: 'min="1" max="1000" step="0.5"' }))}
        ${field('حد الإتقان %', input('mastery_pct', { type: 'number', value: 80, attrs: 'min="1" max="100" step="1"' }))}
        ${field('تاريخ التطبيق', input('applied_at', { type: 'date', value: today() }))}
      </div>
      ${field('ملاحظات', textarea('notes', { rows: 2, placeholder: 'ما الذي تقيسه هذه الأداة ومن أي مخرج؟' }))}
      <button class="btn">إضافة الأداة</button>
    </form>
    <p class="hint">اجعل للاختبار القبلي والبعدي نفس المحتوى والدرجة العظمى حتى تكون المقارنة صحيحة.</p>`) : ''}`;
}

export default function register(router) {
  router.get('/programs/:id/impact', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const editable = can(perms, 'impact.manage') && program.status !== 'closed';
    return ctx.render('قياس الأثر', programHead(program, 'impact', perms) + overview(program, editable),
      { active: '/programs', wide: true });
  });

  router.post('/programs/:id/impact', (ctx) => {
    const loaded = loadProgram(ctx, { perm: 'impact.manage' }); if (!loaded) return;
    const { program } = loaded;
    if (!ensureOpen(ctx, program)) return;
    const name = String(ctx.body.name || '').trim();
    if (!name) return ctx.redirect(`/programs/${program.id}/impact`, 'اسم الأداة مطلوب.', 'err');
    const kind = IMPACT_KINDS.some((k) => k.value === ctx.body.kind) ? ctx.body.kind : 'pre';
    const maxScore = Math.max(1, Math.min(1000, num(ctx.body.max_score, 100)));
    const mastery = Math.max(1, Math.min(100, num(ctx.body.mastery_pct, 80)));
    const res = run(
      `INSERT INTO impact_tools (program_id, name, kind, max_score, mastery_pct, applied_at, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      program.id, name, kind, maxScore, mastery,
      String(ctx.body.applied_at || today()).slice(0, 10), String(ctx.body.notes || '').trim() || null, ctx.user.id,
    );
    audit({
      user: ctx.user, action: 'impact.tool.create', entityType: 'impact_tool',
      entityId: Number(res.lastInsertRowid), programId: program.id,
      after: { name, kind, maxScore, mastery }, ip: ctx.ip,
    });
    return ctx.redirect(`/impact/tool/${Number(res.lastInsertRowid)}`, 'أُضيفت الأداة — أدخل درجات الطلاب الآن.');
  });

  router.get('/impact/tool/:tid', (ctx) => {
    const tool = get('SELECT * FROM impact_tools WHERE id = ?', ctx.params.tid);
    if (!tool) return ctx.notFound();
    ctx.params.id = tool.program_id;
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program, perms } = loaded;
    const editable = can(perms, 'impact.manage') && program.status !== 'closed';
    const summary = toolSummary(tool.id);
    const rows = resultsByTool(tool.id);

    return ctx.render(tool.name, `
      <div class="crumbs"><a href="/programs/${program.id}/impact">${esc(program.name)} — قياس الأثر</a></div>
      <div class="pagehead"><div>
        <h1>${esc(tool.name)} ${kindBadge(tool.kind)}</h1>
        <p class="meta">الدرجة العظمى ${fmtNum(tool.max_score)} · حد الإتقان ${fmtNum(tool.mastery_pct)}%
          · التطبيق ${fmtDate(tool.applied_at)}</p>
        ${tool.notes ? `<p class="hint">${esc(tool.notes)}</p>` : ''}
      </div></div>

      <div class="stats">
        ${statCard({ label: 'المقيسون', value: `${summary.measured} / ${summary.eligible}` })}
        ${statCard({ label: 'المتوسط', value: summary.avg_pct === null ? '—' : `${fmtNum(summary.avg_pct)}%`, tone: 'info' })}
        ${statCard({ label: 'أعلى درجة', value: summary.max_pct === null ? '—' : `${fmtNum(summary.max_pct)}%` })}
        ${statCard({ label: 'أدنى درجة', value: summary.min_pct === null ? '—' : `${fmtNum(summary.min_pct)}%` })}
        ${statCard({
          label: 'بلغوا حد الإتقان',
          value: summary.mastery_rate === null ? '—' : `${fmtNum(summary.mastery_rate)}%`,
          sub: `${summary.mastered} من ${summary.measured}`,
          tone: (summary.mastery_rate ?? 0) >= 80 ? 'good' : 'warn',
        })}
      </div>

      ${section('درجات الطلاب', `
        <form method="post" action="/impact/tool/${tool.id}/results">
          ${table(['الطالب', 'الحالة', `الدرجة (من ${fmtNum(tool.max_score)})`, 'النسبة', 'ملاحظة'],
            rows.map((r) => {
              const pct = r.score === null || r.score === undefined
                ? null : (Number(r.score) / Number(tool.max_score)) * 100;
              return [
                esc(r.full_name),
                r.status === 'withdrawn' ? badge('منسحب', 'bad') : badge('نشط', 'good'),
                editable
                  ? input(`score_${r.student_id}`, {
                    type: 'number', value: r.score ?? '',
                    attrs: `min="0" max="${tool.max_score}" step="0.5" style="width:100px"`,
                  })
                  : `<span class="num">${r.score ?? '—'}</span>`,
                pct === null ? '<span class="muted">—</span>'
                  : progress(pct, { tone: pct >= Number(tool.mastery_pct) ? 'good' : 'bad' }),
                editable ? input(`note_${r.student_id}`, { value: r.note || '', placeholder: 'اختياري' }) : esc(r.note || '—'),
              ];
            }), { empty: 'لا يوجد طلاب مسجلون في البرنامج.' })}
          ${editable && rows.length ? '<button class="btn" style="margin-top:.6rem">حفظ الدرجات</button>' : ''}
        </form>
        <p class="hint">اترك الحقل فارغًا لمن لم يُقس. الدرجات الفارغة لا تدخل في المتوسط، وتظهر كنقص في تغطية القياس.</p>`)}

      ${editable ? section('حذف الأداة', `
        <form method="post" action="/impact/tool/${tool.id}/delete" data-confirm="سيُحذف هذا القياس ودرجاته نهائيًا. متابعة؟">
          <button class="btn danger small">حذف الأداة ودرجاتها</button>
        </form>`) : ''}`, { active: '/programs', wide: true });
  });

  router.post('/impact/tool/:tid/results', (ctx) => {
    const tool = get('SELECT * FROM impact_tools WHERE id = ?', ctx.params.tid);
    if (!tool) return ctx.notFound();
    ctx.params.id = tool.program_id;
    const loaded = loadProgram(ctx, { perm: 'impact.manage' }); if (!loaded) return;
    if (!ensureOpen(ctx, loaded.program)) return;

    const students = all('SELECT id FROM students WHERE program_id = ?', tool.program_id);
    let saved = 0;
    let cleared = 0;
    for (const s of students) {
      const raw = String(ctx.body[`score_${s.id}`] ?? '').trim();
      const note = String(ctx.body[`note_${s.id}`] || '').trim() || null;
      if (raw === '') {
        const del = run('DELETE FROM impact_results WHERE tool_id = ? AND student_id = ?', tool.id, s.id);
        if (del.changes) cleared += 1;
        continue;
      }
      const score = num(raw, NaN);
      if (!Number.isFinite(score) || score < 0 || score > Number(tool.max_score)) continue;
      run(`INSERT INTO impact_results (tool_id, student_id, score, note, recorded_by)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (tool_id, student_id)
           DO UPDATE SET score = excluded.score, note = excluded.note,
                         recorded_by = excluded.recorded_by, recorded_at = datetime('now')`,
        tool.id, s.id, score, note, ctx.user.id);
      saved += 1;
    }
    audit({
      user: ctx.user, action: 'impact.results.save', entityType: 'impact_tool', entityId: tool.id,
      programId: tool.program_id, after: { saved, cleared }, ip: ctx.ip,
    });
    return ctx.redirect(`/impact/tool/${tool.id}`, `حُفظت ${saved} درجة.`);
  });

  router.post('/impact/tool/:tid/delete', (ctx) => {
    const tool = get('SELECT * FROM impact_tools WHERE id = ?', ctx.params.tid);
    if (!tool) return ctx.notFound();
    ctx.params.id = tool.program_id;
    const loaded = loadProgram(ctx, { perm: 'impact.manage' }); if (!loaded) return;
    if (!ensureOpen(ctx, loaded.program)) return;
    run('DELETE FROM impact_tools WHERE id = ?', tool.id);
    audit({
      user: ctx.user, action: 'impact.tool.delete', entityType: 'impact_tool', entityId: tool.id,
      programId: tool.program_id, before: tool, ip: ctx.ip,
    });
    return ctx.redirect(`/programs/${tool.program_id}/impact`, 'حُذفت الأداة ودرجاتها.');
  });

  router.get('/programs/:id/impact.csv', (ctx) => {
    const loaded = loadProgram(ctx); if (!loaded) return;
    const { program } = loaded;
    const im = programImpact(program.id);
    const rows = [
      ['تقرير قياس الأثر — مستقل عن مقياس الجودة (300 درجة)'],
      ['البرنامج', program.name],
      [],
      ['متوسط القبلي %', im.pre_pct === null ? '' : fmtNum(im.pre_pct)],
      ['متوسط البعدي %', im.post_pct === null ? '' : fmtNum(im.post_pct)],
      ['الفرق (نقاط مئوية)', im.delta === null ? '' : fmtNum(im.delta)],
      ['مكسب التعلم المعياري %', im.normalized_gain === null ? '' : fmtNum(im.normalized_gain)],
      ['نسبة الإتقان %', im.mastery_rate === null ? '' : fmtNum(im.mastery_rate)],
      ['نسبة من تحسّن مستواه %', im.improved_rate === null ? '' : fmtNum(im.improved_rate)],
      [],
      ['الأداة', 'النوع', 'التاريخ', 'الدرجة العظمى', 'حد الإتقان %', 'المقيسون', 'المستحقون', 'المتوسط %', 'نسبة الإتقان %'],
    ];
    for (const s of im.tools) {
      rows.push([
        s.tool.name, impactKindLabel(s.tool.kind), s.tool.applied_at || '',
        fmtNum(s.tool.max_score), fmtNum(s.tool.mastery_pct), s.measured, s.eligible,
        s.avg_pct === null ? '' : fmtNum(s.avg_pct),
        s.mastery_rate === null ? '' : fmtNum(s.mastery_rate),
      ]);
    }
    rows.push([]);
    rows.push(['الطالب', 'الأداة', 'النوع', 'الدرجة', 'النسبة %', 'ملاحظة']);
    const details = all(
      `SELECT st.full_name, t.name AS tool_name, t.kind, t.max_score, r.score, r.note
         FROM impact_results r
         JOIN impact_tools t ON t.id = r.tool_id
         JOIN students st ON st.id = r.student_id
        WHERE t.program_id = ? ORDER BY st.full_name, t.kind`, program.id,
    );
    for (const d of details) {
      rows.push([
        d.full_name, d.tool_name, impactKindLabel(d.kind), fmtNum(d.score),
        fmtNum((Number(d.score) / Number(d.max_score)) * 100), d.note || '',
      ]);
    }
    return send(ctx.res, 200, toCsv([], rows), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`قياس-الأثر-${program.code || program.name}.csv`)}`,
    });
  });
}


