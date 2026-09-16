import { all, get } from '../db/index.js';
import { DEFAULT_MIN_RESPONSE_RATE } from '../db/framework.js';

/**
 * محرك الحساب — البند 6 (قواعد الأعمال) من وثيقة التحليل.
 *
 *  BR-01  إجمالي المقياس 300 درجة: 75 + 135 + 90.
 *  BR-02  قائمة التحقق: متحقق 100%، جزئي 50%، غير متحقق 0%.
 *  BR-03  الاستبانة: (المتوسط - 1) ÷ 4 × 100.
 *  BR-05  تهيئة القاعات: عينة لا تقل عن 50% من اللقاءات.
 *  BR-06  الضيافة: عينة لا تقل عن 25% من اللقاءات وبحد أدنى مرتين.
 *  BR-07  التجهيزات: تحقق مرتان على الأقل.
 *  BR-10  استمرارية الطلاب: 5 درجات نية الاستمرار + 15 الاستمرار الفعلي.
 *  BR-11  يُعرض «اكتمال القياس» مستقلاً عن «نتيجة الجودة».
 */

/** تحويل متوسط ليكرت (1..5) إلى نسبة مئوية — BR-03. */
export function likertToPct(avg) {
  if (avg === null || avg === undefined || Number.isNaN(Number(avg))) return null;
  const pct = ((Number(avg) - 1) / 4) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** عدد القياسات المطلوبة لمؤشر داخل برنامج (خطة العينة). */
export function requiredCount(indicator, program, ctx = {}) {
  const sessions = ctx.sessionCount ?? program.planned_sessions ?? 0;
  const mains = ctx.mainActivityCount ?? 0;
  switch (indicator.periodicity) {
    case 'before_start':
    case 'mid':
    case 'end':
    case 'continuous':
      return 1;
    case 'mid_end':
      return 2;
    case 'per_session_sample': {
      const bySample = Math.ceil((sessions * (indicator.sample_pct ?? 0)) / 100);
      return Math.max(1, bySample, indicator.min_count ?? 0);
    }
    case 'fixed_count':
      return Math.max(1, indicator.min_count ?? 1);
    case 'per_main_activity':
      return Math.max(1, mains);
    default:
      return 1;
  }
}

/** وصف خطة العينة بصيغة مقروءة. */
export function samplePlanLabel(indicator) {
  switch (indicator.periodicity) {
    case 'before_start': return 'مرة واحدة قبل بدء البرنامج';
    case 'mid': return 'مرة واحدة في منتصف البرنامج';
    case 'end': return 'مرة واحدة في نهاية البرنامج';
    case 'mid_end': return 'مرتان: منتصف البرنامج ونهايته';
    case 'continuous': return 'سجل تشغيلي مستمر';
    case 'per_main_activity': return 'بعد كل نشاط رئيس';
    case 'fixed_count': return `${indicator.min_count ?? 1} مرات على الأقل`;
    case 'per_session_sample': {
      const parts = [];
      if (indicator.sample_pct) parts.push(`عينة لا تقل عن ${indicator.sample_pct}% من اللقاءات`);
      if (indicator.min_count) parts.push(`وبحد أدنى ${indicator.min_count} مرات`);
      return parts.join(' ') || 'عينة من اللقاءات';
    }
    default: return '—';
  }
}

/** نتيجة مؤشر قائمة تحقق: متوسط نسب التحقق المعتمدة. */
function checklistResult(programId, indicatorId) {
  const rows = all(
    `SELECT score_pct FROM verifications
      WHERE program_id = ? AND indicator_id = ? AND status = 'submitted' AND score_pct IS NOT NULL`,
    programId, indicatorId,
  );
  if (!rows.length) return { pct: null, done: 0 };
  const sum = rows.reduce((acc, r) => acc + Number(r.score_pct), 0);
  return { pct: sum / rows.length, done: rows.length };
}

/** الحد الأدنى المعتمد لنسبة الاستجابة في الاستبانات. */
export function minResponseRate() {
  const row = get("SELECT value FROM settings WHERE key = 'min_response_rate'");
  const v = Number(row?.value);
  return Number.isFinite(v) && v > 0 && v <= 100 ? v : DEFAULT_MIN_RESPONSE_RATE;
}

/** نسبة استجابة استبانة واحدة مقابل عدد المستهدفين وقت الفتح. */
export function responseRate(survey, responses) {
  const target = Number(survey.target_count || 0);
  if (!target) return null;
  return Math.min(100, (Number(responses) / target) * 100);
}

/**
 * نتيجة مؤشر استبانة: BR-03 مطبقة على متوسط أسئلة المؤشر.
 * الاستبانة التي تقل نسبة استجابتها عن الحد المعتمد تُوسم «عينة غير كافية»:
 * تظهر نتيجتها للاطلاع، لكنها لا تُحتسب ضمن اكتمال القياس.
 */
function surveyResult(programId, indicatorId) {
  const rows = all(
    `SELECT s.id AS survey_id, s.title, s.target_count,
            AVG(a.value) AS avg_value, COUNT(a.id) AS answers,
            (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS responses
       FROM surveys s
       JOIN survey_questions q ON q.survey_id = s.id AND q.indicator_id = ?
       JOIN survey_answers a ON a.question_id = q.id
      WHERE s.program_id = ?
      GROUP BY s.id`,
    indicatorId, programId,
  );
  if (!rows.length) return { pct: null, done: 0, responses: 0, insufficient: [] };

  const threshold = minResponseRate();
  const scored = [];
  const insufficient = [];
  let responses = 0;
  for (const r of rows) {
    const pct = likertToPct(r.avg_value);
    if (pct === null) continue;
    responses += Number(r.responses);
    const rate = responseRate(r, r.responses);
    const enough = rate !== null && rate >= threshold;
    scored.push({ pct, enough });
    if (!enough) insufficient.push({ title: r.title, rate, responses: Number(r.responses), target: Number(r.target_count || 0) });
  }
  if (!scored.length) return { pct: null, done: 0, responses: 0, insufficient };

  return {
    pct: scored.reduce((a, b) => a + b.pct, 0) / scored.length,
    done: scored.filter((s) => s.enough).length, // الاكتمال يحتسب العينات الكافية فقط
    responses,
    insufficient,
  };
}

/** نتيجة مؤشر سجل تشغيلي بحسب قاعدة الحساب المعرّفة. */
function recordResult(programId, indicator, program) {
  switch (indicator.record_rule) {
    case 'attendance_rate': {
      const r = get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN at.state IN ('present','excused','late') THEN 1 ELSE 0 END) AS ok
           FROM attendance at JOIN sessions s ON s.id = at.session_id
          WHERE s.program_id = ?`,
        programId,
      );
      if (!r || !r.total) return { pct: null, done: 0 };
      return { pct: (Number(r.ok) / Number(r.total)) * 100, done: 1 };
    }
    case 'discipline_documented': {
      const r = get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN action IS NOT NULL AND trim(action) <> '' THEN 1 ELSE 0 END) AS documented
           FROM discipline_cases WHERE program_id = ?`,
        programId,
      );
      if (!r) return { pct: null, done: 0 };
      // لا حالات متعثرة = التزام كامل، بشرط وجود سجل حضور يثبت المتابعة.
      if (!Number(r.total)) {
        const att = get(
          'SELECT COUNT(*) AS c FROM attendance at JOIN sessions s ON s.id = at.session_id WHERE s.program_id = ?',
          programId,
        );
        return Number(att?.c) ? { pct: 100, done: 1 } : { pct: null, done: 0 };
      }
      return { pct: (Number(r.documented) / Number(r.total)) * 100, done: 1 };
    }
    case 'followup_sessions': {
      const r = get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN followup_at IS NOT NULL AND trim(followup_at) <> '' THEN 1 ELSE 0 END) AS held
           FROM discipline_cases WHERE program_id = ?`,
        programId,
      );
      if (!r) return { pct: null, done: 0 };
      // لا حالات تستدعي جلسة متابعة = التزام كامل، بشرط وجود سجل حضور يثبت المتابعة.
      if (!Number(r.total)) {
        const att = get(
          'SELECT COUNT(*) AS c FROM attendance at JOIN sessions s ON s.id = at.session_id WHERE s.program_id = ?',
          programId,
        );
        return Number(att?.c) ? { pct: 100, done: 1 } : { pct: null, done: 0 };
      }
      return { pct: (Number(r.held) / Number(r.total)) * 100, done: 1 };
    }
    case 'complaint_sla': {
      const r = get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'closed' AND (due_date IS NULL OR date(closed_at) <= date(due_date)) THEN 1 ELSE 0 END) AS on_time
           FROM complaints WHERE program_id = ?`,
        programId,
      );
      if (!r) return { pct: null, done: 0 };
      if (!Number(r.total)) return { pct: 100, done: 1 }; // لا شكاوى = لا تجاوز للمدة المعتمدة
      return { pct: (Number(r.on_time) / Number(r.total)) * 100, done: 1 };
    }
    case 'continuity_intent': {
      const r = get(
        `SELECT COUNT(*) AS asked, SUM(CASE WHEN intent_continue = 1 THEN 1 ELSE 0 END) AS yes
           FROM students WHERE program_id = ? AND intent_continue IS NOT NULL`,
        programId,
      );
      if (!r || !Number(r.asked)) return { pct: null, done: 0 };
      return { pct: (Number(r.yes) / Number(r.asked)) * 100, done: 1 };
    }
    case 'continuity_actual': {
      const r = get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status <> 'withdrawn' THEN 1 ELSE 0 END) AS stayed
           FROM students WHERE program_id = ?`,
        programId,
      );
      const start = Math.max(Number(r?.total || 0), Number(program.planned_students || 0));
      if (!start) return { pct: null, done: 0 };
      if (!Number(r?.total)) return { pct: null, done: 0 };
      return { pct: (Number(r.stayed) / start) * 100, done: 1 };
    }
    default:
      return { pct: null, done: 0 };
  }
}

/** استثناءات «غير منطبق» لبرنامج معيّن: معرّف المؤشر ← السبب. */
export function exemptionsFor(programId) {
  return new Map(all(
    `SELECT e.indicator_id, e.reason, e.created_at, u.full_name AS by_name
       FROM indicator_exemptions e LEFT JOIN users u ON u.id = e.created_by
      WHERE e.program_id = ?`,
    programId,
  ).map((e) => [e.indicator_id, e]));
}

export const isExempt = (programId, indicatorId) => Boolean(get(
  'SELECT 1 FROM indicator_exemptions WHERE program_id = ? AND indicator_id = ?',
  programId, indicatorId,
));

/** يحسب نتيجة مؤشر واحد داخل برنامج. */
export function computeIndicator(program, indicator, ctx, exemption = null) {
  // مؤشر «غير منطبق»: وزنه يخرج من المقياس ومن اكتمال القياس تمامًا.
  if (exemption) {
    return {
      indicator,
      exempt: true,
      exemption,
      required: 0,
      completed: 0,
      coverage_pct: null,
      score_pct: null,
      has_data: false,
      earned: 0,
      weight: Number(indicator.weight),      // الوزن المعلن (للعرض فقط)
      effective_weight: 0,                   // لا يدخل في أي حساب
      sample_label: samplePlanLabel(indicator),
      responses: null,
      insufficient: [],
    };
  }

  const required = requiredCount(indicator, program, ctx);
  let res;
  if (indicator.tool === 'checklist') res = checklistResult(program.id, indicator.id);
  else if (indicator.tool === 'survey') res = surveyResult(program.id, indicator.id);
  else res = recordResult(program.id, indicator, program);

  const done = Math.min(res.done, required);
  const coverage = required > 0 ? (done / required) * 100 : 0;
  const hasData = res.pct !== null;
  return {
    indicator,
    required,
    completed: res.done,
    coverage_pct: Math.min(100, coverage),
    score_pct: res.pct,
    has_data: hasData,
    exempt: false,
    exemption: null,
    earned: hasData ? (Number(indicator.weight) * res.pct) / 100 : 0,
    weight: Number(indicator.weight),
    effective_weight: Number(indicator.weight),
    sample_label: samplePlanLabel(indicator),
    responses: res.responses ?? null,
    insufficient: res.insufficient ?? [],
  };
}

/** سياق البرنامج المشترك بين كل المؤشرات (لتفادي تكرار الاستعلامات). */
export function programContext(programId) {
  const sessionCount = Number(get('SELECT COUNT(*) AS c FROM sessions WHERE program_id = ?', programId)?.c || 0);
  const mainActivityCount = Number(get(
    "SELECT COUNT(*) AS c FROM activities WHERE program_id = ? AND is_main = 1 AND status <> 'cancelled'",
    programId,
  )?.c || 0);
  return { sessionCount, mainActivityCount };
}

/** الشجرة الكاملة للنتيجة: أقسام ← محاور ← مؤشرات، مع الإجماليات. */
export function computeProgram(programId) {
  const program = get('SELECT * FROM programs WHERE id = ?', programId);
  if (!program) return null;
  const ctx = programContext(programId);

  const sections = all('SELECT * FROM metric_sections ORDER BY sort, id');
  const axes = all('SELECT * FROM metric_axes ORDER BY sort, id');
  const indicators = all('SELECT * FROM indicators WHERE is_active = 1 ORDER BY sort, id');
  const exemptions = exemptionsFor(programId);

  let totalEarned = 0;
  let totalWeight = 0;      // الوزن المنطبق (بعد استبعاد «غير منطبق»)
  let declaredWeight = 0;   // الوزن المعلن الكامل (300)
  let exemptWeight = 0;
  let measuredWeight = 0;
  let coverageWeighted = 0;

  const sectionNodes = sections.map((section) => {
    const axisNodes = axes.filter((a) => a.section_id === section.id).map((axis) => {
      const indNodes = indicators
        .filter((i) => i.axis_id === axis.id)
        .map((i) => computeIndicator(program, i, ctx, exemptions.get(i.id) || null));
      const aWeight = indNodes.reduce((s, n) => s + n.effective_weight, 0);
      const aDeclared = indNodes.reduce((s, n) => s + n.weight, 0);
      const aEarned = indNodes.reduce((s, n) => s + n.earned, 0);
      const aMeasured = indNodes.filter((n) => n.has_data).reduce((s, n) => s + n.effective_weight, 0);
      const aCoverage = aWeight
        ? indNodes.reduce((s, n) => s + ((n.coverage_pct ?? 0) * n.effective_weight), 0) / aWeight
        : null;
      return {
        axis,
        indicators: indNodes,
        weight: aWeight,
        declared_weight: aDeclared,
        exempt_weight: aDeclared - aWeight,
        earned: aEarned,
        measured_weight: aMeasured,
        coverage_pct: aCoverage,
        score_pct: aMeasured ? (aEarned / aMeasured) * 100 : null,
      };
    });
    const sWeight = axisNodes.reduce((s, n) => s + n.weight, 0);
    const sDeclared = axisNodes.reduce((s, n) => s + n.declared_weight, 0);
    const sEarned = axisNodes.reduce((s, n) => s + n.earned, 0);
    const sMeasured = axisNodes.reduce((s, n) => s + n.measured_weight, 0);
    const sCoverage = sWeight
      ? axisNodes.reduce((s, n) => s + ((n.coverage_pct ?? 0) * n.weight), 0) / sWeight
      : null;

    totalEarned += sEarned;
    totalWeight += sWeight;
    declaredWeight += sDeclared;
    exemptWeight += sDeclared - sWeight;
    measuredWeight += sMeasured;
    coverageWeighted += (sCoverage ?? 0) * sWeight;

    return {
      section,
      axes: axisNodes,
      weight: sWeight,
      declared_weight: sDeclared,
      exempt_weight: sDeclared - sWeight,
      earned: sEarned,
      measured_weight: sMeasured,
      coverage_pct: sCoverage,
      score_pct: sMeasured ? (sEarned / sMeasured) * 100 : null,
    };
  });

  return {
    program,
    ctx,
    sections: sectionNodes,
    exemptions: [...exemptions.values()],
    total_weight: totalWeight,               // الوزن المنطبق على هذا البرنامج
    declared_weight: declaredWeight,         // 300 — BR-01
    exempt_weight: exemptWeight,             // ما استُثني بقاعدة «غير منطبق»
    earned: totalEarned,                     // الدرجة المحققة من الوزن المنطبق
    measured_weight: measuredWeight,
    // نتيجة الجودة على ما تم قياسه فعلًا — منفصلة عن الاكتمال (BR-11)
    quality_pct: measuredWeight ? (totalEarned / measuredWeight) * 100 : null,
    coverage_pct: totalWeight ? coverageWeighted / totalWeight : 0,
    // الدرجة المعيارية من 300 لمقارنة البرامج مهما اختلفت استثناءاتها
    normalized_score: totalWeight ? (totalEarned / totalWeight) * declaredWeight : null,
  };
}

/** المؤشرات ناقصة القياس — تمنع الإقفال حتى تُعرض بوضوح. */
export function missingMeasurements(programId) {
  const result = computeProgram(programId);
  if (!result) return [];
  const gaps = [];
  for (const s of result.sections) {
    for (const a of s.axes) {
      for (const n of a.indicators) {
        if (n.exempt) continue; // «غير منطبق» لا يُعد قياسًا ناقصًا
        if (n.completed < n.required) {
          gaps.push({
            section: s.section.name,
            axis: a.axis.name,
            indicator: n.indicator,
            required: n.required,
            completed: n.completed,
            sample_label: n.sample_label,
          });
        }
      }
    }
  }
  return gaps;
}

/** العناصر غير المتحققة أو الجزئية — مصدر الإجراءات التصحيحية. */
export function notMetItems(programId) {
  return all(
    `SELECT vi.id, vi.state, vi.note, ci.text AS item_text, i.name AS indicator_name,
            i.id AS indicator_id, v.id AS verification_id, v.completed_at, v.session_id
       FROM verification_items vi
       JOIN verifications v ON v.id = vi.verification_id
       JOIN checklist_items ci ON ci.id = vi.checklist_item_id
       JOIN indicators i ON i.id = v.indicator_id
      WHERE v.program_id = ? AND v.status = 'submitted' AND vi.state < 100
      ORDER BY vi.state ASC, v.completed_at DESC`,
    programId,
  );
}
