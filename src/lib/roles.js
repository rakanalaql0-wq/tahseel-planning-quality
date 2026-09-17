import { all, get, run } from '../db/index.js';

/**
 * الأدوار والصلاحيات (RBAC).
 *
 * قاعدة التقسيم هنا:
 * • **مفردات الصلاحيات** (PERMISSIONS) تبقى في الكود، لأن كل صلاحية مربوطة
 *   بشاشة أو زر موجود فعلًا — فاختراع صلاحية من الواجهة لا يعني شيئًا.
 * • **الأدوار وما تملكه من صلاحيات** تعيش في قاعدة البيانات، فيضيف مدير
 *   النظام منصبًا جديدًا ويعدّل صلاحياته دون تعديل برمجي.
 *
 * مبدأ الصلاحية الحاكم: «عرض المهام المرتبطة بالدور فقط، مع حقول حسب الصلاحية».
 */

/** كل الصلاحيات التي يفهمها النظام، مجمّعة كما تُعرض في شاشة الأدوار. */
export const PERMISSIONS = [
  {
    group: 'البرنامج',
    perms: [
      ['program.read', 'الاطلاع على البرنامج'],
      ['program.create', 'إنشاء برنامج'],
      ['program.edit', 'تعديل بيانات البرنامج'],
      ['program.assign', 'إسناد الأدوار للفريق'],
      ['program.close', 'إقفال البرنامج'],
    ],
  },
  {
    group: 'التشغيل',
    perms: [
      ['session.manage', 'إدارة اللقاءات'],
      ['student.manage', 'إدارة الطلاب'],
      ['attendance.manage', 'تسجيل الحضور'],
      ['plan.review', 'مراجعة الخطة والمحتوى'],
      ['teacher.verify', 'التحقق من المعلم'],
      ['content.review', 'مراجعة سلامة المحتوى العلمي'],
      ['activity.manage', 'إدارة الأنشطة'],
    ],
  },
  {
    group: 'القياس',
    perms: [
      ['task.do.environment', 'تنفيذ قياسات البيئة والمرافق'],
      ['task.do.academic', 'تنفيذ القياسات العلمية'],
      ['task.do.survey', 'تنفيذ قياسات الاستبانات'],
      ['classroom.visit', 'الزيارة الصفية'],
      ['survey.manage.teacher', 'إدارة استبانة تقييم المعلم'],
      ['survey.manage.experience', 'إدارة استبانات تجربة الطالب'],
      ['survey.analyze', 'تحليل نتائج الاستبانات'],
      ['impact.manage', 'إدارة قياس الأثر التعليمي'],
      ['indicator.exempt', 'وسم مؤشر بغير منطبق'],
      ['metric.read', 'الاطلاع على بنية المقياس'],
    ],
  },
  {
    group: 'المتابعة',
    perms: [
      ['complaint.manage', 'معالجة الشكاوى'],
      ['complaint.verify', 'التحقق النهائي من الشكاوى'],
      ['discipline.manage', 'متابعة الانضباط والحالات'],
      ['continuity.manage', 'احتساب الاستمرارية'],
      ['action.manage', 'إدارة الإجراءات التصحيحية'],
      ['evidence.upload', 'رفع الشواهد'],
    ],
  },
  {
    group: 'التقارير والتدقيق',
    perms: [
      ['report.read', 'قراءة التقارير'],
      ['report.approve', 'اعتماد التقارير النهائية'],
      ['audit.read', 'قراءة سجل التدقيق'],
    ],
  },
];

/** خريطة مسطّحة: مفتاح الصلاحية → اسمها العربي. */
export const PERM_LABELS = new Map(PERMISSIONS.flatMap((g) => g.perms));

/** كل مفاتيح الصلاحيات المعروفة — ما عداها يُرفض عند الحفظ. */
export const ALL_PERMS = [...PERM_LABELS.keys()];

