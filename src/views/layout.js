import { esc } from '../lib/util.js';
import { roleName } from '../lib/roles.js';
import { icon, logoMark } from './icons.js';

const ORG = 'جمعية تحصيل المعرفة';
const APP = 'منصة التخطيط والجودة العلمية';

const NAV = [
  ['/app', 'لوحتي', 'home'],
  ['/programs', 'البرامج', 'programs'],
  ['/tasks', 'واجباتي', 'tasks'],
  ['/reports', 'التقارير', 'reports'],
];

const ADMIN_NAV = [
  ['/admin/metric', 'إدارة المقياس', 'metric'],
  ['/admin/users', 'المستخدمون', 'users'],
  ['/admin/audit', 'سجل التدقيق', 'audit'],
];

/** ترويسة HTML المشتركة (خطوط + أيقونة التبويب). */
function head(title) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1F4E4B">
<title>${esc(title)} — ${esc(APP)}</title>
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap">
<link rel="stylesheet" href="/app.css">`;
}

/** قالب الصفحة الداخلية (بعد تسجيل الدخول). */
export function page({ title, user, active = '', body, notifications = 0, flash = null, wide = false }) {
  const isAdmin = user && (user.global_role === 'admin' || user.global_role === 'quality_manager');
  const nav = [...NAV, ...(isAdmin ? ADMIN_NAV : [])];
  const roleLabel = user && roleName(user.global_role) !== 'مستخدم' ? roleName(user.global_role) : '';

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>${head(title)}</head>
<body>
${user ? `
<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="/app">
      ${logoMark(36)}
      <span class="brand-text"><strong>${esc(APP)}</strong><small>${esc(ORG)}</small></span>
    </a>
    <button class="navtoggle" type="button" aria-label="القائمة" aria-expanded="false" data-nav-toggle>
      ${icon('menu', { size: 20 })}
    </button>
    <nav class="mainnav" id="mainnav">
      ${nav.map(([href, label, ico]) =>
    `<a href="${href}" class="${active === href ? 'on' : ''}">${icon(ico, { size: 16 })}<span>${esc(label)}</span></a>`).join('')}
    </nav>
    <div class="usermenu">
      <a class="bell" href="/notifications" title="التنبيهات" aria-label="التنبيهات">
        ${icon('bell', { size: 18 })}${notifications ? `<span class="dot">${notifications}</span>` : ''}
      </a>
      <span class="uname">${esc(user.full_name)}${roleLabel ? `<small>${esc(roleLabel)}</small>` : ''}</span>
      <form method="post" action="/logout">
        <button class="btn ghost small" title="تسجيل الخروج">${icon('logout', { size: 15 })}<span>خروج</span></button>
      </form>
    </div>
  </div>
</header>` : ''}
<main class="${wide ? 'wide' : ''}">
${flash ? `<div class="flash ${esc(flash.type || 'info')}">${icon(flash.type === 'err' ? 'alert' : 'check', { size: 17 })}<span>${esc(flash.text)}</span></div>` : ''}
${body}
</main>
<footer class="foot"><div class="foot-in">
  <span>${esc(APP)} — ${esc(ORG)} · مقياس تشغيلي من 300 درجة</span>
  <span>«المستخدم لا يبحث عما يجب عليه فعله؛ النظام يعرض له واجباته».</span>
</div></footer>
<script src="/app.js" defer></script>
</body>
</html>`;
}

/** صفحة مستقلة بلا شريط تنقّل (تسجيل الدخول / استبانة الطالب). */
export function bare({ title, body }) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>${head(title)}</head>
<body class="bare">
<main class="narrow">${body}</main>
<script src="/app.js" defer></script>
</body>
</html>`;
}

/** قالب الموقع العام (بلا تسجيل دخول). */
export function publicPage({ title, body, active = '', user = null }) {
  const links = [
    ['/', 'الرئيسية'],
    ['/about', 'عن الجمعية'],
    ['/programs-public', 'البرامج'],
    ['/activities-public', 'الأنشطة'],
    ['/reports-public', 'التقارير العامة'],
  ];
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>${head(title)}</head>
<body>
<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="/">
      ${logoMark(36)}
      <span class="brand-text"><strong>${esc(ORG)}</strong><small>${esc(APP)}</small></span>
    </a>
    <button class="navtoggle" type="button" aria-label="القائمة" aria-expanded="false" data-nav-toggle>
      ${icon('menu', { size: 20 })}
    </button>
    <nav class="mainnav" id="mainnav">
      ${links.map(([href, label]) =>
    `<a href="${href}" class="${active === href ? 'on' : ''}">${esc(label)}</a>`).join('')}
    </nav>
    <div class="usermenu">
      ${user
    ? `<a class="btn ghost small" href="/app">${icon('home', { size: 15 })}<span>لوحتي</span></a>`
    : `<a class="btn ghost small" href="/login">${icon('login', { size: 15 })}<span>دخول المنسوبين</span></a>`}
    </div>
  </div>
</header>
${body}
<footer class="pubfoot">
  <div class="pubfoot-in">
    <div>
      <h4>${esc(ORG)}</h4>
      <p style="font-size:.84rem;opacity:.85;max-width:38ch">
        جمعية أهلية مرخّصة تُعنى ببرامج تحصيل المعرفة وتطبق مقياس جودة تعليمية تشغيليًا من 300 درجة
        على كل برنامج، بقياس موثّق وشواهد ومراجعة مستقلة.
      </p>
      <p style="font-size:.8rem;opacity:.75;margin-top:.5rem">رقم الترخيص 1000571500</p>
    </div>
    <div>
      <h4>روابط</h4>
      ${links.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('')}
    </div>
    <div>
      <h4>منسوبو الجمعية</h4>
      <a href="/login">تسجيل الدخول للمنصة</a>
      <a href="/reports-public">مؤشرات الجودة المعلنة</a>
    </div>
  </div>
  <div class="copy">© ${new Date().getFullYear()} ${esc(ORG)} — جميع الحقوق محفوظة</div>
</footer>
<script src="/app.js" defer></script>
</body>
</html>`;
}
