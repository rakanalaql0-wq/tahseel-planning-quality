import { all, get } from '../db/index.js';
import { today, daysBetween, fmtNum } from './util.js';
import { computeProgram, minResponseRate, responseRate } from './scoring.js';
import { programImpact } from './impact.js';

/**
 * محرّك التشخيص والإنذار المبكر.
 *
 * الفرق بين هذا المحرك ومحرك الحساب: `scoring.js` يجيب «كم الدرجة؟»،
 * وهذا يجيب «لماذا، وما أول شيء تفعله، وما الذي سيفوتك إن لم تتحرك الآن».
 *
 * المبدأ الحاكم: كل ملاحظة لها سبب ورقم وإجراء قابل للنقر — لا تنبيه بلا علاج.
 */

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

const finding = (severity, title, detail, { href = null, action = null, impact = 0, kind = '' } = {}) =>
  ({ severity, title, detail, href, action, impact, kind });

/**
 * فرص القياس المتبقية لمؤشر مرتبط بعيّنة من اللقاءات.
 * القياس المرتبط بلقاء مضى لا يمكن تداركه — وهذا جوهر الإنذار المبكر.
 */
function sampleOpportunities(programId, indicatorId) {
  const now = today();
  const rows = all(
    `SELECT t.id, t.status, s.session_date, s.seq
       FROM tasks t LEFT JOIN sessions s ON s.id = t.session_id
      WHERE t.program_id = ? AND t.indicator_id = ? AND t.status = 'pending'`,
    programId, indicatorId,
  );
  const missed = rows.filter((r) => r.session_date && r.session_date < now);
  const upcoming = rows.filter((r) => !r.session_date || r.session_date >= now);
  return { missed, upcoming, pending: rows.length };
}

