import { all, get, run } from '../db/index.js';
import { addDays, today } from './util.js';

/**
 * الإجراءات التصحيحية الذكية.
 *
 * المشكلة التي تعالجها: تحقق البيئة يفشل في «المكيف لا يعمل» أربع مرات،
 * فيولّد النظام أربعة إجراءات متفرقة — فيبدو أن هناك أربع مشكلات، وهي واحدة.
 *
 * القاعدة هنا: المشكلة الواحدة = إجراء واحد يحمل عدّاد تكرارها.
 * وإذا تكررت بعد إغلاق إجراءها، فذلك دليل أن السبب الجذري لم يُعالَج،
 * فيُفتح إجراء جديد موسوم بـ«تكرار» وبأولوية أعلى.
 */

/** مفتاح تجميع المشكلة: نفس عنصر التحقق في نفس المؤشر = نفس المشكلة. */
export const groupKeyFor = (indicatorId, checklistItemId) => `chk:${indicatorId}:${checklistItemId}`;

/** موعد الاستحقاق بحسب شدة المشكلة وتكرارها. */
function dueFor({ state, occurrences, recurred }) {
  if (recurred) return addDays(today(), 3);      // تكرار بعد إغلاق: عاجل
  if (state === 0 && occurrences >= 3) return addDays(today(), 3);
  if (state === 0) return addDays(today(), 7);
  return addDays(today(), 14);                    // جزئي: أقل إلحاحًا
}

/**
 * يسجّل إخفاق عنصر تحقق كإجراء تصحيحي، مجمّعًا لا مكرّرًا.
 * @returns {{action: object, created: boolean, recurred: boolean}}
 */
export function recordFailure({
  programId, indicatorId, indicatorName, item, state, note, ownerId, userId, verificationId,
}) {
  const key = groupKeyFor(indicatorId, item.id);

  // إجراء مفتوح لنفس المشكلة → زد العدّاد بدل إنشاء إجراء جديد
  const open = get(
    `SELECT * FROM corrective_actions
      WHERE program_id = ? AND group_key = ? AND status IN ('open','in_progress')
      ORDER BY id DESC LIMIT 1`,
    programId, key,
  );
  if (open) {
    const occurrences = Number(open.occurrence_count || 1) + 1;
    run(
      `UPDATE corrective_actions
          SET occurrence_count = ?, due_date = ?,
              description = ?
        WHERE id = ?`,
      occurrences,
      dueFor({ state, occurrences, recurred: Boolean(open.recurred) }),
      `${open.description || ''}\n• تكرر في ${today()}: ${note || '—'}`.trim().slice(0, 2000),
      open.id,
    );
    return { action: get('SELECT * FROM corrective_actions WHERE id = ?', open.id), created: false, recurred: false };
  }

  // أُغلق إجراء لنفس المشكلة سابقًا ثم عادت → تكرار بعد الإغلاق
  const closed = get(
    `SELECT * FROM corrective_actions
      WHERE program_id = ? AND group_key = ? AND status IN ('done','cancelled')
      ORDER BY id DESC LIMIT 1`,
    programId, key,
  );
  const recurred = Boolean(closed);

  const title = recurred
    ? `تكرار بعد المعالجة: ${item.text}`.slice(0, 180)
    : `معالجة: ${item.text}`.slice(0, 180);

  const description = recurred
    ? `عادت المشكلة بعد إغلاق إجراء سابق بتاريخ ${closed.closed_at || '—'}.\n`
      + `الإجراء السابق: ${closed.title}\nالملاحظة الحالية: ${note || '—'}\n`
      + 'السبب الجذري لم يُعالَج — راجع كفاية الإجراء السابق لا تكراره.'
    : `نتج عن تحقق «${indicatorName}». الملاحظة: ${note || '—'}`;

  const res = run(
    `INSERT INTO corrective_actions
       (program_id, kind, origin_type, origin_id, title, description, owner_id, due_date,
        created_by, group_key, occurrence_count, recurred)
     VALUES (?, 'corrective', 'verification', ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    programId, verificationId, title, description, ownerId,
    dueFor({ state, occurrences: 1, recurred }), userId, key, recurred ? 1 : 0,
  );
  return {
    action: get('SELECT * FROM corrective_actions WHERE id = ?', Number(res.lastInsertRowid)),
    created: true,
    recurred,
  };
}

/**
 * يعالج كل عناصر تحقق أخفقت دفعة واحدة، ويعيد ملخصًا مقروءًا.
 * الجزئي (50) لا يُنشئ إجراءً إلا إذا تكرر — حتى لا تغرق اللوحة بملاحظات صغيرة.
 */
export function recordVerificationFailures({
  programId, indicatorId, indicatorName, failures, ownerId, userId, verificationId,
}) {
  let created = 0;
  let merged = 0;
  let recurred = 0;

  for (const f of failures) {
    const isRepeatPartial = f.state === 50 && !get(
      `SELECT 1 FROM corrective_actions WHERE program_id = ? AND group_key = ?`,
      programId, groupKeyFor(indicatorId, f.item.id),
    ) && countPriorFailures(programId, indicatorId, f.item.id) < 2;
    if (isRepeatPartial) continue; // جزئي لأول مرة: ملاحظة تكفي

    const r = recordFailure({
      programId, indicatorId, indicatorName, item: f.item, state: f.state,
      note: f.note, ownerId, userId, verificationId,
    });
    if (r.created) created += 1; else merged += 1;
    if (r.recurred) recurred += 1;
  }
  return { created, merged, recurred };
}

/** كم مرة أخفق هذا العنصر في هذا البرنامج (لتمييز الجزئي المتكرر). */
export function countPriorFailures(programId, indicatorId, checklistItemId) {
  return Number(get(
    `SELECT COUNT(*) c FROM verification_items vi
       JOIN verifications v ON v.id = vi.verification_id
      WHERE v.program_id = ? AND v.indicator_id = ? AND vi.checklist_item_id = ?
        AND v.status = 'submitted' AND vi.state < 100`,
    programId, indicatorId, checklistItemId,
  )?.c || 0);
}

/** الإجراءات مرتبة بالأولوية: التكرار أولًا ثم التأخر ثم كثرة التكرار. */
export function prioritizedActions(programId) {
  const now = today();
  return all(
    `SELECT a.*, u.full_name AS owner_name FROM corrective_actions a
       LEFT JOIN users u ON u.id = a.owner_id
      WHERE a.program_id = ? ORDER BY a.id`,
    programId,
  ).map((a) => {
    let priority = 0;
    if (a.recurred) priority += 50;
    if (a.status === 'open' || a.status === 'in_progress') {
      if (a.due_date && a.due_date < now) priority += 30;
      priority += Math.min(Number(a.occurrence_count || 1), 6) * 5;
    }
    return { ...a, priority };
  }).sort((a, b) => b.priority - a.priority);
}
