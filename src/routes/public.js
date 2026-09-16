import { all, get } from '../db/index.js';
import { esc, fmtDate, fmtNum } from '../lib/util.js';
import { html } from '../lib/http.js';
import { publicPage } from '../views/layout.js';
import { icon } from '../views/icons.js';
import { computeProgram } from '../lib/scoring.js';
import { programImpact } from '../lib/impact.js';

/**
 * الموقع العام — يُعرض دون تسجيل دخول.
 *
 * مبدأ حاكم: لا تُعرض هنا أي بيانات شخصية (أسماء طلاب، شكاوى، حالات تعثر،
 * سجل تدقيق، أسماء منسوبين). المعروض وصف البرامج وأرقام مجمّعة فقط.
 */

const ORG = 'جمعية تحصيل المعرفة';

/** البرامج المعلنة للعموم. */
const publicPrograms = () => all(
  `SELECT p.*, v.name AS venue_name, v.location AS venue_location
     FROM programs p LEFT JOIN venues v ON v.id = p.venue_id
    WHERE p.is_public = 1 AND p.status <> 'draft'
    ORDER BY p.status = 'closed', p.start_date DESC, p.id DESC`,
);

/** أرقام مجمّعة على مستوى الجمعية. */
function orgStats() {
  const programs = publicPrograms();
  const ids = programs.map((p) => p.id);
  const students = ids.length
    ? Number(get(`SELECT COUNT(*) c FROM students WHERE program_id IN (${ids.map(() => '?').join(',')})`, ...ids)?.c || 0)
    : 0;
  const sessions = ids.length
    ? Number(get(`SELECT COUNT(*) c FROM sessions WHERE program_id IN (${ids.map(() => '?').join(',')})`, ...ids)?.c || 0)
    : 0;
  const activities = ids.length
    ? Number(get(`SELECT COUNT(*) c FROM activities WHERE program_id IN (${ids.map(() => '?').join(',')}) AND status = 'done'`, ...ids)?.c || 0)
    : 0;

  const closed = programs.filter((p) => p.status === 'closed');
  const scored = closed.map((p) => computeProgram(p.id)).filter((r) => r && r.normalized_score !== null);
  const avgScore = scored.length
    ? scored.reduce((s, r) => s + r.normalized_score, 0) / scored.length : null;

  return { programs, students, sessions, activities, closedCount: closed.length, avgScore };
}

/** بطاقة برنامج للعرض العام. */
function programCard(p) {
  const result = p.status === 'closed' ? computeProgram(p.id) : null;
  const statusText = { active: 'قائم الآن', closing: 'قيد الإقفال', closed: 'مكتمل' }[p.status] || p.status;
  const students = Number(get('SELECT COUNT(*) c FROM students WHERE program_id = ?', p.id)?.c || 0);

  return `<article class="pcard">
    <div class="top">
      <h3>${esc(p.name)}</h3>
      <small>${esc(p.kind || 'برنامج')} · ${esc(p.term || '')}</small>
    </div>
    <div class="body">
      <p>${icon('calendar', { size: 15 })} ${fmtDate(p.start_date)} — ${fmtDate(p.end_date)}</p>
      <p>${icon('building', { size: 15 })} ${esc(p.venue_name || 'يُحدَّد لاحقًا')}${p.venue_location ? ` · ${esc(p.venue_location)}` : ''}</p>
      <div class="metrics">
        <div><strong>${p.planned_sessions || 0}</strong> لقاءً</div>
        <div><strong>${students}</strong> مستفيدًا</div>
        ${result ? `<div><strong>${fmtNum(result.normalized_score)}</strong> من 300</div>` : ''}
      </div>
    </div>
    <div class="foot-row">
      <span class="badge ${p.status === 'closed' ? 'muted' : 'good'}">${esc(statusText)}</span>
      <a class="btn sec small" href="/programs-public/${p.id}">التفاصيل ${icon('chevron', { size: 14 })}</a>
    </div>
  </article>`;
}

const pubStat = (ico, value, label) => `<div class="pubstat">
  <div class="ico-wrap">${icon(ico, { size: 20 })}</div>
  <div class="v">${esc(value)}</div>
  <div class="l">${esc(label)}</div>
</div>`;

