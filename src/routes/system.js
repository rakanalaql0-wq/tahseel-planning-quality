import { all, get } from '../db/index.js';
import { esc, fmtNum } from '../lib/util.js';
import { html } from '../lib/http.js';
import { publicPage } from '../views/layout.js';
import { icon } from '../views/icons.js';
import { samplePlanLabel, minResponseRate } from '../lib/scoring.js';
import { PERMISSIONS, activeRoles, roleName } from '../lib/roles.js';
import { setting } from '../lib/settings.js';
import { IMPACT_KINDS } from '../db/framework.js';

/**
 * صفحة «النظام» — شرح المنصة كاملة.
 *
 * قاعدة بناء هذه الصفحة: **تُولَّد من النظام نفسه لا تُكتب عنه**.
 * شجرة المقياس والأوزان والمناصب وصلاحياتها وخطط العينة تُقرأ من قاعدة
 * البيانات لحظة العرض، فإذا عدّل مدير النظام وزنًا أو أضاف منصبًا تغيّر
 * الشرح معه. الصفحة المكتوبة يدويًا تكذب بعد أول تعديل؛ وهذه لا تستطيع.
 *
 * وهي عامة بلا تسجيل دخول، ولا تعرض أي بيانات شخصية — بنية النظام وقواعده فقط.
 */

const TOOL_LABEL = { checklist: 'قائمة تحقق', survey: 'استبانة', record: 'سجل تشغيلي' };

/** فهرس جانبي لصفحة طويلة. */
const CHAPTERS = [
  ['idea', 'الفكرة الحاكمة', 'sparkle'],
  ['scale', 'المقياس: 300 درجة', 'scale'],
  ['tree', 'شجرة المقياس كاملة', 'layers'],
  ['tools', 'أدوات القياس الثلاث', 'check'],
  ['numbers', 'الأرقام الثلاثة ولماذا تختلف', 'metric'],
  ['roles', 'المناصب والصلاحيات', 'team'],
  ['lifecycle', 'دورة حياة البرنامج', 'continuity'],
  ['tasks', 'المهام: كيف يعرف كلٌّ واجبه', 'tasks'],
  ['surveys', 'الاستبانات ونزاهتها', 'survey'],
  ['impact', 'قياس الأثر التعليمي', 'impact'],
  ['diagnostics', 'التشخيص والإنذار المبكر', 'alert'],
  ['actions', 'الإجراءات التصحيحية', 'actions'],
  ['benchmark', 'المقارنة والمعايرة', 'reports'],
  ['exempt', 'المؤشر غير المنطبق', 'info'],
  ['evidence', 'الشواهد وسجل التدقيق', 'audit'],
  ['rules', 'قواعد الأعمال المعتمدة', 'list'],
  ['glossary', 'مسرد المصطلحات', 'file'],
];

/** فصل من فصول الشرح. */
const chapter = (id, title, ico, body) => `<section class="doc-sec" id="${id}">
  <h2>${icon(ico, { size: 20 })}<span>${esc(title)}</span></h2>
  ${body}
</section>`;

/** بطاقة تعريف قصيرة داخل الشرح. */
const defCard = (term, body) => `<div class="doc-def">
  <strong>${esc(term)}</strong><p>${body}</p></div>`;

