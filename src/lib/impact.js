import { all, get } from '../db/index.js';

/**
 * قياس الأثر التعليمي — وحدة مستقلة تمامًا عن مقياس الـ300.
 *
 * مقياس الجودة يقيس «جودة العملية» (البيئة، المعلم، المحتوى، التجربة).
 * هذه الوحدة تجيب عن سؤال مختلف: **هل تعلّم الطالب فعلًا؟**
 * لذلك لا تدخل نتائجها في الدرجة ولا في اكتمال القياس، وتُعرض في تبويب
 * وتقرير مستقلين حتى لا يختلط قياس الأثر بقياس الجودة.
 */

/** ملخص أداة قياس واحدة (اختبار قبلي/بعدي/تقييم عملي). */
export function toolSummary(toolId) {
  const tool = get('SELECT * FROM impact_tools WHERE id = ?', toolId);
  if (!tool) return null;
  const rows = all('SELECT score FROM impact_results WHERE tool_id = ?', toolId);
  const max = Number(tool.max_score) || 100;
  const pcts = rows.map((r) => (Number(r.score) / max) * 100);
  const eligible = Number(get(
    "SELECT COUNT(*) c FROM students WHERE program_id = ? AND status <> 'withdrawn'",
    tool.program_id,
  )?.c || 0);
  const mastered = pcts.filter((p) => p >= Number(tool.mastery_pct)).length;
  return {
    tool,
    measured: rows.length,
    eligible,
    coverage_pct: eligible ? Math.min(100, (rows.length / eligible) * 100) : null,
    avg_pct: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
    min_pct: pcts.length ? Math.min(...pcts) : null,
    max_pct: pcts.length ? Math.max(...pcts) : null,
    mastery_rate: pcts.length ? (mastered / pcts.length) * 100 : null,
    mastered,
  };
}

/**
 * مكسب التعلم المعياري (normalized gain) = (بعدي − قبلي) ÷ (100 − قبلي).
 * يقيس كم تحقق من التحسن الممكن، لا مجرد فرق المتوسطين، فلا يُظلم
 * البرنامج الذي بدأ طلابه بمستوى مرتفع أصلًا.
 */
export function normalizedGain(prePct, postPct) {
  if (prePct === null || postPct === null) return null;
  if (prePct >= 100) return null;
  return ((postPct - prePct) / (100 - prePct)) * 100;
}

/** الصورة الكاملة لقياس الأثر في برنامج. */
export function programImpact(programId) {
  const tools = all('SELECT * FROM impact_tools WHERE program_id = ? ORDER BY kind, id', programId);
  const summaries = tools.map((t) => toolSummary(t.id)).filter(Boolean);

  const avgOf = (kind) => {
    const list = summaries.filter((s) => s.tool.kind === kind && s.avg_pct !== null);
    if (!list.length) return null;
    return list.reduce((a, b) => a + b.avg_pct, 0) / list.length;
  };

  const pre = avgOf('pre');
  const post = avgOf('post');
  const practical = avgOf('practical');

  // نسبة الإتقان تُؤخذ من الأدوات البعدية والعملية (لا من القبلية)
  const outcomeTools = summaries.filter(
    (s) => s.tool.kind !== 'pre' && s.mastery_rate !== null,
  );
  const masteryRate = outcomeTools.length
    ? outcomeTools.reduce((a, b) => a + b.mastery_rate, 0) / outcomeTools.length
    : null;

  // مقارنة مزدوجة للطلاب الذين لديهم قياس قبلي وبعدي معًا
  const paired = all(
    `SELECT pr.student_id,
            AVG(pr.score / pt.max_score) * 100 AS pre_pct,
            AVG(po.score / ot.max_score) * 100 AS post_pct
       FROM impact_results pr
       JOIN impact_tools pt ON pt.id = pr.tool_id AND pt.kind = 'pre'
       JOIN impact_results po ON po.student_id = pr.student_id
       JOIN impact_tools ot ON ot.id = po.tool_id AND ot.kind = 'post'
      WHERE pt.program_id = ? AND ot.program_id = ?
      GROUP BY pr.student_id`,
    programId, programId,
  );
  const improved = paired.filter((p) => Number(p.post_pct) > Number(p.pre_pct)).length;

  return {
    tools: summaries,
    pre_pct: pre,
    post_pct: post,
    practical_pct: practical,
    delta: pre !== null && post !== null ? post - pre : null,
    normalized_gain: normalizedGain(pre, post),
    mastery_rate: masteryRate,
    paired_count: paired.length,
    improved_count: improved,
    improved_rate: paired.length ? (improved / paired.length) * 100 : null,
    has_data: summaries.some((s) => s.measured > 0),
  };
}

/** درجات طالب واحد عبر كل أدوات القياس (لشاشة الإدخال). */
export function resultsByTool(toolId) {
  return all(
    `SELECT s.id AS student_id, s.full_name, s.status, r.score, r.note
       FROM students s
       LEFT JOIN impact_results r ON r.student_id = s.id AND r.tool_id = ?
      WHERE s.program_id = (SELECT program_id FROM impact_tools WHERE id = ?)
      ORDER BY s.full_name`,
    toolId, toolId,
  );
}
