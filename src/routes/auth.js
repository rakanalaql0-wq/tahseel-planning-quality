import { bare } from '../views/layout.js';
import { html, setCookie } from '../lib/http.js';
import { esc } from '../lib/util.js';
import {
  findUserByUsername, verifyPassword, createSession, destroySession,
} from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { parseCookies } from '../lib/http.js';
import { get } from '../db/index.js';

const DEMO_ACCOUNTS = [
  ['admin', 'مدير النظام'],
  ['manager', 'مدير التخطيط والجودة'],
  ['officer', 'مسؤول البرنامج'],
  ['supervisor', 'المشرف'],
  ['academic', 'مسؤول التخطيط والجودة العلمية'],
  ['quality', 'مسؤول التخطيط والجودة'],
];

function loginPage({ error = '', next = '/', username = '' } = {}) {
  const showDemo = Boolean(get("SELECT 1 FROM users WHERE username = 'admin'"));
  return bare({
    title: 'تسجيل الدخول',
    body: `<div class="login-card">
      <h1>منصة التخطيط والجودة العلمية</h1>
      <p class="sub">جمعية تحصيل المعرفة — مقياس تشغيلي من 300 درجة</p>
      ${error ? `<div class="flash err">${esc(error)}</div>` : ''}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${esc(next)}">
        <label class="field"><span class="field-label">اسم المستخدم</span>
          <input name="username" value="${esc(username)}" required autofocus autocomplete="username"></label>
        <label class="field"><span class="field-label">كلمة المرور</span>
          <input type="password" name="password" required autocomplete="current-password"></label>
        <button class="btn" style="width:100%">دخول</button>
      </form>
      ${showDemo ? `<div class="demo-list">
        <strong>حسابات العرض التجريبي:</strong>
        <ul class="duties">${DEMO_ACCOUNTS.map(([u, r]) => `<li><code>${u}</code> — ${esc(r)}</li>`).join('')}</ul>
        كلمة المرور الافتراضية للجميع: <code>Tahseel@2026</code>
      </div>` : ''}
    </div>`,
  });
}

export default function register(router) {
  router.get('/login', (ctx) => {
    if (ctx.user) { ctx.redirect('/'); return; }
    html(ctx.res, loginPage({ next: ctx.query.next || '/' }));
  });

  router.post('/login', (ctx) => {
    const { username = '', password = '', next = '/' } = ctx.body;
    const user = findUserByUsername(username);
    const safeNext = String(next).startsWith('/') ? String(next) : '/';
    if (!user || !user.is_active || !verifyPassword(password, user.password_hash, user.password_salt)) {
      audit({ user: null, action: 'login.failed', entityType: 'user', entityId: user?.id ?? null, ip: ctx.ip, after: { username } });
      html(ctx.res, loginPage({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.', next: safeNext, username }), 401);
      return;
    }
    const token = createSession(user.id, ctx.req.headers['user-agent']);
    setCookie(ctx.res, 'tpq_session', token, { maxAge: 7 * 24 * 3600 });
    audit({ user, action: 'login', entityType: 'user', entityId: user.id, ip: ctx.ip });
    ctx.redirect(safeNext, `أهلًا بك، ${user.full_name}.`);
  });

  router.post('/logout', (ctx) => {
    const cookies = parseCookies(ctx.req.headers.cookie);
    if (ctx.user) audit({ user: ctx.user, action: 'logout', entityType: 'user', entityId: ctx.user.id, ip: ctx.ip });
    destroySession(cookies.tpq_session);
    setCookie(ctx.res, 'tpq_session', '', { maxAge: 0 });
    ctx.redirect('/login');
  });
}
