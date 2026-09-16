import { existsSync, rmSync } from 'node:fs';
import { get, run, tx, getDb, resetDbHandle, DB_PATH } from './index.js';
import { FRAMEWORK, QUESTION_BANK } from './framework.js';
import { hashPassword } from '../lib/auth.js';
import { addDays, today } from '../lib/util.js';
import { syncProgramTasks, scheduleMainActivityTask, refreshNotifications } from '../lib/scheduler.js';

const DEFAULT_PASSWORD = process.env.TPQ_SEED_PASSWORD || 'Tahseel@2026';

/** يزرع بنية المقياس (أقسام/محاور/مؤشرات/عناصر) إن لم تكن موجودة. */
export function seedFramework() {
  let sSort = 0;
  for (const section of FRAMEWORK) {
    sSort += 1;
    let sec = get('SELECT * FROM metric_sections WHERE code = ?', section.code);
    if (!sec) {
      run('INSERT INTO metric_sections (code, name, weight, sort) VALUES (?, ?, ?, ?)',
        section.code, section.name, section.weight, sSort);
      sec = get('SELECT * FROM metric_sections WHERE code = ?', section.code);
    }
    let aSort = 0;
    for (const axis of section.axes) {
      aSort += 1;
      let ax = get('SELECT * FROM metric_axes WHERE code = ?', axis.code);
      if (!ax) {
        run('INSERT INTO metric_axes (section_id, code, name, weight, sort) VALUES (?, ?, ?, ?, ?)',
          sec.id, axis.code, axis.name, axis.weight, aSort);
        ax = get('SELECT * FROM metric_axes WHERE code = ?', axis.code);
      }
      let iSort = 0;
      for (const ind of axis.indicators) {
        iSort += 1;
        let row = get('SELECT * FROM indicators WHERE code = ?', ind.code);
        if (!row) {
          run(
            `INSERT INTO indicators (axis_id, code, name, weight, tool, owner_role, periodicity,
                                     sample_pct, min_count, record_rule, description, sort)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ax.id, ind.code, ind.name, ind.weight, ind.tool, ind.owner_role, ind.periodicity,
            ind.sample_pct ?? null, ind.min_count ?? null, ind.record_rule ?? null,
            ind.description ?? null, (sSort * 100) + (aSort * 10) + iSort,
          );
          row = get('SELECT * FROM indicators WHERE code = ?', ind.code);
        }
        (ind.items || []).forEach((text, idx) => {
          const code = `${ind.code}-${String(idx + 1).padStart(2, '0')}`;
          if (!get('SELECT 1 FROM checklist_items WHERE indicator_id = ? AND code = ?', row.id, code)) {
            run('INSERT INTO checklist_items (indicator_id, code, text, weight, sort) VALUES (?, ?, ?, 1, ?)',
              row.id, code, text, idx + 1);
          }
        });
      }
    }
  }

  QUESTION_BANK.forEach((q, idx) => {
    if (get('SELECT 1 FROM question_bank WHERE code = ?', q.code)) return;
    const ind = get('SELECT id FROM indicators WHERE code = ?', q.indicator);
    run('INSERT INTO question_bank (code, text, indicator_id, point, sort) VALUES (?, ?, ?, ?, ?)',
      q.code, q.text, ind?.id ?? null, q.point, idx + 1);
  });

  run("INSERT OR IGNORE INTO settings (key, value) VALUES ('scale_version', 'v1-300')");
  run("INSERT OR IGNORE INTO settings (key, value) VALUES ('org_name', 'جمعية تحصيل المعرفة')");
  run("INSERT OR IGNORE INTO settings (key, value) VALUES ('default_sla_days', '5')");
}

function ensureUser({ full_name, username, global_role = 'none', password = DEFAULT_PASSWORD }) {
  const existing = get('SELECT * FROM users WHERE username = ?', username);
  if (existing) return existing;
  const { hash, salt } = hashPassword(password);
  run('INSERT INTO users (full_name, username, password_hash, password_salt, global_role) VALUES (?, ?, ?, ?, ?)',
    full_name, username, hash, salt, global_role);
  return get('SELECT * FROM users WHERE username = ?', username);
}

/** حسابات تجريبية تغطي كل الأدوار الخمسة في الوثيقة. */
export function seedUsers() {
  return {
    admin: ensureUser({ full_name: 'مدير النظام', username: 'admin', global_role: 'admin' }),
    manager: ensureUser({ full_name: 'خالد المنصور', username: 'manager', global_role: 'quality_manager' }),
    officer: ensureUser({ full_name: 'عبدالله الحربي', username: 'officer' }),
    supervisor: ensureUser({ full_name: 'سعد العتيبي', username: 'supervisor' }),
    academic: ensureUser({ full_name: 'محمد الشمري', username: 'academic' }),
    quality: ensureUser({ full_name: 'فيصل القحطاني', username: 'quality' }),
  };
}

/** برنامج تجريبي كامل لاستعراض المنصة من أول لحظة. */
export function seedDemoProgram(users) {
  if (get("SELECT 1 FROM programs WHERE code = 'PRG-001'")) return;

  run('INSERT INTO venues (name, location, capacity) VALUES (?, ?, ?)',
    'القاعة الرئيسة', 'المقر الرئيس — الرياض', 40);
  run('INSERT INTO venues (name, location, capacity) VALUES (?, ?, ?)',
    'قاعة التدريب (2)', 'المقر الرئيس — الرياض', 25);
  const venue = get("SELECT id FROM venues WHERE name = 'القاعة الرئيسة'");

  run(`INSERT INTO teachers (full_name, phone, specialization, credentials_note, recommendation_ref, suitability_status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    'أ. إبراهيم الدوسري', '0500000000', 'علوم شرعية',
    'إجازة في القراءات — جامعة الإمام', 'تزكية من الشيخ/ عبدالرحمن السالم');
  const teacher = get('SELECT id FROM teachers ORDER BY id LIMIT 1');

  const start = addDays(today(), -21);
  const end = addDays(today(), 21);
  run(
    `INSERT INTO programs (name, code, kind, term, start_date, end_date, venue_id, planned_sessions, planned_students, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    'برنامج إتقان التلاوة — الفوج الأول', 'PRG-001', 'دورة تدريبية', 'الفصل الأول 2026',
    start, end, venue.id, 12, 24, users.admin.id,
  );
  const program = get("SELECT * FROM programs WHERE code = 'PRG-001'");

  const roles = [
    [users.officer.id, 'program_officer'],
    [users.supervisor.id, 'supervisor'],
    [users.academic.id, 'academic_quality'],
    [users.quality.id, 'quality_officer'],
    [users.manager.id, 'quality_manager'],
  ];
  for (const [uid, role] of roles) {
    run('INSERT INTO program_assignments (program_id, user_id, role) VALUES (?, ?, ?)', program.id, uid, role);
  }

  for (let i = 1; i <= 12; i += 1) {
    run(
      'INSERT INTO sessions (program_id, seq, title, session_date, venue_id, teacher_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      program.id, i, `اللقاء ${i}`, addDays(start, (i - 1) * 3), venue.id, teacher.id,
      addDays(start, (i - 1) * 3) <= today() ? 'held' : 'planned',
    );
  }

  const names = [
    'أحمد الزهراني', 'بدر السبيعي', 'تركي المطيري', 'ثامر الغامدي', 'جابر الشهري',
    'حسن العمري', 'خالد الدوسري', 'راكان القحطاني', 'زياد الحارثي', 'سالم البقمي',
    'شادي الرشيدي', 'صالح المالكي', 'طلال العنزي', 'عادل الخالدي', 'عامر الشمراني',
    'فهد الجهني', 'قاسم البلوي', 'ماجد الثبيتي', 'ناصر السلمي', 'هاني الزايدي',
    'وليد العوفي', 'ياسر الصاعدي', 'إياد الحجيلي', 'أنس المحمادي',
  ];
  names.forEach((n, idx) => {
    const withdrawn = idx >= 22; // انسحاب طالبين
    run(
      `INSERT INTO students (program_id, full_name, status, joined_at, withdrawn_at, withdraw_reason, intent_continue)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      program.id, n, withdrawn ? 'withdrawn' : 'active', start,
      withdrawn ? addDays(start, 10) : null,
      withdrawn ? 'ظروف دراسية' : null,
      withdrawn ? 0 : null,
    );
  });

  run(`INSERT INTO plans (program_id, objectives, outcomes, timeline, content_outline)
       VALUES (?, ?, ?, ?, ?)`,
    program.id,
    'تمكين الطالب من إتقان أحكام التلاوة الأساسية وتطبيقها عمليًا.',
    'يتلو الطالب صفحة كاملة تطبيقًا صحيحًا لأحكام النون الساكنة والمدود.',
    '12 لقاءً على مدى ستة أسابيع بواقع لقاءين أسبوعيًا.',
    'مقدمة في التجويد، مخارج الحروف، أحكام النون الساكنة، أحكام الميم الساكنة، المدود، التطبيق العملي.');

  run(`INSERT INTO activities (program_id, name, kind, is_main, activity_date, status, created_by)
       VALUES (?, ?, ?, 1, ?, 'done', ?)`,
    program.id, 'الملتقى التطبيقي الأول للتلاوة', 'تطبيقي', addDays(start, 12), users.academic.id);

  run(`INSERT INTO complaints (program_id, ref_code, kind, source, title, body, sla_days, due_date, assigned_to, status)
       VALUES (?, ?, 'complaint', 'طالب', ?, ?, 5, ?, ?, 'open')`,
    program.id, 'C-001', 'تأخر بدء اللقاء الرابع',
    'تأخر بدء اللقاء عن الموعد المعلن بخمس عشرة دقيقة.',
    addDays(today(), 2), users.officer.id);

  syncProgramTasks(program.id);
  const activity = get('SELECT id FROM activities WHERE program_id = ? AND is_main = 1', program.id);
  if (activity) scheduleMainActivityTask(activity.id);
  refreshNotifications({ programId: program.id });
}

export function seedAll({ demo = true } = {}) {
  getDb();
  return tx(() => {
    seedFramework();
    const users = seedUsers();
    if (demo) seedDemoProgram(users);
    return users;
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const reset = process.argv.includes('--reset');
  const demo = !process.argv.includes('--no-demo');
  if (reset && DB_PATH !== ':memory:' && existsSync(DB_PATH)) {
    resetDbHandle();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${DB_PATH}${suffix}`;
      if (existsSync(f)) rmSync(f);
    }
    console.log('تم حذف قاعدة البيانات السابقة.');
  }
  seedAll({ demo });
  const counts = {
    الأقسام: get('SELECT COUNT(*) c FROM metric_sections').c,
    المحاور: get('SELECT COUNT(*) c FROM metric_axes').c,
    المؤشرات: get('SELECT COUNT(*) c FROM indicators').c,
    'عناصر التحقق': get('SELECT COUNT(*) c FROM checklist_items').c,
    المستخدمون: get('SELECT COUNT(*) c FROM users').c,
    البرامج: get('SELECT COUNT(*) c FROM programs').c,
    المهام: get('SELECT COUNT(*) c FROM tasks').c,
  };
  const total = get('SELECT SUM(weight) s FROM indicators WHERE is_active = 1').s;
  console.log('تمت التهيئة بنجاح:', counts);
  console.log(`إجمالي أوزان المؤشرات = ${total} درجة`);
  console.log(`كلمة المرور الافتراضية لكل الحسابات: ${DEFAULT_PASSWORD}`);
}

export { DEFAULT_PASSWORD };