/** يبني شجرة المقياس كاملة من قاعدة البيانات. */
function scaleTree() {
  const sections = all('SELECT * FROM metric_sections ORDER BY sort, id');
  const axes = all('SELECT * FROM metric_axes ORDER BY sort, id');
  const indicators = all('SELECT * FROM indicators WHERE is_active = 1 ORDER BY sort, id');

  return sections.map((s) => {
    const sAxes = axes.filter((a) => a.section_id === s.id);
    const sIndicators = indicators.filter((i) => sAxes.some((a) => a.id === i.axis_id));
    const sWeight = sIndicators.reduce((acc, i) => acc + Number(i.weight), 0);

    return `<div class="doc-section-block">
      <h3><span class="doc-num">${fmtNum(sWeight, 0)}</span> ${esc(s.name)}</h3>
      ${sAxes.map((a) => {
    const aInds = indicators.filter((i) => i.axis_id === a.id);
    if (!aInds.length) return '';
    const aWeight = aInds.reduce((acc, i) => acc + Number(i.weight), 0);
    return `<div class="doc-axis">
          <h4>${esc(a.name)} <span class="badge info">${fmtNum(aWeight, 0)} درجة</span></h4>
          <div class="table-wrap"><table class="compact">
            <thead><tr><th>المؤشر</th><th>الأداة</th><th>من يقيسه</th><th>متى يُقاس</th><th>الدرجة</th></tr></thead>
            <tbody>${aInds.map((i) => `<tr>
              <td>${esc(i.name)}${i.description ? `<br><small class="muted">${esc(i.description)}</small>` : ''}</td>
              <td>${esc(TOOL_LABEL[i.tool] || i.tool)}</td>
              <td>${esc(roleName(i.owner_role))}</td>
              <td><small>${esc(samplePlanLabel(i))}</small></td>
              <td class="num"><strong>${fmtNum(i.weight, 0)}</strong></td>
            </tr>`).join('')}</tbody>
          </table></div>
        </div>`;
  }).join('')}
    </div>`;
  }).join('');
}

