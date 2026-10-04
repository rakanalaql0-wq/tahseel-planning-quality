import { writeFileSync } from 'node:fs';
import { all } from '../src/db/index.js';
import { roleName } from '../src/lib/roles.js';
import { samplePlanLabel } from '../src/lib/scoring.js';

/** يستخرج بنية المقياس كما تُعرض في شاشة «بنية المقياس» إلى JSON. */
const TOOL = { checklist: 'قائمة تحقق', survey: 'استبانة', record: 'سجل تشغيلي' };
const POINT = { mid: 'منتصف البرنامج', end: 'نهاية البرنامج', activity: 'بعد النشاط الرئيس' };
const RULE = {
  attendance_rate: 'نسبة الحضور من سجل الحضور',
  discipline_documented: 'توثيق معالجة الحالات المتعثرة',
  followup_sessions: 'عقد جلسات المتابعة للحالات',
  complaint_sla: 'إغلاق الشكاوى ضمن المدة المعتمدة',
  continuity_intent: 'نية الاستمرار المعلنة من الطلاب',
  continuity_actual: 'الاستمرار الفعلي حتى النهاية',
};

const secs = all('SELECT * FROM metric_sections ORDER BY sort, id');
const axes = all('SELECT * FROM metric_axes ORDER BY sort, id');
const inds = all('SELECT * FROM indicators WHERE is_active = 1 ORDER BY sort, id');
const items = all('SELECT * FROM checklist_items ORDER BY indicator_id, sort, id');
const qs = all('SELECT * FROM question_bank WHERE indicator_id IS NOT NULL ORDER BY indicator_id, sort, id');

const axOf = (id) => axes.find((a) => a.id === id);
const secOf = (axisId) => secs.find((s) => s.id === axOf(axisId)?.section_id);

const indicators = inds.map((i) => ({
  id: i.id,
  code: i.code,
  name: i.name,
  section: secOf(i.axis_id)?.name || '',
  section_code: secOf(i.axis_id)?.code || '',
  axis: axOf(i.axis_id)?.name || '',
  axis_code: axOf(i.axis_id)?.code || '',
  tool: TOOL[i.tool] || i.tool,
  tool_key: i.tool,
  owner: roleName(i.owner_role),
  plan: samplePlanLabel(i),
  periodicity: i.periodicity,
  sample_pct: i.sample_pct,
  min_count: i.min_count,
  weight: i.weight,
  rule: RULE[i.record_rule] || '',
  description: i.description || '',
  items: items.filter((c) => c.indicator_id === i.id).length,
  questions: qs.filter((q) => q.indicator_id === i.id).length,
}));

const byInd = (id) => indicators.find((x) => x.id === id) || {};

writeFileSync(process.argv[2], JSON.stringify({
  sections: secs.map((s) => {
    const sa = axes.filter((a) => a.section_id === s.id);
    const si = indicators.filter((i) => sa.some((a) => a.code === i.axis_code));
    return {
      code: s.code,
      name: s.name,
      declared: s.weight,
      computed: si.reduce((x, i) => x + i.weight, 0),
      axes: sa.length,
      indicators: si.length,
    };
  }),
  axesList: axes.map((a) => {
    const ai = indicators.filter((i) => i.axis_code === a.code);
    return {
      code: a.code,
      name: a.name,
      section: secs.find((s) => s.id === a.section_id)?.name || '',
      declared: a.weight,
      computed: ai.reduce((x, i) => x + i.weight, 0),
      indicators: ai.length,
    };
  }),
  indicators,
  items: items.map((c) => ({
    indicator_code: byInd(c.indicator_id).code || '',
    indicator: byInd(c.indicator_id).name || '',
    section: byInd(c.indicator_id).section || '',
    axis: byInd(c.indicator_id).axis || '',
    code: c.code,
    text: c.text,
    weight: c.weight,
    active: c.is_active ? 'مفعّل' : 'معطّل',
  })),
  questions: qs.map((q) => ({
    indicator_code: byInd(q.indicator_id).code || '',
    indicator: byInd(q.indicator_id).name || '',
    section: byInd(q.indicator_id).section || '',
    axis: byInd(q.indicator_id).axis || '',
    code: q.code,
    text: q.text,
    point: POINT[q.point] || q.point,
  })),
}, null, 1));

console.log('أقسام:', secs.length, '| محاور:', axes.length, '| مؤشرات:', indicators.length,
  '| بنود:', items.length, '| أسئلة:', qs.length);
console.log('إجمالي الأوزان:', indicators.reduce((a, b) => a + b.weight, 0));