/**
 * أدوار الوثيقة الأصلية — تُزرع مرة واحدة ثم تصير قابلة للتعديل من الواجهة.
 * وسمها is_system يمنع حذفها فقط، ولا يمنع تعديل اسمها أو صلاحياتها.
 */
export const DEFAULT_ROLES = [
  {
    key: 'program_officer',
    name: 'مسؤول البرنامج',
    perms: [
      'program.read', 'program.edit', 'program.close',
      'session.manage', 'student.manage', 'attendance.manage',
      'task.do.environment', 'complaint.manage', 'discipline.manage',
      'continuity.manage', 'action.manage', 'evidence.upload', 'report.read',
    ],
    duties: [
      'تسجيل بيانات البرنامج وعدد اللقاءات والطلاب عند البداية.',
      'تنفيذ/تنسيق تحقق البيئة والمرافق مع المشرف وفق الدوريات المحددة.',
      'متابعة الحضور والانضباط والحالات المتعثرة وتوثيق الإجراءات.',
      'متابعة الشكاوى والمقترحات ومعالجتها ضمن المدة المعتمدة.',
      'احتساب الاستمرارية الفعلية في نهاية البرنامج وتوثيق الانسحابات.',
    ],
  },
  {
    key: 'supervisor',
    name: 'المشرف',
    perms: ['program.read', 'task.do.environment', 'evidence.upload', 'action.manage', 'report.read'],
    duties: [
      'تنفيذ قوائم تحقق القاعات والمرافق عند التكليف أو وفق خطة العينة.',
      'التحقق من تهيئة القاعات قبل بدء الدروس ضمن عينة لا تقل عن 50% من اللقاءات.',
      'توثيق الملاحظات والشواهد والإجراءات التصحيحية المرتبطة بالبيئة.',
    ],
  },
  {
    key: 'academic_quality',
    name: 'مسؤول التخطيط والجودة العلمية',
    perms: [
      'program.read', 'teacher.verify', 'content.review', 'plan.review',
      'activity.manage', 'task.do.academic', 'survey.manage.teacher',
      'classroom.visit', 'impact.manage',
      'evidence.upload', 'action.manage', 'report.read',
    ],
    duties: [
      'التحقق من مناسبة المعلم عبر وثائق أو تزكية معتبرة.',
      'مراجعة جودة وسلامة المحتوى العلمي ومناسبته للفئة.',
      'متابعة تنفيذ المحتوى المقرر والالتزام بالتسلسل والتوقيت.',
      'متابعة الأنشطة والتطبيقات الإثرائية وقياس فاعلية الأنشطة الرئيسة.',
      'تنفيذ/إدارة تقييم المعلم في منتصف البرنامج ونهايته.',
      'تنفيذ الزيارة الصفية مرتين على الأقل وتوثيق نتائجها.',
      'إدارة قياس الأثر التعليمي: أدوات القياس القبلي والبعدي والعملي ونتائجها.',
      'التحقق من وضوح الأهداف والمخرجات والجدول الزمني قبل بدء البرنامج.',
      'توثيق نتيجة التحقق وإحالة أي قصور إلى مسؤول البرنامج أو الجهة المعنية.',
    ],
  },
  {
    key: 'quality_officer',
    name: 'مسؤول التخطيط والجودة',
    perms: [
      'program.read', 'survey.manage.experience', 'survey.analyze',
      'task.do.survey', 'evidence.upload', 'action.manage', 'report.read',
    ],
    duties: [
      'إدارة استبانة الدعم والإرشاد والتواصل في منتصف البرنامج ونهايته.',
      'إدارة استبانة الرضا والانتماء والتوصية والرغبة في الاستمرار في النهاية.',
      'تحليل نتائج تجربة الطالب ورفع الملاحظات ذات الأولوية للتحسين.',
    ],
  },
  {
    key: 'quality_manager',
    name: 'مدير التخطيط والجودة',
    perms: [
      'program.read', 'program.create', 'program.assign', 'program.close',
      'complaint.verify', 'metric.read', 'action.manage', 'report.read',
      'report.approve', 'audit.read', 'survey.analyze', 'impact.manage',
      'indicator.exempt',
    ],
    duties: [
      'الإشراف على سلامة تطبيق النظام واكتمال القياسات.',
      'التحقق النهائي في نهاية البرنامج من إغلاق الشكاوى واستكمال توثيقها.',
      'قراءة لوحة المؤشرات ومتابعة الإجراءات التصحيحية والتحسينية.',
      'اعتماد التقارير النهائية وقيادة التحسينات المستقبلية للنظام.',
    ],
  },
];

