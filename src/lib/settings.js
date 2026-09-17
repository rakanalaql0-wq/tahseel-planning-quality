import { get, run } from '../db/index.js';

/**
 * إعدادات النظام القابلة للتعديل من شاشة الإدارة.
 *
 * قاعدة: لا يُعرض في الشاشة إعداد لا يقرأه الكود فعلًا — فالإعداد المعطّل
 * أسوأ من غيابه، لأن المستخدم يظن أنه غيّر سلوك النظام وهو لم يتغيّر.
 */
export const SETTINGS = [
  {
    key: 'org_name',
    label: 'اسم الجمعية',
    hint: 'يظهر في ترويسة المنصة والموقع العام وتذييل التقارير.',
    type: 'text',
    fallback: 'جمعية تحصيل المعرفة',
  },
  {
    key: 'min_response_rate',
    label: 'الحد الأدنى لنسبة الاستجابة في الاستبانات (%)',
    hint: 'أقل من هذه النسبة تُوسم الاستبانة «عينة غير كافية» ولا تُحتسب في اكتمال القياس.',
    type: 'number', min: 0, max: 100,
    fallback: '70',
  },
  {
    key: 'default_sla_days',
    label: 'المدة الافتراضية لمعالجة الشكوى (أيام)',
    hint: 'القيمة المقترحة عند تسجيل شكوى جديدة، وتُحتسب عليها مؤشر الالتزام بالمدة.',
    type: 'number', min: 1, max: 60,
    fallback: '5',
  },
];

const DEFAULTS = new Map(SETTINGS.map((s) => [s.key, s.fallback]));

/** قيمة إعداد نصية. */
export function setting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  const value = row?.value;
  return value === undefined || value === null || value === '' ? (DEFAULTS.get(key) ?? null) : value;
}

/** قيمة إعداد رقمية، مع حدّ أدنى وأعلى من تعريف الإعداد. */
export function settingNum(key) {
  const def = SETTINGS.find((s) => s.key === key);
  const n = Number(setting(key));
  if (!Number.isFinite(n)) return Number(def?.fallback ?? 0);
  if (def?.min !== undefined && n < def.min) return def.min;
  if (def?.max !== undefined && n > def.max) return def.max;
  return n;
}

/** يحفظ إعدادًا معروفًا فقط — ولا يقبل مفتاحًا مخترعًا من النموذج. */
export function setSetting(key, value) {
  if (!DEFAULTS.has(key)) return false;
  run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  key, String(value));
  return true;
}
