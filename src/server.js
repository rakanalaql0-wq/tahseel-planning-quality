import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { getDb, ROOT } from './db/index.js';
import { seedAll } from './db/seed.js';
import { userFromToken, cleanupSessions } from './lib/auth.js';
import { get } from './db/index.js';
import {
  Router, readBody, parseForm, parseMultipart, parseCookies, setCookie, send, html, redirect,
} from './lib/http.js';
import { page } from './views/layout.js';
import { esc } from './lib/util.js';
import { refreshNotifications } from './lib/scheduler.js';

import registerAuth from './routes/auth.js';
import registerDashboard from './routes/dashboard.js';
import registerPrograms from './routes/programs.js';
import registerSurveys from './routes/surveys.js';
import registerEvidence from './routes/evidence.js';
import registerReports from './routes/reports.js';
import registerAdmin from './routes/admin.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const router = new Router();
for (const register of [
  registerAuth, registerDashboard, registerPrograms, registerSurveys,
  registerEvidence, registerReports, registerAdmin,
]) register(router);

/** المسارات المتاحة دون تسجيل دخول. */
const PUBLIC_PATHS = [/^\/login$/, /^\/s\/[^/]+$/, /^\/health$/];

async function serveStatic(pathname, res) {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return false;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    const data = await readFile(file);
    send(res, 200, data, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=300',
    });
    return true;
  } catch {
    return false;
  }
}

function errorPage(res, status, message, user) {
  const body = `<div class="panel"><div class="panel-body">
    <h1>${status === 404 ? 'الصفحة غير موجودة' : status === 403 ? 'لا تملك صلاحية' : 'حدث خطأ'}</h1>
    <p class="muted">${esc(message)}</p>
    <p><a class="btn sec" href="/">العودة إلى لوحتي</a></p>
  </div></div>`;
  html(res, page({ title: `خطأ ${status}`, user, body }), status);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && await serveStatic(pathname, res)) return;
  if (pathname === '/health') { send(res, 200, 'ok', { 'Content-Type': 'text/plain' }); return; }

  const cookies = parseCookies(req.headers.cookie);
  const user = userFromToken(cookies.tpq_session);

  // رسالة عابرة (flash) محفوظة في كوكي قصير العمر
  let flash = null;
  if (cookies.tpq_flash) {
    const idx = cookies.tpq_flash.indexOf('|');
    flash = { type: cookies.tpq_flash.slice(0, idx), text: cookies.tpq_flash.slice(idx + 1) };
    setCookie(res, 'tpq_flash', '', { maxAge: 0 });
  }

  const isPublic = PUBLIC_PATHS.some((re) => re.test(pathname));
  if (!user && !isPublic) {
    redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return;
  }

  const match = router.match(req.method, pathname);
  if (!match) { errorPage(res, 404, 'المسار المطلوب غير متاح.', user); return; }

  let body = {};
  let files = [];
  if (req.method === 'POST') {
    const raw = await readBody(req);
    const ctype = String(req.headers['content-type'] || '');
    if (ctype.includes('multipart/form-data')) {
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
      const parsed = parseMultipart(raw, (boundary?.[1] || boundary?.[2] || '').trim());
      body = parsed.fields;
      files = parsed.files;
    } else {
      body = parseForm(raw.toString('utf8'));
    }
  }

  const notifCount = user
    ? Number(get('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0', user.id)?.c || 0)
    : 0;

  const ctx = {
    req, res, url, user, body, files, flash, notifCount,
    params: match.params,
    query: Object.fromEntries(url.searchParams),
    ip: req.socket.remoteAddress,
    render(title, pageBody, opts = {}) {
      html(res, page({ title, user, body: pageBody, notifications: notifCount, flash, ...opts }));
    },
    redirect(to, message = null, type = 'ok') {
      if (message) setCookie(res, 'tpq_flash', `${type}|${message}`, { maxAge: 20 });
      redirect(res, to);
    },
    deny(message = 'لا تملك صلاحية تنفيذ هذا الإجراء.') { errorPage(res, 403, message, user); },
    notFound(message = 'السجل المطلوب غير موجود.') { errorPage(res, 404, message, user); },
  };

  await match.handler(ctx);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('[خطأ]', err);
    if (!res.headersSent) errorPage(res, status, err.message || 'خطأ غير متوقع.', null);
  });
});

// تهيئة أولية عند التشغيل
getDb();
if (!get('SELECT 1 FROM metric_sections LIMIT 1')) {
  console.log('لا توجد بنية مقياس — جارٍ التهيئة الأولية...');
  seedAll({ demo: process.env.TPQ_DEMO !== '0' });
}
cleanupSessions();

// تحديث التنبيهات دوريًا (كل 30 دقيقة) وعند الإقلاع
try { refreshNotifications(); } catch (err) { console.error('تعذر تحديث التنبيهات:', err.message); }
const timer = setInterval(() => {
  try { refreshNotifications(); cleanupSessions(); } catch (err) { console.error(err.message); }
}, 30 * 60 * 1000);
timer.unref();

server.listen(PORT, HOST, () => {
  console.log(`منصة التخطيط والجودة العلمية تعمل على http://localhost:${PORT}`);
});

export { server, handle };