/** تشخيص كامل لبرنامج: ما الذي يهدد درجته، ولماذا، وما الإجراء. */
export function programDiagnostics(programId) {
  const program = get('SELECT * FROM programs WHERE id = ?', programId);
  if (!program) return { findings: [], lost: 0, pending: 0, health: 'unknown' };

  const result = computeProgram(programId);
  const nodes = result.sections.flatMap((s) => s.axes).flatMap((a) => a.indicators);
  const findings = [];
  const now = today();
  const daysLeft = program.end_date ? daysBetween(now, program.end_date) : null;

  // ---------- 1. فرص قياس ضاعت أو ستضيع (الإنذار المبكر) ----------
  for (const n of nodes) {
    if (n.exempt || n.indicator.periodicity !== 'per_session_sample') continue;
    const need = n.required - n.completed;
    if (need <= 0) continue;
    const { missed, upcoming } = sampleOpportunities(programId, n.indicator.id);

    if (upcoming.length < need) {
      findings.push(finding(
        'critical',
        `لن تكتمل عينة «${n.indicator.name}»`,
        `تحتاج ${need} قياسًا ولم يتبقَّ إلا ${upcoming.length} لقاءً قابلًا للقياس`
        + `${missed.length ? ` (فاتت ${missed.length} فرصة على لقاءات مضت)` : ''}. `
        + `أضف لقاءات أو عدّل خطة العينة قبل الإقفال — وإلا ضاعت ${fmtNum(n.weight)} درجة.`,
        {
          href: `/programs/${programId}/sessions`,
          action: 'مراجعة اللقاءات',
          impact: n.weight,
          kind: 'sample_impossible',
        },
      ));
    } else if (missed.length) {
      findings.push(finding(
        'warning',
        `فاتت ${missed.length} فرصة قياس لـ«${n.indicator.name}»`,
        `لقاءات مضت دون تنفيذ القياس المجدول عليها. المتبقي ${upcoming.length} فرصة لـ${need} قياسًا مطلوبًا — الهامش ضيّق.`,
        {
          href: `/programs/${programId}/indicator/${n.indicator.id}`,
          action: 'سجل المؤشر',
          impact: n.weight * 0.5,
          kind: 'sample_missed',
        },
      ));
    }
  }

  // ---------- 2. قياسات لم تبدأ والوقت ينفد ----------
  if (daysLeft !== null && daysLeft <= 14 && daysLeft >= 0) {
    const notStarted = nodes.filter((n) => !n.exempt && n.completed === 0 && n.required > 0);
    const weightAtRisk = notStarted.reduce((s, n) => s + n.weight, 0);
    if (notStarted.length) {
      findings.push(finding(
        daysLeft <= 7 ? 'critical' : 'warning',
        `${notStarted.length} مؤشرًا لم يبدأ قياسه ولم يتبقَّ إلا ${daysLeft} يومًا`,
        `${fmtNum(weightAtRisk)} درجة معرّضة للضياع. ابدأ بالمؤشرات الأعلى وزنًا: `
        + notStarted.sort((a, b) => b.weight - a.weight).slice(0, 3)
          .map((n) => `${n.indicator.name} (${fmtNum(n.weight)})`).join('، '),
        {
          href: `/programs/${programId}/metric`,
          action: 'شجرة المقياس',
          impact: weightAtRisk,
          kind: 'time_pressure',
        },
      ));
    }
  }

  // ---------- 3. أكبر أسباب فقد الدرجة ----------
  const losses = nodes
    .filter((n) => !n.exempt && n.has_data && n.score_pct !== null && n.score_pct < 100)
    .map((n) => ({ n, lost: n.weight * (1 - n.score_pct / 100) }))
    .filter((x) => x.lost >= 0.5)
    .sort((a, b) => b.lost - a.lost);

  for (const { n, lost } of losses.slice(0, 3)) {
    const worst = all(
      `SELECT ci.text, COUNT(*) AS times FROM verification_items vi
         JOIN verifications v ON v.id = vi.verification_id
         JOIN checklist_items ci ON ci.id = vi.checklist_item_id
        WHERE v.program_id = ? AND v.indicator_id = ? AND v.status = 'submitted' AND vi.state < 100
        GROUP BY ci.id ORDER BY times DESC, MIN(vi.state) LIMIT 2`,
      programId, n.indicator.id,
    );
    findings.push(finding(
      lost >= 8 ? 'warning' : 'info',
      `فقدت ${fmtNum(lost)} درجة في «${n.indicator.name}»`,
      `النتيجة ${fmtNum(n.score_pct)}% من ${fmtNum(n.weight)} درجة.`
      + (worst.length ? ` أكثر العناصر إخفاقًا: ${worst.map((w) => `${w.text} (${w.times}×)`).join('، ')}` : ''),
      {
        href: n.indicator.tool === 'checklist'
          ? `/programs/${programId}/indicator/${n.indicator.id}`
          : `/programs/${programId}/surveys`,
        action: 'التفاصيل',
        impact: lost,
        kind: 'score_loss',
      },
    ));
  }

  // ---------- 4. استبانات دون حد الاستجابة ----------
  const threshold = minResponseRate();
  const openSurveys = all(
    "SELECT * FROM surveys WHERE program_id = ? AND status = 'open'", programId,
  );
  for (const s of openSurveys) {
    const responses = Number(get('SELECT COUNT(*) c FROM survey_responses WHERE survey_id = ?', s.id)?.c || 0);
    const rate = responseRate(s, responses);
    if (rate === null || rate >= threshold) continue;
    const target = Number(s.target_count || 0);
    const needed = Math.max(0, Math.ceil((threshold / 100) * target) - responses);
    findings.push(finding(
      daysLeft !== null && daysLeft <= 7 ? 'critical' : 'warning',
      `«${s.title}» لن تُحتسب — العينة غير كافية`,
      `الاستجابة ${fmtNum(rate)}% والمطلوب ${fmtNum(threshold)}%. تحتاج ${needed} استجابة إضافية. `
      + 'تابع الطلاب الذين لم يجيبوا من جدول الروابط.',
      { href: `/surveys/${s.id}`, action: 'متابعة الاستجابات', impact: 5, kind: 'survey_gap' },
    ));
  }

  // ---------- 5. استبانات مجدولة لم تُنشأ وقد فات موعدها ----------
  const lateSurveyTasks = all(
    `SELECT t.*, i.name AS indicator_name FROM tasks t JOIN indicators i ON i.id = t.indicator_id
      WHERE t.program_id = ? AND t.kind = 'survey' AND t.status = 'pending' AND t.due_date < ?
        AND NOT EXISTS (SELECT 1 FROM surveys s WHERE s.task_id = t.id)`,
    programId, now,
  );
  if (lateSurveyTasks.length) {
    findings.push(finding(
      'warning',
      `${lateSurveyTasks.length} استبانة فات موعدها ولم تُنشأ`,
      lateSurveyTasks.map((t) => t.indicator_name).slice(0, 3).join('، ')
      + ' — كلما تأخر التوزيع ضعفت الاستجابة.',
      { href: `/programs/${programId}/surveys`, action: 'توليد الاستبانات', impact: 6, kind: 'survey_late' },
    ));
  }

  // ---------- 6. شكاوى تجاوزت المدة المعتمدة ----------
  const lateComplaints = all(
    "SELECT * FROM complaints WHERE program_id = ? AND status <> 'closed' AND due_date < ?",
    programId, now,
  );
  if (lateComplaints.length) {
    findings.push(finding(
      'critical',
      `${lateComplaints.length} شكوى تجاوزت المدة المعتمدة`,
      'كل شكوى متجاوزة تخصم من مؤشر معالجة الشكاوى (15 درجة) وتمنع الإقفال.',
      { href: `/programs/${programId}/complaints`, action: 'معالجة الشكاوى', impact: 15, kind: 'complaint_sla' },
    ));
  }

  // ---------- 7. إجراءات تصحيحية متأخرة ----------
  const lateActions = all(
    "SELECT * FROM corrective_actions WHERE program_id = ? AND status IN ('open','in_progress') AND due_date < ?",
    programId, now,
  );
  if (lateActions.length) {
    findings.push(finding(
      'warning',
      `${lateActions.length} إجراءً تصحيحيًا تجاوز موعده`,
      'الإجراء المتأخر يعني أن سبب الإخفاق ما زال قائمًا وسيتكرر في القياس القادم.',
      { href: `/programs/${programId}/actions`, action: 'لوحة الإجراءات', impact: 4, kind: 'action_late' },
    ));
  }

  // ---------- 8. مشكلات تكررت بعد إغلاق إجراءاتها ----------
  const recurring = all(
    "SELECT title, occurrence_count FROM corrective_actions WHERE program_id = ? AND recurred = 1",
    programId,
  );
  if (recurring.length) {
    findings.push(finding(
      'critical',
      `${recurring.length} مشكلة تكررت بعد إغلاق إجراءها`,
      `${recurring.slice(0, 2).map((r) => r.title).join('، ')} — الإجراء السابق لم يعالج السبب الجذري.`,
      { href: `/programs/${programId}/actions`, action: 'مراجعة الإجراءات', impact: 6, kind: 'recurrence' },
    ));
  }

  // ---------- 9. قياس الأثر ----------
  if (program.status !== 'draft') {
    const im = programImpact(programId);
    if (!im.has_data && daysLeft !== null && daysLeft <= 21) {
      findings.push(finding(
        'info',
        'لا يوجد قياس أثر لهذا البرنامج',
        'بلا اختبار قبلي وبعدي لن تعرف ما تعلّمه الطالب فعلًا — والقياس القبلي يفوت بعد بدء البرنامج.',
        { href: `/programs/${programId}/impact`, action: 'إضافة أداة قياس', impact: 0, kind: 'impact_missing' },
      ));
    } else if (im.has_data) {
      const post = im.tools.find((t) => t.tool.kind === 'post');
      if (post && post.coverage_pct !== null && post.coverage_pct < 70) {
        findings.push(finding(
          'info',
          `تغطية القياس البعدي ${fmtNum(post.coverage_pct)}% فقط`,
          `قيس ${post.measured} من ${post.eligible} طالبًا — النتيجة لا تمثّل الجميع.`,
          { href: `/impact/tool/${post.tool.id}`, action: 'إدخال الدرجات', impact: 0, kind: 'impact_coverage' },
        ));
      }
    }
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.impact - a.impact);

  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warning = findings.filter((f) => f.severity === 'warning').length;
  const health = critical ? 'critical' : warning ? 'warning' : 'good';

  return {
    program,
    result,
    findings,
    critical,
    warning,
    health,
    lost: losses.reduce((s, x) => s + x.lost, 0),
    pendingWeight: nodes.filter((n) => !n.exempt && !n.has_data).reduce((s, n) => s + n.weight, 0),
  };
}

