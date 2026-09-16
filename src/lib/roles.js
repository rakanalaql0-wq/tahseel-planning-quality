/**
 * الأدوار والصلاحيات (RBAC) — البند 3 من وثيقة التحليل.
 * مبدأ الصلاحية الحاكم: «عرض المهام المرتبطة بالدور فقط، مع حقول حسب الصلاحية».
 */

export const ROLES = {
  program_officer: {
    key: 'program_officer',
    name: 'مسؤول البرنامج',
    duties: [
      'تسجيل بيانات البرنامج وعدد اللقاءات والطلاب عند البداية.',
      'تنفيذ/تنسيق تحقق البيئة والمرافق مع المشرف وفق الدوريات المحددة.',
      'متابعة الحضور والانضباط والحالات المتعثرة وتوثيق الإجراءات.',
      'متابعة الشكاوى والمقترحات ومعالجتها ضمن المدة المعتمدة.',
      'احتساب الاستمرارية الفعلية في نهاية البرنامج وتوثيق الانسحابات.',
    ],
  },
  supervisor: {
    key: 'supervisor',
    name: 'المشرف',
    duties: [
      'تنفيذ قوائم تحقق القاعات والمرافق عند التكليف أو وفق خطة العينة.',
      'التحقق من تهيئة القاعات قبل بدء الدروس ضمن عينة لا تقل عن 50% من اللقاءات.',
      'توثيق الملاحظات والشواهد والإجراءات التصحيحية المرتبطة بالبيئة.',
    ],
  },
  academic_quality: {
    key: 'academic_quality',
    name: 'مسؤول التخطيط والجودة العلمية',
    duties: [
      'التحقق من مناسبة المعلم عبر وثائق أو تزكية معتبرة.',
      'مراجعة جودة وسلامة المحتوى العلمي ومناسبته للفئة.',
      'متابعة تنفيذ المحتوى المقرر والالتزام بالتسلسل والتوقيت.',
      'متابعة الأنشطة والتطبيقات الإثرائية وقياس فاعلية الأنشطة الرئيسة.',
      'تنفيذ/إدارة تقييم المعلم في منتصف البرنامج ونهايته.',
      'التحقق من وضوح الأهداف والمخرجات والجدول الزمني قبل بدء البرنامج.',
      'توثيق نتيجة التحقق وإحالة أي قصور إلى مسؤول البرنامج أو الجهة المعنية.',
    ],
  },
  quality_officer: {
    key: 'quality_officer',
    name: 'مسؤول التخطيط والجودة',
    duties: [
      'إدارة استبانة الدعم والإرشاد والتواصل في منتصف البرنامج ونهايته.',
      'إدارة استبانة الرضا والانتماء والتوصية والرغبة في الاستمرار في النهاية.',
      'تحليل نتائج تجربة الطالب ورفع الملاحظات ذات الأولوية للتحسين.',
    ],
  },
  quality_manager: {
    key: 'quality_manager',
    name: 'مدير التخطيط والجودة',
    duties: [
      'الإشراف على سلامة تطبيق النظام واكتمال القياسات.',
      'التحقق النهائي في نهاية البرنامج من إغلاق الشكاوى واستكمال توثيقها.',
      'قراءة لوحة المؤشرات ومتابعة الإجراءات التصحيحية والتحسينية.',
      'اعتماد التقارير النهائية وقيادة التحسينات المستقبلية للنظام.',
    ],
  },
};

export const ROLE_KEYS = Object.keys(ROLES);

export const GLOBAL_ROLES = {
  admin: 'مدير النظام',
  quality_manager: 'مدير التخطيط والجودة',
  none: 'مستخدم',
};

export const roleName = (key) => ROLES[key]?.name || GLOBAL_ROLES[key] || key || '—';

/**
 * الصلاحيات المتاحة لكل دور.
 * القراءة على مستوى البرنامج مسموحة لكل مسند إليه، والكتابة مقيدة بالدور.
 */
const PERMS = {
  program_officer: [
    'program.read', 'program.edit', 'program.close',
    'session.manage', 'student.manage', 'attendance.manage',
    'task.do.environment', 'complaint.manage', 'discipline.manage',
    'continuity.manage', 'action.manage', 'evidence.upload', 'report.read',
  ],
  supervisor: [
    'program.read', 'task.do.environment', 'evidence.upload',
    'action.manage', 'report.read',
  ],
  academic_quality: [
    'program.read', 'teacher.verify', 'content.review', 'plan.review',
    'activity.manage', 'task.do.academic', 'survey.manage.teacher',
    'evidence.upload', 'action.manage', 'report.read',
  ],
  quality_officer: [
    'program.read', 'survey.manage.experience', 'survey.analyze',
    'task.do.survey', 'evidence.upload', 'action.manage', 'report.read',
  ],
  quality_manager: [
    'program.read', 'program.create', 'program.assign', 'program.close',
    'complaint.verify', 'metric.read', 'action.manage', 'report.read',
    'report.approve', 'audit.read', 'survey.analyze',
  ],
  admin: ['*'],
};

/** كل الصلاحيات المتاحة للمستخدم ضمن برنامج معيّن (أو عامًا). */
export function permsFor(user, programRoles = []) {
  if (!user) return new Set();
  if (user.global_role === 'admin') return new Set(['*']);
  const set = new Set();
  const roles = new Set(programRoles);
  if (user.global_role && user.global_role !== 'none') roles.add(user.global_role);
  for (const r of roles) for (const p of PERMS[r] || []) set.add(p);
  return set;
}

export function can(permSet, perm) {
  return permSet.has('*') || permSet.has(perm);
}