export default function register(router) {
  router.get('/system', (ctx) => {
    const org = setting('org_name');
    const rate = minResponseRate();
    const sla = setting('default_sla_days');
    const indicators = all('SELECT * FROM indicators WHERE is_active = 1');
    const total = indicators.reduce((s, i) => s + Number(i.weight), 0);
    const byTool = (t) => indicators.filter((i) => i.tool === t).length;
    const roles = activeRoles();
    const items = Number(get('SELECT COUNT(*) c FROM checklist_items WHERE is_active = 1')?.c || 0);
    const questions = Number(get('SELECT COUNT(*) c FROM question_bank')?.c || 0);

    const body = `
    <div class="doc-hero">
      <div class="doc-hero-in">
        <span class="hero-badge">${icon('shield', { size: 15 })} دليل النظام الكامل</span>
        <h1>النظام</h1>
        <p>كيف تقيس ${esc(org)} جودة برامجها: المقياس وأوزانه، وأدوات القياس،
          ومن يقيس ماذا ومتى، وكيف تُحتسب الدرجة، وما الذي يضمن نزاهة الرقم.</p>
        <p class="doc-hero-note">${icon('info', { size: 14 })}
          هذه الصفحة مولّدة من النظام نفسه لحظة فتحها — لا مكتوبة عنه.
          فإذا عُدّل وزن أو أُضيف منصب، تغيّر الشرح معه.</p>
      </div>
    </div>

    <main class="wide doc-layout">
      <nav class="doc-toc">
        <strong>محتويات الدليل</strong>
        <ol>${CHAPTERS.map(([id, label]) => `<li><a href="#${id}">${esc(label)}</a></li>`).join('')}</ol>
      </nav>

      <div class="doc-body">

      ${chapter('idea', 'الفكرة الحاكمة', 'sparkle', `
        <p class="doc-lead">المنصة لا تسأل «هل نفّذنا البرنامج؟» بل «بأي جودة نفّذناه، وبأي دليل؟».</p>
        <p>كل برنامج تنفّذه الجمعية يخضع لمقياس تشغيلي من <strong>${fmtNum(total, 0)} درجة</strong>،
          موزّعة على مؤشرات لكل منها أداة قياس محددة، ومسؤول محدد، وموعد محدد، وشاهد موثّق.
          فالدرجة ليست انطباعًا يكتبه أحد في نهاية البرنامج، بل حصيلة قياسات مسجّلة في وقتها.</p>
        <div class="doc-cards">
          ${defCard('لا انطباع بلا أداة', 'كل مؤشر له أداة: قائمة تحقق بثلاث حالات، أو استبانة بمقياس ليكرت، أو سجل تشغيلي يُحسب من بيانات النظام. لا يوجد حقل «قيّم من 10».')}
          ${defCard('لا واجب يُبحث عنه', 'النظام يولّد لكل مسؤول قائمة واجباته ومواعيدها، ويرتّبها بالأثر لا بالتاريخ. فلا يحتاج أحد أن يتذكّر ما عليه.')}
          ${defCard('لا رقم بلا دليل', 'كل نتيجة مسنودة بشاهد، وكل تعديل مسجّل في سجل التدقيق باسم فاعله ووقته وقيمته قبل وبعد.')}
          ${defCard('لا إقفال بلا كشف', 'لا يُقفل برنامج قبل أن يعرض قياساته الناقصة وشكاواه غير المغلقة. والإقفال القسري يُسجَّل بسببه.')}
        </div>`)}

      ${chapter('scale', 'المقياس: 300 درجة', 'scale', `
        <p>المقياس ثلاثة أقسام، ولكل قسم محاور، ولكل محور مؤشرات. الدرجة الكاملة
          <strong>${fmtNum(total, 0)}</strong> موزّعة كما يلي:</p>
        <div class="doc-stats">
          ${all('SELECT * FROM metric_sections ORDER BY sort, id').map((s) => {
    const w = all(`SELECT i.weight FROM indicators i JOIN metric_axes a ON a.id = i.axis_id
                     WHERE a.section_id = ? AND i.is_active = 1`, s.id)
      .reduce((acc, i) => acc + Number(i.weight), 0);
    return `<div class="doc-stat">
              <span class="v">${fmtNum(w, 0)}</span>
              <span class="l">${esc(s.name)}</span>
              <span class="p">${fmtNum((w / total) * 100, 0)}% من المقياس</span>
            </div>`;
  }).join('')}
        </div>
        <p class="hint">النسبة الأكبر لجودة العملية التعليمية عن قصد: هي جوهر البرنامج،
          والبيئة والدعم شرطان يخدمانها لا غاية في ذاتهما.</p>`)}

      ${chapter('tree', 'شجرة المقياس كاملة', 'layers', `
        <p>كل مؤشر بوزنه وأداته ومَن يقيسه ومتى. هذه هي الشجرة المعتمدة الآن في النظام:</p>
        ${scaleTree()}`)}

      ${chapter('tools', 'أدوات القياس الثلاث', 'check', `
        <p>لا يُقاس مؤشر إلا بواحدة من ثلاث أدوات، ولكل أداة معادلتها المعلنة:</p>

        <div class="doc-tool">
          <h3>${icon('check', { size: 17 })} قائمة التحقق <span class="badge muted">${byTool('checklist')} مؤشرًا · ${items} بندًا</span></h3>
          <p>يمرّ المسؤول على بنود محددة مسبقًا، ويضع لكل بند إحدى ثلاث حالات:</p>
          <div class="doc-states">
            <span class="badge good">متحقق = 100%</span>
            <span class="badge warn">متحقق جزئيًا = 50%</span>
            <span class="badge bad">غير متحقق = 0%</span>
          </div>
          <p class="doc-formula">نتيجة المؤشر = مجموع (حالة البند × وزنه النسبي) ÷ مجموع الأوزان</p>
          <p class="hint">والملاحظة <strong>إلزامية</strong> عند «جزئي» أو «غير متحقق» — فالنظام يرفض الاعتماد بدونها،
            حتى لا تبقى درجة منقوصة بلا سبب مكتوب (BR-04).</p>
        </div>

        <div class="doc-tool">
          <h3>${icon('survey', { size: 17 })} الاستبانة <span class="badge muted">${byTool('survey')} مؤشرًا · ${questions} سؤالًا</span></h3>
          <p>أسئلة تُعرض على الطلاب بمقياس ليكرت من خمس درجات (من «لا أوافق بشدة» إلى «أوافق بشدة»).</p>
          <p class="doc-formula">نتيجة السؤال = (متوسط الإجابات − 1) ÷ 4 × 100</p>
          <p class="hint">الطرح والقسمة لتحويل مقياس من 1 إلى 5 إلى نسبة من 0 إلى 100:
            فمن أجاب «1» على كل الأسئلة نتيجته 0% لا 20%.</p>
        </div>

        <div class="doc-tool">
          <h3>${icon('metric', { size: 17 })} السجل التشغيلي <span class="badge muted">${byTool('record')} مؤشرات</span></h3>
          <p>لا إدخال يدوي أصلًا: النظام يقرأ بياناته المسجّلة ويحسب النسبة بنفسه —
            نسبة الحضور من سجل الحضور، والتزام الشكاوى بالمدة من تواريخ إغلاقها،
            واستمرارية الطلاب من حالاتهم. فهذه المؤشرات لا تُقاس، بل تُستخرج.</p>
        </div>`)}

      ${chapter('numbers', 'الأرقام الثلاثة ولماذا تختلف', 'metric', `
        <p class="doc-lead">أكثر ما يُساء فهمه في المقاييس: برنامج نتيجته 90% وهو لم يُقَس أصلًا إلا في ربع مؤشراته.
          لذلك يعرض النظام ثلاثة أرقام منفصلة لا رقمًا واحدًا.</p>
        <div class="doc-cards">
          ${defCard('نتيجة الجودة', 'كم أحسنّا فيما قِسناه — نسبة مئوية محسوبة على المؤشرات التي لها قياس فعلي فقط. لا تقول شيئًا عمّا لم يُقس.')}
          ${defCard('اكتمال القياس', 'كم قِسنا مما كان يجب قياسه — نسبة المؤشرات المكتملة إلى المطلوبة. رقم أمانة لا رقم أداء.')}
          ${defCard('الدرجة المحققة', `الدرجات المكتسبة فعلًا من ${fmtNum(total, 0)}. المؤشر غير المقيس لا يُمنح درجته.`)}
          ${defCard('الدرجة المعيارية', 'الدرجة المحققة منسوبة إلى الوزن المنطبق فعلًا — لتكون المقارنة عادلة بين برنامج له مؤشرات غير منطبقة وآخر ليس كذلك.')}
        </div>
        <p class="hint">فصل «نتيجة الجودة» عن «اكتمال القياس» قاعدة معتمدة (BR-11):
          الخلط بينهما يخفي ضعف القياس خلف نتيجة مرتفعة على عيّنة صغيرة.</p>`)}

      ${chapter('roles', 'المناصب والصلاحيات', 'team', `
        <p>لكل منصب صلاحياته ومسؤولياته، ويُسند داخل كل برنامج على حدة — فقد يكون
          الشخص مشرفًا في برنامج ومسؤول برنامج في آخر. المناصب المعتمدة الآن:</p>
        <div class="doc-roles">
          ${roles.map((r) => `<div class="doc-role">
            <h3>${icon('team', { size: 16 })} ${esc(r.name)}</h3>
            ${r.description ? `<p class="muted">${esc(r.description)}</p>` : ''}
            ${r.duties.length ? `<ul class="duties">${r.duties.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
            <p class="doc-role-count">${r.perms.size} صلاحية ·
              ${all('SELECT COUNT(*) c FROM indicators WHERE owner_role = ? AND is_active = 1', r.key)[0].c} مؤشرًا يملك قياسها</p>
          </div>`).join('')}
        </div>
        <h3 style="margin-top:1.4rem">مجالات الصلاحيات</h3>
        <p>الصلاحيات في النظام ${PERMISSIONS.reduce((n, g) => n + g.perms.length, 0)} صلاحية، مجمّعة في ${PERMISSIONS.length} مجالات:</p>
        <div class="table-wrap"><table class="compact">
          <thead><tr><th>المجال</th><th>ما يشمله</th></tr></thead>
          <tbody>${PERMISSIONS.map((g) => `<tr>
            <td><strong>${esc(g.group)}</strong></td>
            <td><small>${g.perms.map(([, label]) => esc(label)).join(' · ')}</small></td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="hint">المستخدم لا يرى في قوائمه إلا ما يملك صلاحيته — فالشاشة التي لا يملكها
          لا تُعرض له معطّلة، بل لا تُعرض أصلًا.</p>`)}

      ${chapter('lifecycle', 'دورة حياة البرنامج', 'continuity', `
        <p>يمرّ كل برنامج بأربع حالات، ولكل حالة ما يُسمح فيه:</p>
        <ol class="doc-steps">
          <li><strong>مسودة</strong> — تُسجَّل بيانات البرنامج وعدد لقاءاته وطلابه وقاعته.
            لم يبدأ القياس بعد.</li>
          <li><strong>نشط</strong> — يولّد النظام جدول القياسات كاملًا من المقياس:
            مهمة لكل مؤشر في موعدها ولمن يملك قياسه. هنا يجري العمل والقياس والتوثيق.</li>
          <li><strong>قيد الإقفال</strong> — يعرض النظام كشف الجاهزية: القياسات الناقصة،
            والشكاوى غير المغلقة، والإجراءات المفتوحة. لا يُقفل البرنامج وفي ذمّته ناقص
            إلا بإقفال قسري مسجّل بسببه.</li>
          <li><strong>مغلق</strong> — تُثبَّت الدرجة النهائية ونسبة الاكتمال في سجل البرنامج،
            فلا يغيّرها أي تعديل لاحق على أوزان المقياس. والبرنامج المغلق لا يقبل التعديل.</li>
        </ol>
        <p class="hint">تثبيت الدرجة عند الإقفال مقصود: لولاه لتغيّرت نتائج برامج سنوات ماضية
          كلما عُدّل وزن مؤشر، فلا يبقى تقرير قديم قابلًا للتفسير.</p>`)}

      ${chapter('tasks', 'المهام: كيف يعرف كلٌّ واجبه', 'tasks', `
        <p class="doc-lead">المستخدم لا يبحث عمّا يجب عليه فعله؛ النظام يعرض له واجباته.</p>
        <p>عند تنشيط البرنامج يقرأ النظام كل مؤشر ويسأل: كم مرة يجب قياسه، ومتى، ومن يقيسه؟
          ثم يولّد المهام تلقائيًا:</p>
        <ul class="duties">
          <li><strong>مؤشر يُقاس مرة واحدة</strong> (قبل البداية أو في المنتصف أو النهاية) — مهمة واحدة في موعدها.</li>
          <li><strong>مؤشر بعينة من اللقاءات</strong> — يختار النظام عينة موزّعة على اللقاءات بالنسبة المطلوبة
            وبالحد الأدنى المطلوب، ويولّد مهمة لكل لقاء مختار.</li>
          <li><strong>مؤشر بعدد ثابت</strong> — مهام بعدد المرات المطلوبة موزّعة على مدة البرنامج.</li>
          <li><strong>مؤشر بعد كل نشاط رئيس</strong> — تُنشأ مهمته لحظة تسجيل النشاط.</li>
        </ul>
        <p>ثم تُرتَّب مهام كل شخص <strong>بالأثر لا بالتاريخ</strong>: وزن المؤشر في المقياس،
          ومقدار التأخر، وقرب انتهاء فرصة القياس. فالمهمة التي تحمل 20 درجة وبقي لها لقاءان
          تسبق مهمة تحمل 5 درجات وبقي لها شهر.</p>`)}

      ${chapter('surveys', 'الاستبانات ونزاهتها', 'survey', `
        <p>الاستبانة أضعف أدوات القياس أمام العبث، فأحيطت بأربعة ضوابط:</p>
        <div class="doc-cards">
          ${defCard('رابط فردي لكل طالب', 'عند فتح الاستبانة يولّد النظام رابطًا فريدًا لكل طالب نشط، يُستخدم مرة واحدة. فلا يصوّت أحد مرتين ولا يصوّت من ليس طالبًا.')}
          ${defCard('إجابة غير مرتبطة بالاسم', 'النظام يسجّل أن الطالب أجاب، ولا يربط إجابته باسمه. فالمسؤول يعرف نسبة الاستجابة ولا يعرف من قال ماذا.')}
          ${defCard(`حد أدنى للاستجابة: ${fmtNum(rate, 0)}%`, 'الاستبانة التي لم تبلغ هذه النسبة تُوسم «عينة غير كافية»، ولا تُحتسب في اكتمال القياس. فخمس إجابات من مئة طالب ليست رأي الطلاب.')}
          ${defCard('حدود ما يُسأل عنه الطالب', 'لا تُبنى أسئلة الاستبانة على مؤشرات السلامة العلمية للمحتوى — تلك مسؤولية مراجعة متخصصة لا استفتاء. والنظام يمنع الربط بنيويًا لا بالتنبيه.')}
        </div>
        <p class="hint">وتقييم المعلم تحديدًا من مصدرين لا مصدر واحد: استبانة الطلاب،
          وزيارة صفية من مسؤول الجودة العلمية — فلا يُحكم على معلم برأي طرف واحد.</p>`)}

      ${chapter('impact', 'قياس الأثر التعليمي', 'impact', `
        <p class="doc-lead">سؤال لا يجيب عنه مقياس الجودة: هل تعلّم الطالب فعلًا؟</p>
        <p>يمكن أن يكون البرنامج ممتاز التنفيذ — قاعة مهيّأة ومعلم كفء وخطة منضبطة —
          ولا يتعلم فيه أحد شيئًا. لذلك فُصل قياس الأثر عن المقياس تمامًا:
          <strong>لا يدخل في الـ ${fmtNum(total, 0)} درجة ولا يؤثر فيها</strong>، ويُعرض في تبويب مستقل.</p>
        <p>أدوات القياس فيه:</p>
        <ul class="duties">
          ${IMPACT_KINDS.map((k) => `<li><strong>${esc(k.label)}</strong></li>`).join('')}
        </ul>
        <p>ويُحسب من الدرجات القبلية والبعدية <strong>مكسب التعلّم المعياري</strong>:
          كم من الفجوة التي كانت أمام الطالب أُغلقت فعلًا — لا مجرد فرق الدرجتين.
          فالطالب الذي انتقل من 80 إلى 90 أغلق نصف فجوته، والذي انتقل من 40 إلى 50 أغلق سُدسها،
          وإن كان الفرق في الحالتين عشر درجات.</p>
        <p class="doc-formula">مكسب التعلّم = (البعدي − القبلي) ÷ (الدرجة الكاملة − القبلي)</p>`)}

      ${chapter('diagnostics', 'التشخيص والإنذار المبكر', 'alert', `
        <p class="doc-lead">أن تعرف أن الدرجة ستضيع قبل أن تضيع، لا بعد الإقفال.</p>
        <p>يفحص النظام كل برنامج قائم ويرفع ملاحظات مرتّبة بالخطورة ثم بالأثر بالدرجات،
          ولكل ملاحظة سببها ورقمها والإجراء المقترح ورابطه. من أهمها:</p>
        <ul class="duties">
          <li><strong>عينة يستحيل اكتمالها</strong> — يقارن النظام ما تبقّى من فرص القياس بما تبقّى من قياسات مطلوبة،
            فيقول: «تحتاج 6 قياسات ولم يبقَ إلا لقاءان — 20 درجة ستضيع إن لم تُضف لقاءات أو تُعدَّل خطة العينة».
            هذه أهم ملاحظة في النظام، لأنها الوحيدة التي تنذر قبل فوات الأوان لا بعده.</li>
          <li><strong>فرصة قياس فاتت</strong> — لقاء انقضى وكان ضمن العينة ولم يُقس فيه.</li>
          <li><strong>ضغط الوقت</strong> — قرب نهاية البرنامج مع بقاء قياسات كثيرة.</li>
          <li><strong>درجة مفقودة</strong> — مؤشر قِيس ونتيجته منخفضة، مع بيان كم درجة خسرها.</li>
          <li><strong>استبانة متأخرة أو دون الحد</strong>، و<strong>شكوى تجاوزت مدتها</strong>،
            و<strong>إجراء تصحيحي متأخر</strong>، و<strong>مشكلة تكررت بعد إغلاق إجراءها</strong>.</li>
        </ul>`)}

      ${chapter('actions', 'الإجراءات التصحيحية', 'actions', `
        <p>حين يُخفق بند تحقق، ينشئ النظام إجراءً تصحيحيًا بمالك وموعد. والقاعدة الحاكمة:
          <strong>المشكلة الواحدة = إجراء واحد يحمل عدّاد تكرارها</strong>.</p>
        <p>فلو أخفق «المكيف لا يعمل» أربع مرات، لا يولّد النظام أربعة إجراءات متفرقة توهم
          بأربع مشكلات، بل يجمعها في إجراء واحد عدّاده أربعة — ويقصّر موعده كلما تكرر.</p>
        <p>وإن عادت المشكلة <strong>بعد إغلاق</strong> إجراءها، فُتح إجراء جديد موسوم «تكرار»
          بأولوية أعلى وموعد أقصر، ومكتوب فيه أن السبب الجذري لم يُعالَج — فالمطلوب مراجعة
          كفاية الإجراء السابق لا تكراره.</p>`)}

      ${chapter('benchmark', 'المقارنة والمعايرة', 'reports', `
        <p>يجيب النظام عن ثلاثة أسئلة لا يجيب عنها رقم البرنامج وحده:</p>
        <ul class="duties">
          <li><strong>هل هذا البرنامج أفضل أم أسوأ من معتاد الجمعية؟</strong> بمقارنة درجته المعيارية
            بمتوسط البرامج الأخرى التي لها قياسات فعلية.</li>
          <li><strong>في أي مؤشر تحديدًا؟</strong> بإبراز أبعد المؤشرات عن المعتاد صعودًا وهبوطًا.</li>
          <li><strong>هل نتحسّن عبر الفترات أم نراوح مكاننا؟</strong> بمتوسط كل فترة والفرق عن سابقتها.</li>
        </ul>
        <p>وتُبنى المقارنة على <strong>الدرجة المعيارية</strong> لا المحقق الخام،
          حتى لا يُظلم برنامج له مؤشرات غير منطبقة.</p>
        <p class="hint">وأضعف المؤشرات على مستوى الجمعية تُعرض مستقلة: الضعف المتكرر في كل
          البرامج يعني خللًا مؤسسيًا لا خطأ برنامج واحد.</p>`)}

      ${chapter('exempt', 'المؤشر غير المنطبق', 'info', `
        <p>بعض المؤشرات لا تنطبق على بعض البرامج — كمؤشرات القاعات في برنامج عن بُعد.
          فتُوسم «غير منطبق» بسبب موثّق واسم من وسمها.</p>
        <p>وأثر ذلك: <strong>يُطرح وزن المؤشر من المقياس ولا يُحسب صفرًا</strong>.
          فبرنامج عن بُعد لا يُعاقَب على قاعة لا يملكها. وتبقى درجته المعيارية قابلة للمقارنة
          مع غيره لأنها منسوبة إلى الوزن المنطبق عليه فعلًا.</p>`)}

      ${chapter('evidence', 'الشواهد وسجل التدقيق', 'audit', `
        <p><strong>الشواهد:</strong> لكل قياس ونتيجة وإجراء إمكان إرفاق شاهد — ملف أو رابط —
          بوصفه وتاريخه ومن رفعه. فالرقم بلا شاهد ادعاء.</p>
        <p><strong>سجل التدقيق:</strong> كل عملية مؤثرة تُسجَّل باسم فاعلها ووقتها ونوعها،
          ومعها <strong>القيمة قبل التعديل وبعده</strong>. يشمل ذلك الدخول، واعتماد القياسات،
          وتعديل الأوزان، وإسناد الأدوار، وإقفال البرامج، وتعديل المناصب وصلاحياتها.</p>
        <p class="hint">السجل غير قابل للتعديل من الواجهة — لا يوجد في النظام زر يحذف منه شيئًا.</p>`)}

      ${chapter('rules', 'قواعد الأعمال المعتمدة', 'list', `
        <p>خمس عشرة قاعدة مطبّقة في محرك الاحتساب نفسه لا في تعليمات الاستخدام:</p>
        <div class="table-wrap"><table class="compact">
          <thead><tr><th>الرمز</th><th>القاعدة</th></tr></thead>
          <tbody>
            <tr><td><code>BR-01</code></td><td>إجمالي المقياس 300 درجة: 75 + 135 + 90.</td></tr>
            <tr><td><code>BR-02</code></td><td>قائمة التحقق: متحقق 100%، جزئي 50%، غير متحقق 0%.</td></tr>
            <tr><td><code>BR-03</code></td><td>الاستبانة: (المتوسط − 1) ÷ 4 × 100.</td></tr>
            <tr><td><code>BR-04</code></td><td>الملاحظة إلزامية عند «جزئي» أو «غير متحقق».</td></tr>
            <tr><td><code>BR-05</code></td><td>تهيئة القاعات: عينة لا تقل عن 50% من اللقاءات.</td></tr>
            <tr><td><code>BR-06</code></td><td>الضيافة: عينة لا تقل عن 25% وبحد أدنى مرتين.</td></tr>
            <tr><td><code>BR-07</code></td><td>التجهيزات التعليمية: تحقق مرتان على الأقل.</td></tr>
            <tr><td><code>BR-08</code></td><td>الدعم والتواصل: قياس في منتصف البرنامج ونهايته.</td></tr>
            <tr><td><code>BR-09</code></td><td>فاعلية النشاط الرئيس: تُقاس مباشرة بعد كل نشاط.</td></tr>
            <tr><td><code>BR-10</code></td><td>الاستمرارية: 5 درجات لنية الاستمرار و15 للاستمرار الفعلي.</td></tr>
            <tr><td><code>BR-11</code></td><td>«اكتمال القياس» يُعرض مستقلاً عن «نتيجة الجودة».</td></tr>
            <tr><td><code>BR-12</code></td><td>لا يحكم الطالب على السلامة العلمية للمحتوى.</td></tr>
            <tr><td><code>BR-13</code></td><td>الاستبانة دون ${fmtNum(rate, 0)}% استجابة تُوسم «عينة غير كافية».</td></tr>
            <tr><td><code>BR-14</code></td><td>رابط الاستبانة فردي لكل طالب ويُستخدم مرة واحدة.</td></tr>
            <tr><td><code>BR-15</code></td><td>المؤشر غير المنطبق يُستثنى من الوزن بسبب موثّق.</td></tr>
          </tbody>
        </table></div>`)}

      ${chapter('glossary', 'مسرد المصطلحات', 'file', `
        <div class="table-wrap"><table class="compact">
          <thead><tr><th>المصطلح</th><th>معناه في هذا النظام</th></tr></thead>
          <tbody>
            <tr><td><strong>المؤشر</strong></td><td>أصغر وحدة تُقاس، لها وزن بالدرجات وأداة قياس ومالك وموعد.</td></tr>
            <tr><td><strong>مالك المؤشر</strong></td><td>المنصب المسؤول عن قياس هذا المؤشر — وإليه تُسند مهامه تلقائيًا.</td></tr>
            <tr><td><strong>خطة العينة</strong></td><td>كم مرة يُقاس المؤشر وفي أي لقاءات — نسبة مئوية من اللقاءات أو عدد ثابت أو مرة واحدة.</td></tr>
            <tr><td><strong>التحقق</strong></td><td>عملية قياس واحدة مكتملة: بنودها وحالاتها وملاحظاتها ونتيجتها المحسوبة.</td></tr>
            <tr><td><strong>الشاهد</strong></td><td>ملف أو رابط يُثبت ما ادّعاه القياس.</td></tr>
            <tr><td><strong>نتيجة الجودة</strong></td><td>كم أحسنّا فيما قِسناه — على المقيس فقط.</td></tr>
            <tr><td><strong>اكتمال القياس</strong></td><td>كم قِسنا مما كان يجب قياسه.</td></tr>
            <tr><td><strong>الدرجة المعيارية</strong></td><td>الدرجة منسوبة إلى الوزن المنطبق فعلًا، لتكون المقارنة عادلة.</td></tr>
            <tr><td><strong>عينة غير كافية</strong></td><td>استبانة لم تبلغ نسبة استجابتها الحد المعتمد (${fmtNum(rate, 0)}%).</td></tr>
            <tr><td><strong>غير منطبق</strong></td><td>مؤشر لا يخصّ هذا البرنامج، فيُطرح وزنه ولا يُحسب صفرًا.</td></tr>
            <tr><td><strong>مدة المعالجة</strong></td><td>الأيام المعتمدة لإغلاق الشكوى (افتراضيًا ${esc(sla)} أيام)، ويُقاس عليها الالتزام.</td></tr>
            <tr><td><strong>الإجراء التصحيحي</strong></td><td>معالجة موثّقة لإخفاق، لها مالك وموعد وعدّاد تكرار.</td></tr>
            <tr><td><strong>قياس الأثر</strong></td><td>قياس تعلّم الطالب نفسه — مستقل عن مقياس جودة التنفيذ.</td></tr>
          </tbody>
        </table></div>`)}

      <div class="doc-end">
        <p>${esc(org)} — مقياس تشغيلي من ${fmtNum(total, 0)} درجة على كل برنامج.</p>
        <a class="btn" href="/programs-public">${icon('programs', { size: 15 })} تصفّح البرامج ودرجاتها</a>
      </div>

      </div>
    </main>`;

    return html(ctx.res, publicPage({ title: 'النظام', active: '/system', user: ctx.user, body }));
  });
}