/** تسمية صحة البرنامج. */
export const healthLabel = (h) => ({
  critical: 'يحتاج تدخلًا عاجلًا',
  warning: 'يحتاج متابعة',
  good: 'على المسار',
  unknown: '—',
}[h] || h);

/**
 * ترتيب مهام المستخدم بالأولوية الحقيقية لا بالتاريخ وحده.
 *
 * وزن الأولوية = التأخر + وزن المؤشر في المقياس + ندرة الفرصة المتبقية.
 * المهمة المرتبطة بلقاء يقترب موعده تُقدَّم، لأن فرصتها تنتهي بانتهاء اللقاء.
 */
export function prioritizedTasks(userId, { limit = 50 } = {}) {
  const now = today();
  const rows = all(
    `SELECT t.*, p.name AS program_name, p.end_date AS program_end,
            i.name AS indicator_name, i.tool, i.weight AS indicator_weight, i.periodicity,
            s.seq AS session_seq, s.session_date
       FROM tasks t
       JOIN programs p ON p.id = t.program_id
       LEFT JOIN indicators i ON i.id = t.indicator_id
       LEFT JOIN sessions s ON s.id = t.session_id
      WHERE t.assigned_user_id = ? AND t.status = 'pending' AND p.status <> 'closed'`,
    userId,
  );

  const scored = rows.map((t) => {
    const weight = Number(t.indicator_weight || 0);
    const overdue = t.due_date && t.due_date < now ? daysBetween(t.due_date, now) : 0;
    const untilDue = t.due_date && t.due_date >= now ? daysBetween(now, t.due_date) : null;

    let score = 0;
    const reasons = [];

    if (overdue > 0) {
      score += 40 + Math.min(overdue, 30) * 2;
      reasons.push(`متأخرة ${overdue} يومًا`);
    } else if (untilDue !== null && untilDue <= 2) {
      score += 30;
      reasons.push(untilDue === 0 ? 'تستحق اليوم' : `تستحق خلال ${untilDue} يومًا`);
    } else if (untilDue !== null && untilDue <= 7) {
      score += 14;
    }

    // وزن المؤشر: مهمة تحمل 30 درجة أهم من مهمة تحمل 5
    score += weight * 1.2;
    if (weight >= 20) reasons.push(`مؤشر عالي الوزن (${fmtNum(weight)} درجة)`);

    // فرصة تنتهي: مهمة مرتبطة بلقاء
    if (t.session_date) {
      if (t.session_date < now) {
        score += 55;
        reasons.push('فرصتها فاتت — اللقاء انتهى');
      } else if (daysBetween(now, t.session_date) <= 1) {
        score += 45;
        reasons.push('اللقاء غدًا أو اليوم — الفرصة لا تتكرر');
      }
    }

    // نهاية البرنامج تقترب
    if (t.program_end) {
      const left = daysBetween(now, t.program_end);
      if (left >= 0 && left <= 7) { score += 20; reasons.push(`البرنامج ينتهي خلال ${left} أيام`); }
    }

    return { ...t, priority: Math.round(score), reasons };
  });

  scored.sort((a, b) => b.priority - a.priority);
  return scored.slice(0, limit);
}

/** نظرة الجمعية: البرامج المهدَّدة أولًا (لمدير التخطيط والجودة). */
export function portfolioHealth(programs) {
  return programs
    .filter((p) => p.status !== 'closed')
    .map((p) => {
      const d = programDiagnostics(p.id);
      return {
        program: p,
        health: d.health,
        critical: d.critical,
        warning: d.warning,
        top: d.findings[0] || null,
        score: d.result?.earned ?? 0,
        coverage: d.result?.coverage_pct ?? 0,
      };
    })
    .sort((a, b) => SEVERITY_RANK[a.health] - SEVERITY_RANK[b.health] || b.critical - a.critical);
}
