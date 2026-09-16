import { all, get } from '../db/index.js';
import { computeProgram } from './scoring.js';

/**
 * المعايرة والمقارنة.
 *
 * السؤال الذي تجيب عنه: هل هذا البرنامج أفضل أم أسوأ من معتاد الجمعية،
 * وفي أي مؤشر تحديدًا، وهل نتحسّن عبر الفترات أم نراوح مكاننا؟
 *
 * قاعدة الإنصاف: المقارنة تُبنى على «الدرجة المعيارية من 300» لا على
 * المحقق الخام، حتى لا يُظلم برنامج له مؤشرات غير منطبقة.
 */

/** البرامج التي لها قياسات فعلية (تصلح أساسًا للمقارنة). */
function comparablePrograms(excludeId = null) {
  return all("SELECT * FROM programs WHERE status IN ('active','closing','closed')")
    .filter((p) => p.id !== excludeId)
    .map((p) => ({ p, r: computeProgram(p.id) }))
    .filter((x) => x.r && x.r.measured_weight > 0);
}

/** متوسط الجمعية لكل مؤشر (نسبة مئوية) عبر البرامج التي قاسته. */
export function indicatorBenchmarks(excludeId = null) {
  const map = new Map();
  for (const { r } of comparablePrograms(excludeId)) {
    for (const node of r.sections.flatMap((s) => s.axes).flatMap((a) => a.indicators)) {
      if (node.exempt || !node.has_data || node.score_pct === null) continue;
      const entry = map.get(node.indicator.id) || { sum: 0, n: 0 };
      entry.sum += node.score_pct;
      entry.n += 1;
      map.set(node.indicator.id, entry);
    }
  }
  const out = new Map();
  for (const [id, e] of map) out.set(id, { avg: e.sum / e.n, programs: e.n });
  return out;
}

/**
 * مقارنة برنامج بمتوسط الجمعية:
 * فرق كل قسم، وأقوى المؤشرات وأضعفها مقارنةً بالمعتاد.
 */
export function programBenchmark(programId) {
  const r = computeProgram(programId);
  if (!r) return null;
  const bench = indicatorBenchmarks(programId);
  const peers = comparablePrograms(programId);

  const peerAvgScore = peers.length
    ? peers.reduce((s, x) => s + (x.r.normalized_score ?? 0), 0) / peers.length : null;
  const peerAvgCoverage = peers.length
    ? peers.reduce((s, x) => s + x.r.coverage_pct, 0) / peers.length : null;

  const sections = r.sections.map((s) => {
    const nodes = s.axes.flatMap((a) => a.indicators).filter((n) => !n.exempt && n.has_data);
    const withBench = nodes.filter((n) => bench.has(n.indicator.id));
    const mineWeighted = withBench.reduce((acc, n) => acc + n.score_pct * n.weight, 0);
    const peerWeighted = withBench.reduce((acc, n) => acc + bench.get(n.indicator.id).avg * n.weight, 0);
    const w = withBench.reduce((acc, n) => acc + n.weight, 0);
    return {
      section: s.section,
      mine: w ? mineWeighted / w : null,
      peer: w ? peerWeighted / w : null,
      delta: w ? (mineWeighted - peerWeighted) / w : null,
      compared: withBench.length,
    };
  });

  // المؤشرات الشاذة: أبعد ما يكون عن معتاد الجمعية صعودًا أو هبوطًا
  const gaps = [];
  for (const n of r.sections.flatMap((s) => s.axes).flatMap((a) => a.indicators)) {
    if (n.exempt || !n.has_data || n.score_pct === null) continue;
    const b = bench.get(n.indicator.id);
    if (!b) continue;
    gaps.push({
      indicator: n.indicator,
      mine: n.score_pct,
      peer: b.avg,
      delta: n.score_pct - b.avg,
      weight: n.weight,
      programs: b.programs,
    });
  }
  gaps.sort((a, b) => a.delta - b.delta);

  return {
    result: r,
    peers: peers.length,
    peerAvgScore,
    peerAvgCoverage,
    scoreDelta: peerAvgScore === null || r.normalized_score === null
      ? null : r.normalized_score - peerAvgScore,
    sections,
    weakest: gaps.filter((g) => g.delta < -2).slice(0, 3),
    strongest: gaps.filter((g) => g.delta > 2).slice(-3).reverse(),
  };
}

/** اتجاه الأداء عبر الفترات — هل نتحسّن؟ */
export function termTrend() {
  const rows = all("SELECT * FROM programs WHERE status IN ('active','closing','closed') ORDER BY start_date");
  const byTerm = new Map();
  for (const p of rows) {
    const r = computeProgram(p.id);
    if (!r || r.measured_weight <= 0) continue;
    const key = p.term || 'غير محدد';
    const e = byTerm.get(key) || { term: key, n: 0, score: 0, coverage: 0, first: p.start_date };
    e.n += 1;
    e.score += r.normalized_score ?? 0;
    e.coverage += r.coverage_pct;
    if (!e.first || (p.start_date && p.start_date < e.first)) e.first = p.start_date;
    byTerm.set(key, e);
  }
  const terms = [...byTerm.values()]
    .map((e) => ({ term: e.term, programs: e.n, avgScore: e.score / e.n, avgCoverage: e.coverage / e.n, first: e.first }))
    .sort((a, b) => String(a.first || '').localeCompare(String(b.first || '')));

  return terms.map((t, i) => ({
    ...t,
    delta: i > 0 ? t.avgScore - terms[i - 1].avgScore : null,
  }));
}

/** أضعف المؤشرات على مستوى الجمعية — أين نحتاج تحسينًا مؤسسيًا. */
export function weakestIndicators(limit = 5) {
  const bench = indicatorBenchmarks();
  const rows = [];
  for (const [id, b] of bench) {
    const ind = get('SELECT * FROM indicators WHERE id = ?', id);
    if (!ind) continue;
    rows.push({ indicator: ind, avg: b.avg, programs: b.programs });
  }
  rows.sort((a, b) => a.avg - b.avg);
  return rows.slice(0, limit);
}