export default function register(router) {
  // ------------------------------ الرئيسية ------------------------------
  router.get('/', (ctx) => {
    const s = orgStats();
    const featured = s.programs.slice(0, 3);
    const activities = all(
      `SELECT a.*, p.name AS program_name FROM activities a
         JOIN programs p ON p.id = a.program_id
        WHERE p.is_public = 1 AND a.status = 'done'
        ORDER BY a.activity_date DESC LIMIT 3`,
    );

    return html(ctx.res, publicPage({
      title: 'الرئيسية',
      active: '/',
      user: ctx.user,
      body: `
      <section class="hero"><div class="hero-in">
        <div>
          <span class="hero-badge">${icon('star', { size: 14 })} مقياس جودة تشغيلي من 300 درجة</span>
          <h1>نقيس جودة برامجنا<br>لا نكتفي بتنفيذها</h1>
          <p>
            في ${esc(ORG)} يخضع كل برنامج لمقياس جودة من 300 درجة يغطي البيئة والمرافق،
            وجودة العملية التعليمية، وتجربة الطالب — بقياس موثّق وشواهد ومراجعة مستقلة،
            إضافة إلى قياس أثر تعليمي يجيب عن سؤال: هل تعلّم الطالب فعلًا؟
          </p>
          <div class="cta">
            <a class="btn gold" href="/programs-public">${icon('programs', { size: 16 })} تصفّح البرامج</a>
            <a class="btn ghost" href="/reports-public">${icon('reports', { size: 16 })} مؤشرات الجودة</a>
          </div>
        </div>
        <div class="hero-art"><img src="/logo.svg" alt="شعار ${esc(ORG)}"></div>
      </div></section>

      <div class="pubstats">
        ${pubStat('programs', s.programs.length, 'برنامجًا معلنًا')}
        ${pubStat('students', s.students, 'مستفيدًا')}
        ${pubStat('sessions', s.sessions, 'لقاءً تعليميًا')}
        ${pubStat('activity', s.activities, 'نشاطًا منفّذًا')}
        ${pubStat('metric', s.avgScore === null ? '—' : fmtNum(s.avgScore), 'متوسط الجودة من 300')}
      </div>

      <main>
        <div class="sec-title">
          <h2>أحدث البرامج</h2>
          <p>برامج قائمة ومكتملة، ولكل مكتمل منها درجة جودة معلنة</p>
        </div>
        <div class="cards">${featured.map(programCard).join('') || '<p class="empty">لا توجد برامج معلنة حاليًا.</p>'}</div>
        ${s.programs.length > 3 ? `<p style="text-align:center;margin-top:1.2rem">
          <a class="btn sec" href="/programs-public">عرض كل البرامج (${s.programs.length})</a></p>` : ''}

        <div class="sec-title">
          <h2>كيف نضمن الجودة؟</h2>
          <p>أربعة مبادئ تحكم عمل منصة التخطيط والجودة العلمية</p>
        </div>
        <div class="grid duo">
          <div class="panel"><div class="panel-body feature">
            <div class="fi">${icon('target', { size: 21 })}</div>
            <div><h3>قياس لا انطباع</h3>
            <p>كل مؤشر له أداة وقاعدة حساب ودورية معتمدة: قوائم تحقق بثلاث حالات،
              واستبانات بمقياس محدد، وسجلات تشغيلية — بلا تقدير شخصي.</p></div>
          </div></div>
          <div class="panel"><div class="panel-body feature gold">
            <div class="fi">${icon('check', { size: 21 })}</div>
            <div><h3>الجودة منفصلة عن الاكتمال</h3>
            <p>نعرض نتيجة الجودة ونسبة اكتمال القياس رقمين منفصلين، فلا يُخفي
              برنامجٌ ضعفَ قياسه خلف نتيجة مرتفعة على عيّنة صغيرة.</p></div>
          </div></div>
          <div class="panel"><div class="panel-body feature">
            <div class="fi">${icon('impact', { size: 21 })}</div>
            <div><h3>قياس الأثر التعليمي</h3>
            <p>اختبار قبلي وبعدي وتقييم عملي لكل برنامج، لقياس ما تعلّمه الطالب فعلًا
              — مستقلًا عن مقياس جودة العملية.</p></div>
          </div></div>
          <div class="panel"><div class="panel-body feature gold">
            <div class="fi">${icon('audit', { size: 21 })}</div>
            <div><h3>شواهد وتدقيق</h3>
            <p>كل نتيجة مسنودة بشاهد موثّق، وكل تعديل مسجّل في سجل تدقيق،
              ولا يُقفل برنامج قبل إظهار قياساته الناقصة.</p></div>
          </div></div>
        </div>

        ${activities.length ? `
        <div class="sec-title">
          <h2>أنشطة منفّذة</h2>
          <p>أنشطة وتطبيقات إثرائية ضمن برامج الجمعية</p>
        </div>
        <div class="cards">${activities.map((a) => `<article class="pcard">
          <div class="top"><h3>${esc(a.name)}</h3><small>${esc(a.program_name)}</small></div>
          <div class="body">
            <p>${icon('calendar', { size: 15 })} ${fmtDate(a.activity_date)}</p>
            ${a.notes ? `<p>${esc(a.notes)}</p>` : ''}
          </div>
          <div class="foot-row">
            <span class="badge ${a.is_main ? 'info' : 'muted'}">${a.is_main ? 'نشاط رئيس' : esc(a.kind || 'نشاط')}</span>
            <span class="muted" style="font-size:.78rem">منفّذ</span>
          </div>
        </article>`).join('')}</div>` : ''}
      </main>`,
    }));
  });

  // ------------------------------ عن الجمعية ----------------------------
  router.get('/about', (ctx) => html(ctx.res, publicPage({
    title: 'عن الجمعية',
    active: '/about',
    user: ctx.user,
    body: `<main>
      <div class="sec-title"><h2>عن ${esc(ORG)}</h2><p>رقم الترخيص 1000571500</p></div>
      <div class="panel"><div class="panel-body">
        <p>${esc(ORG)} جمعية أهلية مرخّصة تُعنى ببرامج تحصيل المعرفة وتأهيل المتعلمين،
          وتلتزم بتطبيق نظام جودة تشغيلي على كل برنامج تنفّذه.</p>
        <h3 style="margin-top:1.2rem">مقياس الجودة المعتمد — 300 درجة</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>القسم</th><th>الدرجة</th><th>ما يقيسه</th></tr></thead>
          <tbody>
            <tr><td>جودة البيئة والمرافق</td><td class="num">75</td>
              <td>ملاءمة القاعات ونظافتها وتهيئتها، والتجهيزات التعليمية والتقنية، والضيافة</td></tr>
            <tr><td>جودة العملية التعليمية</td><td class="num">135</td>
              <td>كفاءة المعلم وجودة المحتوى، والالتزام بالخطة، والأنشطة الإثرائية، والمتابعة والانضباط</td></tr>
            <tr><td>جودة الدعم وتجربة الطالب</td><td class="num">90</td>
              <td>معالجة الشكاوى، والدعم والإرشاد والتواصل، والرضا والانتماء، واستمرارية الطلاب</td></tr>
          </tbody>
        </table></div>
        <h3 style="margin-top:1.2rem">ضمانات النزاهة</h3>
        <ul class="duties">
          <li>تقييم المعلم من مصدرين: استبانة الطلاب وزيارة صفية من مسؤول الجودة العلمية.</li>
          <li>لا تُحتسب نتيجة استبانة لم تبلغ نسبة استجابتها 70%، وتُوسم «عينة غير كافية».</li>
          <li>رابط الاستبانة فردي لكل طالب ويُستخدم مرة واحدة، وإجابته لا تُربط باسمه.</li>
          <li>لا يحكم الطالب على السلامة العلمية للمحتوى — تلك مسؤولية مراجعة متخصصة.</li>
          <li>لا يُقفل البرنامج قبل إظهار قياساته الناقصة وشكاواه غير المغلقة.</li>
        </ul>
      </div></div>
    </main>`,
  })));

  // ------------------------------ البرامج -------------------------------
  router.get('/programs-public', (ctx) => {
    const programs = publicPrograms();
    return html(ctx.res, publicPage({
      title: 'البرامج',
      active: '/programs-public',
      user: ctx.user,
      body: `<main>
        <div class="sec-title"><h2>برامج الجمعية</h2>
          <p>${programs.length} برنامجًا معلنًا — القائم والمكتمل</p></div>
        <div class="cards">${programs.map(programCard).join('') || '<p class="empty">لا توجد برامج معلنة حاليًا.</p>'}</div>
      </main>`,
    }));
  });

  router.get('/programs-public/:pid', (ctx) => {
    const p = get(
      `SELECT p.*, v.name AS venue_name, v.location AS venue_location
         FROM programs p LEFT JOIN venues v ON v.id = p.venue_id
        WHERE p.id = ? AND p.is_public = 1 AND p.status <> 'draft'`,
      ctx.params.pid,
    );
    if (!p) {
      return html(ctx.res, publicPage({
        title: 'غير موجود',
        user: ctx.user,
        body: '<main><div class="panel"><div class="panel-body"><h1>البرنامج غير متاح</h1><p class="muted">قد يكون غير معلن أو حُذف.</p><p><a class="btn sec" href="/programs-public">كل البرامج</a></p></div></div></main>',
      }), 404);
    }

    const plan = get('SELECT * FROM plans WHERE program_id = ?', p.id);
    const students = Number(get('SELECT COUNT(*) c FROM students WHERE program_id = ?', p.id)?.c || 0);
    const activities = all(
      "SELECT name, kind, is_main, activity_date FROM activities WHERE program_id = ? AND status = 'done' ORDER BY activity_date",
      p.id,
    );
    const result = p.status === 'closed' ? computeProgram(p.id) : null;
    const im = p.status === 'closed' ? programImpact(p.id) : null;

    return html(ctx.res, publicPage({
      title: p.name,
      active: '/programs-public',
      user: ctx.user,
      body: `<main>
        <div class="crumbs"><a href="/programs-public">البرامج</a> ← ${esc(p.name)}</div>
        <div class="pagehead"><div>
          <h1>${esc(p.name)}</h1>
          <p class="meta">${esc(p.kind || 'برنامج')} · ${esc(p.term || '')} ·
            ${fmtDate(p.start_date)} — ${fmtDate(p.end_date)} · ${esc(p.venue_name || '')}</p>
        </div></div>

        <div class="stats">
          <div class="stat"><div class="stat-value">${p.planned_sessions || 0}</div><div class="stat-label">عدد اللقاءات</div></div>
          <div class="stat"><div class="stat-value">${students}</div><div class="stat-label">عدد المستفيدين</div></div>
          ${result ? `<div class="stat info"><div class="stat-value">${fmtNum(result.normalized_score)}</div>
            <div class="stat-label">درجة الجودة من 300</div></div>
            <div class="stat good"><div class="stat-value">${fmtNum(result.coverage_pct)}%</div>
            <div class="stat-label">اكتمال القياس</div></div>` : ''}
          ${im?.has_data && im.normalized_gain !== null ? `<div class="stat warn">
            <div class="stat-value">${fmtNum(im.normalized_gain)}%</div>
            <div class="stat-label">مكسب التعلم</div></div>` : ''}
        </div>

        ${plan?.objectives || plan?.outcomes ? `<div class="panel">
          <header class="panel-head"><h2>أهداف البرنامج ومخرجاته</h2></header>
          <div class="panel-body">
            ${plan.objectives ? `<p><strong>الأهداف:</strong> ${esc(plan.objectives)}</p>` : ''}
            ${plan.outcomes ? `<p><strong>المخرجات:</strong> ${esc(plan.outcomes)}</p>` : ''}
            ${plan.content_outline ? `<p><strong>المحتوى:</strong> ${esc(plan.content_outline)}</p>` : ''}
          </div></div>` : ''}

        ${activities.length ? `<div class="panel">
          <header class="panel-head"><h2>الأنشطة المنفّذة</h2></header>
          <div class="panel-body"><ul class="evidence">
            ${activities.map((a) => `<li>${esc(a.name)}
              <small>${esc(a.kind || '')} ${a.is_main ? '· نشاط رئيس' : ''} · ${fmtDate(a.activity_date)}</small></li>`).join('')}
          </ul></div></div>` : ''}

        ${result ? `<div class="panel">
          <header class="panel-head"><h2>نتيجة الجودة حسب الأقسام</h2></header>
          <div class="panel-body"><div class="table-wrap"><table class="stackable">
            <thead><tr><th>القسم</th><th>الدرجة</th><th>النسبة</th></tr></thead>
            <tbody>${result.sections.map((sec) => `<tr>
              <td data-label="القسم">${esc(sec.section.name)}</td>
              <td data-label="الدرجة" class="num">${fmtNum(sec.earned)} / ${fmtNum(sec.weight)}</td>
              <td data-label="النسبة" class="num">${sec.score_pct === null ? '—' : `${fmtNum(sec.score_pct)}%`}</td>
            </tr>`).join('')}</tbody>
          </table></div></div></div>` : `<div class="flash info">
            ${icon('alert', { size: 17 })}
            <span>البرنامج ما زال قائمًا — تُعلن درجة الجودة النهائية بعد إقفاله واكتمال قياساته.</span></div>`}
      </main>`,
    }));
  });

  // ------------------------------ الأنشطة -------------------------------
  router.get('/activities-public', (ctx) => {
    const rows = all(
      `SELECT a.*, p.name AS program_name, p.id AS pid FROM activities a
         JOIN programs p ON p.id = a.program_id
        WHERE p.is_public = 1 AND a.status = 'done'
        ORDER BY a.activity_date DESC`,
    );
    return html(ctx.res, publicPage({
      title: 'الأنشطة',
      active: '/activities-public',
      user: ctx.user,
      body: `<main>
        <div class="sec-title"><h2>الأنشطة والتطبيقات الإثرائية</h2>
          <p>${rows.length} نشاطًا منفّذًا ضمن برامج الجمعية</p></div>
        <div class="cards">${rows.map((a) => `<article class="pcard">
          <div class="top"><h3>${esc(a.name)}</h3><small>${esc(a.program_name)}</small></div>
          <div class="body">
            <p>${icon('calendar', { size: 15 })} ${fmtDate(a.activity_date)}</p>
            ${a.notes ? `<p>${esc(a.notes)}</p>` : ''}
          </div>
          <div class="foot-row">
            <span class="badge ${a.is_main ? 'info' : 'muted'}">${a.is_main ? 'نشاط رئيس' : esc(a.kind || 'نشاط')}</span>
            <a class="btn sec small" href="/programs-public/${a.pid}">البرنامج</a>
          </div>
        </article>`).join('') || '<p class="empty">لا توجد أنشطة منفّذة معلنة.</p>'}</div>
      </main>`,
    }));
  });

  // ------------------------------ التقارير العامة -----------------------
  router.get('/reports-public', (ctx) => {
    const s = orgStats();
    const closed = s.programs.filter((p) => p.status === 'closed')
      .map((p) => ({ p, r: computeProgram(p.id) }))
      .filter((x) => x.r);

    return html(ctx.res, publicPage({
      title: 'التقارير العامة',
      active: '/reports-public',
      user: ctx.user,
      body: `<main>
        <div class="sec-title"><h2>مؤشرات الجودة المعلنة</h2>
          <p>نتائج البرامج المكتملة وفق المقياس المعتمد من 300 درجة</p></div>

        <div class="stats">
          <div class="stat"><div class="stat-value">${s.programs.length}</div><div class="stat-label">برنامجًا معلنًا</div></div>
          <div class="stat good"><div class="stat-value">${s.closedCount}</div><div class="stat-label">برنامجًا مكتملًا</div></div>
          <div class="stat info"><div class="stat-value">${s.avgScore === null ? '—' : fmtNum(s.avgScore)}</div>
            <div class="stat-label">متوسط الجودة من 300</div></div>
          <div class="stat"><div class="stat-value">${s.students}</div><div class="stat-label">مستفيدًا</div></div>
        </div>

        <div class="panel">
          <header class="panel-head"><h2>نتائج البرامج المكتملة</h2></header>
          <div class="panel-body">
            ${closed.length ? `<div class="table-wrap"><table class="stackable">
              <thead><tr><th>البرنامج</th><th>الفترة</th><th>الدرجة من 300</th><th>اكتمال القياس</th><th></th></tr></thead>
              <tbody>${closed.map(({ p, r }) => `<tr>
                <td data-label="البرنامج">${esc(p.name)}</td>
                <td data-label="الفترة">${esc(p.term || '')} ${fmtDate(p.start_date)}</td>
                <td data-label="الدرجة" class="num">${fmtNum(r.normalized_score)}</td>
                <td data-label="اكتمال القياس" class="num">${fmtNum(r.coverage_pct)}%</td>
                <td><a class="btn sec small" href="/programs-public/${p.id}">التفاصيل</a></td>
              </tr>`).join('')}</tbody>
            </table></div>`
    : '<p class="empty">لم يُقفل أي برنامج بعد — تُعلن النتائج بعد إقفال البرامج.</p>'}
            <p class="hint" style="margin-top:.8rem">
              «الدرجة من 300» معيارية تُتيح مقارنة البرامج المختلفة الاستثناءات،
              و«اكتمال القياس» يُعرض مستقلًا عنها حتى تُقرأ النتيجة في سياقها الصحيح.
            </p>
          </div>
        </div>
      </main>`,
    }));
  });
}
