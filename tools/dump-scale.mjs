import { writeFileSync } from 'node:fs';
import { all } from '/home/user/tahseel-planning-quality/src/db/index.js';
import { roleName, activeRoles } from '/home/user/tahseel-planning-quality/src/lib/roles.js';
import { samplePlanLabel } from '/home/user/tahseel-planning-quality/src/lib/scoring.js';

const sections = all('SELECT * FROM metric_sections ORDER BY sort, id');
const axes = all('SELECT * FROM metric_axes ORDER BY sort, id');
const inds = all('SELECT * FROM indicators WHERE is_active = 1 ORDER BY sort, id');
const counts = Object.fromEntries(all('SELECT indicator_id, COUNT(*) c FROM checklist_items WHERE is_active = 1 GROUP BY indicator_id').map((r) => [r.indicator_id, r.c]));
const qcounts = Object.fromEntries(all('SELECT indicator_id, COUNT(*) c FROM question_bank WHERE indicator_id IS NOT NULL GROUP BY indicator_id').map((r) => [r.indicator_id, r.c]));

const TOOL = { checklist: 'قائمة تحقق', survey: 'استبانة', record: 'سجل تشغيلي' };
const rows = inds.map((i) => {
  const ax = axes.find((a) => a.id === i.axis_id);
  const se = sections.find((s) => s.id === ax.section_id);
  return {
    code: i.code, section: se.name, axis: ax.name, name: i.name,
    tool: TOOL[i.tool], tool_key: i.tool, owner: roleName(i.owner_role), owner_key: i.owner_role,
    plan: samplePlanLabel(i), periodicity: i.periodicity,
    sample_pct: i.sample_pct, min_count: i.min_count, weight: i.weight,
    description: i.description || '',
    fill: i.tool === 'checklist' ? `${counts[i.id] || 0} بند تحقق`
      : i.tool === 'survey' ? `${qcounts[i.id] || 0} سؤال استبانة`
        : 'يُحسب تلقائيًا من سجلات النظام',
  };
});
const roles = activeRoles().map((r) => ({ key: r.key, name: r.name }));
const users = all("SELECT full_name, username, global_role FROM users WHERE is_active = 1 ORDER BY full_name");
writeFileSync(process.argv[2], JSON.stringify({ rows, roles, users, sections: sections.map((s) => s.name) }, null, 1));
console.log('مؤشرات:', rows.length, '| مناصب:', roles.length, '| حسابات:', users.length);
console.log('إجمالي الأوزان:', rows.reduce((a, b) => a + b.weight, 0));
