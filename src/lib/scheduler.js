import { all, get, run } from '../db/index.js';
import { addDays, daysBetween, today } from './util.js';
import { requiredCount, programContext, missingMeasurements, computeProgram, exemptionsFor } from './scoring.js';

/**
 * محرك الجدولة — البند 5: «توليد مهام القياس تلقائيًا من الدوريات والعينات
 * وإظهارها لصاحبها»، والبند 12: «يمكن إنشاء برنامج وتوليد القياسات المطلوبة آليًا».
 */

/** يختار عينة موزّعة بانتظام من اللقاءات. */
export function pickSample(sessions, count) {
  const n = sessions.length;
  if (!n || count <= 0) return [];
  if (count >= n) return [...sessions];
  const step = n / count;
  const picked = [];
  for (let i = 0; i < count; i += 1) {
    const idx = Math.min(n - 1, Math.floor(i * step));
    if (!picked.includes(sessions[idx])) picked.push(sessions[idx]);
  }
  // تعويض أي تكرار نتج عن التقريب
  for (const s of sessions) {
    if (picked.length >= count) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.slice(0, count).sort((a, b) => a.seq - b.seq);
}

/** التاريخ المستحق لمهمة بحسب دورية المؤشر وترتيبها. */
function dueDateFor(program, indicator, seq, total) {
  const start = program.start_date || today();
  const end = program.end_date || addDays(start, 30);
  const span = Math.max(1, daysBetween(start, end));
  switch (indicator.periodicity) {
    case 'before_start': return addDays(start, -1);
    case 'mid': return addDays(start, Math.round(span / 2));
    case 'end': return end;
    case 'mid_end': return seq === 1 ? addDays(start, Math.round(span / 2)) : end;
    case 'continuous': return end;
    case 'fixed_count': return addDays(start, Math.round((span * seq) / (total + 1)));
    default: return addDays(start, Math.round((span * seq) / Math.max(1, total)));
  }
}

/** أول مستخدم مسند لهذا الدور في البرنامج. */
function assigneeFor(programId, role) {
  const row = get(
    'SELECT user_id FROM program_assignments WHERE program_id = ? AND role = ? ORDER BY id LIMIT 1',
    programId, role,
  );
  return row?.user_id ?? null;
}

function taskExists(programId, indicatorId, seq, sessionId) {
  return get(
    `SELECT id FROM tasks
      WHERE program_id = ? AND indicator_id = ? AND seq = ?
        AND ((session_id IS NULL AND ? IS NULL) OR session_id = ?)`,
    programId, indicatorId, seq, sessionId, sessionId,
  );
}

/**
 * يولّد/يحدّث مهام القياس لبرنامج. العملية متكرّرة الاستدعاء بأمان:
 * تُنشئ الناقص، تُعيد إسناد المهام المعلّقة، وتلغي الفائض المعلّق فقط.
 */
export function syncProgramTasks(programId) {
  const program = get('SELECT * FROM programs WHERE id = ?', programId);
  if (!program) return { created: 0, cancelled: 0 };
  const ctx = programContext(programId);
  const sessions = all('SELECT * FROM sessions WHERE program_id = ? ORDER BY seq', programId);
  const indicators = all('SELECT * FROM indicators WHERE is_active = 1 ORDER BY sort, id');
  const exemptions = exemptionsFor(programId);

  let created = 0;
  let cancelled = 0;

  for (const ind of indicators) {
    // المؤشرات الموسومة «غير منطبق» لا تُولَّد لها مهام، وتُلغى مهامها المعلّقة.
    if (exemptions.has(ind.id)) {
      for (const t of all("SELECT id FROM tasks WHERE program_id = ? AND indicator_id = ? AND status = 'pending'", programId, ind.id)) {
        run("UPDATE tasks SET status = 'cancelled' WHERE id = ?", t.id);
        cancelled += 1;
      }
      continue;
    }
    const total = requiredCount(ind, program, ctx);
    const assignee = assigneeFor(programId, ind.owner_role);
    const kind = ind.tool;

    // المؤشرات المرتبطة بالأنشطة الرئيسة تُولَّد عند تسجيل النشاط نفسه.
    if (ind.periodicity === 'per_main_activity') continue;

    let sampleSessions = [];
    if (ind.periodicity === 'per_session_sample') {
      sampleSessions = pickSample(sessions.filter((s) => s.status !== 'cancelled'), total);
    }

    for (let seq = 1; seq <= total; seq += 1) {
      const session = sampleSessions[seq - 1] || null;
      const sessionId = session ? session.id : null;
      if (taskExists(programId, ind.id, seq, sessionId)) continue;
      const due = session?.session_date || dueDateFor(program, ind, seq, total);
      const title = session
        ? `${ind.name} — اللقاء ${session.seq}`
        : `${ind.name}${total > 1 ? ` (${seq}/${total})` : ''}`;
      run(
        `INSERT INTO tasks (program_id, indicator_id, kind, title, session_id, seq, assigned_role, assigned_user_id, due_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        programId, ind.id, kind, title, sessionId, seq, ind.owner_role, assignee, due,
      );
      created += 1;
    }

    // إلغاء الفائض المعلّق عند تقليص عدد اللقاءات أو العينة
    const surplus = all(
      "SELECT id FROM tasks WHERE program_id = ? AND indicator_id = ? AND status = 'pending' AND seq > ?",
      programId, ind.id, total,
    );
    for (const t of surplus) {
      run("UPDATE tasks SET status = 'cancelled' WHERE id = ?", t.id);
      cancelled += 1;
    }
  }

  // إسناد المهام المعلّقة غير المسندة لصاحب الدور الحالي
  for (const role of new Set(indicators.map((i) => i.owner_role))) {
    const assignee = assigneeFor(programId, role);
    if (assignee) {
      run(
        "UPDATE tasks SET assigned_user_id = ? WHERE program_id = ? AND assigned_role = ? AND status = 'pending' AND assigned_user_id IS NULL",
        assignee, programId, role,
      );
    }
  }

  return { created, cancelled };
}

/** يولّد مهمة قياس فاعلية نشاط رئيس عند إغلاقه — BR-09. */
export function scheduleMainActivityTask(activityId) {
  const activity = get('SELECT * FROM activities WHERE id = ?', activityId);
  if (!activity || !activity.is_main) return null;
  const ind = get("SELECT * FROM indicators WHERE periodicity = 'per_main_activity' AND is_active = 1 LIMIT 1");
  if (!ind) return null;
  const existing = get(
    'SELECT id FROM tasks WHERE program_id = ? AND indicator_id = ? AND activity_id = ?',
    activity.program_id, ind.id, activityId,
  );
  if (existing) return existing.id;
  const seq = Number(get(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tasks WHERE program_id = ? AND indicator_id = ?',
    activity.program_id, ind.id,
  )?.n || 1);
  const res = run(
    `INSERT INTO tasks (program_id, indicator_id, kind, title, activity_id, seq, assigned_role, assigned_user_id, due_date)
     VALUES (?, ?, 'survey', ?, ?, ?, ?, ?, ?)`,
    activity.program_id, ind.id, `قياس فاعلية النشاط: ${activity.name}`,
    activityId, seq, ind.owner_role, assigneeFor(activity.program_id, ind.owner_role),
    addDays(activity.activity_date || today(), 2),
  );
  return Number(res.lastInsertRowid);
}

/** مهام المستخدم مصنّفة: اليوم، قريبًا، متأخر. */
export function tasksForUser(userId, { programId = null } = {}) {
  const params = [userId];
  let sql = `SELECT t.*, p.name AS program_name, i.name AS indicator_name, i.tool,
                    s.seq AS session_seq, s.session_date
               FROM tasks t
               JOIN programs p ON p.id = t.program_id
               LEFT JOIN indicators i ON i.id = t.indicator_id
               LEFT JOIN sessions s ON s.id = t.session_id
              WHERE t.assigned_user_id = ? AND t.status = 'pending' AND p.status <> 'closed'`;
  if (programId) { sql += ' AND t.program_id = ?'; params.push(programId); }
  sql += ' ORDER BY t.due_date IS NULL, t.due_date, t.id';
  const rows = all(sql, ...params);
  const now = today();
  return {
    all: rows,
    overdue: rows.filter((t) => t.due_date && t.due_date < now),
    dueToday: rows.filter((t) => t.due_date === now),
    soon: rows.filter((t) => t.due_date && t.due_date > now && daysBetween(now, t.due_date) <= 7),
    later: rows.filter((t) => !t.due_date || daysBetween(now, t.due_date) > 7),
  };
}

function notify(userId, programId, type, title, body, link, dedupeKey) {
  if (!userId) return;
  const existing = get('SELECT id FROM notifications WHERE user_id = ? AND dedupe_key = ?', userId, dedupeKey);
  if (existing) return;
  run(
    'INSERT INTO notifications (user_id, program_id, type, title, body, link, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
    userId, programId, type, title, body, link, dedupeKey,
  );
}

/**
 * محرك التنبيهات — البند 5: تنبيه قبل الاستحقاق، عند التأخر،
 * عند نقص العينة، وعند وجود عنصر غير متحقق.
 */
export function refreshNotifications({ programId = null } = {}) {
  const now = today();
  const soonLimit = addDays(now, 3);
  const programs = programId
    ? all("SELECT * FROM programs WHERE id = ? AND status <> 'closed'", programId)
    : all("SELECT * FROM programs WHERE status <> 'closed'");

  let count = 0;
  for (const p of programs) {
    const tasks = all(
      "SELECT * FROM tasks WHERE program_id = ? AND status = 'pending' AND assigned_user_id IS NOT NULL",
      p.id,
    );
    for (const t of tasks) {
      if (!t.due_date) continue;
      if (t.due_date < now) {
        notify(t.assigned_user_id, p.id, 'overdue', 'مهمة متأخرة',
          `${t.title} — كان الاستحقاق ${t.due_date}`, `/tasks/${t.id}`, `overdue:${t.id}`);
        count += 1;
      } else if (t.due_date <= soonLimit) {
        notify(t.assigned_user_id, p.id, 'due_soon', 'مهمة مستحقة قريبًا',
          `${t.title} — تستحق ${t.due_date}`, `/tasks/${t.id}`, `soon:${t.id}:${t.due_date}`);
        count += 1;
      }
    }

    // نقص العينة قبل الإقفال
    const manager = get(
      "SELECT user_id FROM program_assignments WHERE program_id = ? AND role = 'quality_manager' LIMIT 1",
      p.id,
    ) || get("SELECT id AS user_id FROM users WHERE global_role = 'quality_manager' LIMIT 1");
    for (const gap of missingMeasurements(p.id)) {
      const target = assigneeFor(p.id, gap.indicator.owner_role) || manager?.user_id;
      notify(target, p.id, 'sample_gap', 'نقص في عينة القياس',
        `${gap.indicator.name}: ${gap.completed} من ${gap.required} — ${gap.sample_label}`,
        `/programs/${p.id}/metric`, `gap:${p.id}:${gap.indicator.id}:${gap.completed}/${gap.required}`);
      count += 1;
    }

    // عناصر غير متحققة بلا إجراء تصحيحي
    const notMet = all(
      `SELECT vi.id, ci.text, v.indicator_id, i.name AS indicator_name
         FROM verification_items vi
         JOIN verifications v ON v.id = vi.verification_id
         JOIN checklist_items ci ON ci.id = vi.checklist_item_id
         JOIN indicators i ON i.id = v.indicator_id
        WHERE v.program_id = ? AND v.status = 'submitted' AND vi.state = 0`,
      p.id,
    );
    const officer = assigneeFor(p.id, 'program_officer') || manager?.user_id;
    for (const item of notMet) {
      notify(officer, p.id, 'not_met', 'عنصر غير متحقق',
        `${item.indicator_name}: ${item.text}`,
        `/programs/${p.id}/actions`, `notmet:${item.id}`);
      count += 1;
    }
  }
  return count;
}

/** فحص جاهزية الإقفال — يمنع الإقفال دون إظهار القياسات الناقصة (البند 12). */
export function closureReadiness(programId) {
  const gaps = missingMeasurements(programId);
  const openComplaints = all(
    "SELECT * FROM complaints WHERE program_id = ? AND status <> 'closed'",
    programId,
  );
  const unverifiedComplaints = all(
    "SELECT * FROM complaints WHERE program_id = ? AND status = 'closed' AND verified_at IS NULL",
    programId,
  );
  const complaintsNoEvidence = all(
    `SELECT c.* FROM complaints c
      WHERE c.program_id = ? AND c.status = 'closed'
        AND NOT EXISTS (SELECT 1 FROM evidences e WHERE e.entity_type = 'complaint' AND e.entity_id = c.id)`,
    programId,
  );
  const openActions = all(
    "SELECT * FROM corrective_actions WHERE program_id = ? AND status IN ('open','in_progress')",
    programId,
  );
  const pendingTasks = all(
    "SELECT * FROM tasks WHERE program_id = ? AND status = 'pending'",
    programId,
  );
  const result = computeProgram(programId);
  return {
    gaps,
    openComplaints,
    unverifiedComplaints,
    complaintsNoEvidence,
    openActions,
    pendingTasks,
    coverage_pct: result?.coverage_pct ?? 0,
    ready: gaps.length === 0 && openComplaints.length === 0 && unverifiedComplaints.length === 0,
  };
}