export const GLOBAL_ROLES = {
  admin: 'مدير النظام',
  quality_manager: 'مدير التخطيط والجودة',
  none: 'مستخدم',
};

// ------------------------------ الزرع والتخزين المؤقت ------------------------

let cache = null;

/** يُبطل التخزين المؤقت بعد أي تعديل على الأدوار. */
export function invalidateRoleCache() { cache = null; }

/** يزرع أدوار الوثيقة عند أول تشغيل لقاعدة فارغة. */
function seedDefaultRoles() {
  for (const [i, r] of DEFAULT_ROLES.entries()) {
    run('INSERT OR IGNORE INTO roles (key, name, is_system, sort) VALUES (?, ?, 1, ?)', r.key, r.name, i);
    for (const p of r.perms) {
      run('INSERT OR IGNORE INTO role_permissions (role_key, perm) VALUES (?, ?)', r.key, p);
    }
    for (const [j, d] of r.duties.entries()) {
      run('INSERT INTO role_duties (role_key, text, sort) VALUES (?, ?, ?)', r.key, d, j);
    }
  }
}

/** يقرأ الأدوار من القاعدة (مع زرعها عند أول مرة) ويحفظها مؤقتًا. */
function load() {
  if (cache) return cache;
  if (!get('SELECT 1 FROM roles LIMIT 1')) seedDefaultRoles();

  const rows = all('SELECT * FROM roles ORDER BY sort, key');
  const perms = all('SELECT * FROM role_permissions');
  const duties = all('SELECT * FROM role_duties ORDER BY sort, id');

  cache = new Map();
  for (const r of rows) {
    cache.set(r.key, {
      key: r.key,
      name: r.name,
      description: r.description || '',
      is_system: Boolean(r.is_system),
      is_active: Boolean(r.is_active),
      sort: r.sort,
      perms: new Set(perms.filter((p) => p.role_key === r.key).map((p) => p.perm)),
      duties: duties.filter((d) => d.role_key === r.key).map((d) => d.text),
    });
  }
  return cache;
}

/** كل الأدوار المعرّفة (بما فيها المعطّلة). */
export const allRoles = () => [...load().values()];

/** الأدوار المفعّلة فقط — هي التي تُعرض عند إسناد الفريق. */
export const activeRoles = () => allRoles().filter((r) => r.is_active);

/** مفاتيح الأدوار المفعّلة. */
export const roleKeys = () => activeRoles().map((r) => r.key);

export const roleByKey = (key) => load().get(key) || null;

export const roleName = (key) => load().get(key)?.name || GLOBAL_ROLES[key] || key || '—';

export const roleDuties = (key) => load().get(key)?.duties || [];

/** صلاحيات دور واحد. */
export const rolePerms = (key) => load().get(key)?.perms || new Set();

/** كل الصلاحيات المتاحة للمستخدم ضمن برنامج معيّن (أو عامًا). */
export function permsFor(user, programRoles = []) {
  if (!user) return new Set();
  if (user.global_role === 'admin') return new Set(['*']);
  const set = new Set();
  const roles = new Set(programRoles);
  if (user.global_role && user.global_role !== 'none') roles.add(user.global_role);
  for (const key of roles) {
    const role = load().get(key);
    if (!role || !role.is_active) continue;
    for (const p of role.perms) set.add(p);
  }
  return set;
}

export function can(permSet, perm) {
  return permSet.has('*') || permSet.has(perm);
}
