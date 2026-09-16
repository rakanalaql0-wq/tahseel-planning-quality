import { esc } from '../lib/util.js';
import { roleName } from '../lib/roles.js';

const NAV = [
  ['/', 'لوحتي'],
  ['/programs', 'البرامج'],
  ['/tasks', 'واجباتي'],
  ['/reports', 'التقارير'],
];

const ADMIN_NAV = [
  ['/admin/metric', 'إدارة المقياس'],
  ['/admin/users', 'المستخدمون'],
  ['/admin/audit', 'سجل التدقيق'],
];

/** قالب الصفحة الكامل (RTL عربي). */
export function page({ title, user, active = '', body, notifications = 0, flash = null, wide = false }) {
  const isAdmin = user && (user.global_role === 'admin' || user.global_role === 'quality_manager');
  const nav = [...NAV, ...(isAdmin ? ADMIN_NAV : [])];
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — منصة التخطيط والجودة العلمية</title>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%F0%9F%93%8A%3C/text%3E%3C/svg%3E">
</head>
<body>
${user ? `
<header class="topbar">
  <div class="brand">
    <a href="/"><strong>منصة التخطيط والجودة العلمية</strong><small>جمعية تحصيل المعرفة</small></a>
  </div>
  <nav class="mainnav">
    ${nav.map(([href, label]) => `<a href="${href}" class="${active === href ? 'on' : ''}">${esc(label)}</a>`).join('')}
  </nav>
  <div class="usermenu">
    <a class="bell" href="/notifications" title="التنبيهات">🔔${notifications ? `<span class="dot">${notifications}</span>` : ''}</a>
    <span class="uname">${esc(user.full_name)}<small>${esc(roleName(user.global_role) !== 'مستخدم' ? roleName(user.global_role) : '')}</small></span>
    <form method="post" action="/logout"><button class="btn ghost small">خروج</button></form>
  </div>
</header>` : ''}
<main class="${wide ? 'wide' : ''}">
${flash ? `<div class="flash ${esc(flash.type || 'info')}">${esc(flash.text)}</div>` : ''}
${body}
</main>
<footer class="foot">
  <span>منصة التخطيط والجودة العلمية — الإصدار الأول · مقياس تشغيلي من 300 درجة</span>
  <span>«المستخدم لا يبحث عما يجب عليه فعله؛ النظام يعرض له واجباته».</span>
</footer>
<script src="/app.js" defer></script>
</body>
</html>`;
}

/** صفحة بسيطة بلا شريط تنقّل (تسجيل الدخول / الاستبانة العامة). */
export function bare({ title, body }) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — منصة التخطيط والجودة العلمية</title>
<link rel="stylesheet" href="/app.css">
</head>
<body class="bare">
<main class="narrow">${body}</main>
</body>
</html>`;
}
