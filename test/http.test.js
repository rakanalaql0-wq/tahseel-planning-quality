import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 3456 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'tpq-test-'));
let child;

function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) return resolve();
      } catch { /* لم يبدأ بعد */ }
      if (Date.now() > deadline) return reject(new Error('تعذر تشغيل الخادم'));
      setTimeout(tick, 150);
      return undefined;
    };
    tick();
  });
}

before(async () => {
  child = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TPQ_DB: join(dataDir, 'test.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => { if (String(d).includes('خطأ')) console.error(String(d)); });
  await waitForServer();
});

after(() => {
  child?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

/** يسجّل الدخول ويعيد كوكي الجلسة. */
async function login(username, password = 'Tahseel@2026') {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
    redirect: 'manual',
  });
  assert.equal(res.status, 302, `فشل دخول ${username}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('tpq_session='));
  assert.ok(cookie, 'لم تُنشأ جلسة');
  return cookie.split(';')[0];
}

const fetchAs = (cookie, path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { Cookie: cookie, ...(init.headers || {}) }, redirect: 'manual' });

test('يمنع الوصول دون تسجيل دخول ويعيد التوجيه إلى صفحة الدخول', async () => {
  const res = await fetch(`${BASE}/programs`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login/);
});

test('يرفض كلمة المرور الخاطئة', async () => {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
    redirect: 'manual',
  });
  assert.equal(res.status, 401);
});

test('كل شاشات البرنامج تُفتح لمدير النظام', async () => {
  const cookie = await login('admin');
  const tabs = ['', '/metric', '/sessions', '/students', '/attendance', '/plan', '/teachers',
    '/activities', '/surveys', '/complaints', '/discipline', '/continuity', '/actions',
    '/team', '/audit', '/close'];
  for (const tab of tabs) {
    const res = await fetchAs(cookie, `/programs/1${tab}`);
    assert.equal(res.status, 200, `فشل فتح /programs/1${tab}`);
    const body = await res.text();
    assert.match(body, /dir="rtl"/, 'الواجهة يجب أن تكون RTL');
  }
  for (const path of ['/', '/tasks', '/reports', '/notifications', '/admin/metric', '/admin/users', '/admin/audit']) {
    const res = await fetchAs(cookie, path);
    assert.equal(res.status, 200, `فشل فتح ${path}`);
  }
});

test('إجمالي المقياس يظهر 300 درجة في شاشة إدارة المقياس', async () => {
  const cookie = await login('manager');
  const body = await (await fetchAs(cookie, '/admin/metric')).text();
  assert.match(body, /إجمالي أوزان المؤشرات/);
  assert.match(body, /300/);
  assert.doesNotMatch(body, /تحذير: مجموع أوزان المؤشرات/);
});

test('كل دور يرى مهامه فقط', async () => {
  const supervisor = await login('supervisor');
  const body = await (await fetchAs(supervisor, '/tasks')).text();
  assert.match(body, /تهيئة القاعة|جاهزية التجهيزات|سلامة المرافق/, 'المشرف يرى مهام البيئة');
  assert.doesNotMatch(body, /مناسبة المعلم/, 'المشرف لا يرى مهام الجودة العلمية');

  const academic = await login('academic');
  const academicBody = await (await fetchAs(academic, '/tasks')).text();
  assert.match(academicBody, /المحتوى العلمي|مناسبة المعلم/);
  assert.doesNotMatch(academicBody, /الضيافة/);
});

test('المشرف لا يملك صلاحية إنشاء برنامج', async () => {
  const cookie = await login('supervisor');
  const res = await fetchAs(cookie, '/programs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'برنامج غير مصرح', start_date: '2026-01-01', end_date: '2026-02-01' }),
  });
  assert.equal(res.status, 403);
});

test('BR-04: يُرفض اعتماد التحقق دون ملاحظة عند «غير متحقق»', async () => {
  const cookie = await login('supervisor');
  const tasksBody = await (await fetchAs(cookie, '/tasks')).text();
  const taskId = /href="\/tasks\/(\d+)"/.exec(tasksBody)?.[1];
  assert.ok(taskId, 'لا توجد مهمة للمشرف');

  const formBody = await (await fetchAs(cookie, `/tasks/${taskId}`)).text();
  const itemIds = [...formBody.matchAll(/name="state_(\d+)"/g)].map((m) => m[1]);
  assert.ok(itemIds.length > 0, 'قائمة التحقق فارغة');

  const params = new URLSearchParams();
  for (const id of [...new Set(itemIds)]) params.set(`state_${id}`, '100');
  params.set(`state_${[...new Set(itemIds)][0]}`, '0'); // غير متحقق بلا ملاحظة

  const res = await fetchAs(cookie, `/tasks/${taskId}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  assert.equal(res.status, 302);
  const flash = res.headers.getSetCookie().find((c) => c.startsWith('tpq_flash='));
  assert.match(decodeURIComponent(flash || ''), /BR-04|الملاحظة إلزامية/);
});

test('اعتماد التحقق يحسب النتيجة وينشئ إجراءً تصحيحيًا وشاهد تدقيق', async () => {
  const cookie = await login('supervisor');
  const tasksBody = await (await fetchAs(cookie, '/tasks')).text();
  const taskId = /href="\/tasks\/(\d+)"/.exec(tasksBody)[1];
  const formBody = await (await fetchAs(cookie, `/tasks/${taskId}`)).text();
  const itemIds = [...new Set([...formBody.matchAll(/name="state_(\d+)"/g)].map((m) => m[1]))];

  const params = new URLSearchParams();
  itemIds.forEach((id, i) => {
    params.set(`state_${id}`, i === 0 ? '0' : '100');
    if (i === 0) params.set(`note_${id}`, 'المكيف غير صالح ويحتاج صيانة عاجلة');
  });
  params.set('auto_action', '1');

  const res = await fetchAs(cookie, `/tasks/${taskId}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/verifications\/\d+$/);

  const detail = await (await fetchAs(cookie, res.headers.get('location'))).text();
  assert.match(detail, /غير متحقق/);
  assert.match(detail, /المكيف غير صالح/);

  const actions = await (await fetchAs(cookie, '/programs/1/actions')).text();
  assert.match(actions, /معالجة:/, 'يجب إنشاء إجراء تصحيحي تلقائيًا');

  const admin = await login('admin');
  const audit = await (await fetchAs(admin, '/admin/audit')).text();
  assert.match(audit, /verification.submit/);
});

test('دورة الاستبانة: توليد، فتح، تعبئة عامة، إغلاق واحتساب النتيجة', async () => {
  const cookie = await login('quality');
  const surveysBody = await (await fetchAs(cookie, '/programs/1/surveys')).text();
  const taskId = /name="task_id" value="(\d+)"/.exec(surveysBody)?.[1];
  assert.ok(taskId, 'لا توجد استبانة مجدولة');

  const created = await fetchAs(cookie, '/surveys/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ task_id: taskId }),
  });
  const surveyPath = created.headers.get('location');
  assert.match(surveyPath, /^\/surveys\/\d+$/);

  await fetchAs(cookie, `${surveyPath}/open`, { method: 'POST' });
  const page = await (await fetchAs(cookie, surveyPath)).text();
  const token = /\/s\/([A-Za-z0-9_-]+)/.exec(page)?.[1];
  assert.ok(token, 'لم يُنشأ رابط التوزيع');

  // الصفحة العامة متاحة دون تسجيل دخول
  const publicPage = await fetch(`${BASE}/s/${token}`);
  assert.equal(publicPage.status, 200);
  const publicBody = await publicPage.text();
  const qIds = [...new Set([...publicBody.matchAll(/name="q_(\d+)"/g)].map((m) => m[1]))];
  assert.ok(qIds.length >= 3, 'الاستبانة يجب أن تحتوي أسئلة من مكتبة الأسئلة');

  for (const value of ['5', '3']) {
    const answers = new URLSearchParams();
    for (const q of qIds) answers.set(`q_${q}`, value);
    const submitted = await fetch(`${BASE}/s/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: answers,
    });
    assert.equal(submitted.status, 200);
    assert.match(await submitted.text(), /شكرًا لك/);
  }

  const closed = await fetchAs(cookie, `${surveyPath}/close`, { method: 'POST' });
  const flash = decodeURIComponent(closed.headers.getSetCookie().find((c) => c.startsWith('tpq_flash=')) || '');
  assert.match(flash, /75/, 'المتوسط 4 يعطي 75% وفق BR-03');
});

test('المنصة تمنع الإقفال مع وجود نواقص وتعرضها بوضوح', async () => {
  const cookie = await login('officer');
  const closeBody = await (await fetchAs(cookie, '/programs/1/close')).text();
  assert.match(closeBody, /القياسات الناقصة/);
  assert.match(closeBody, /الشكاوى غير المغلقة/);

  const res = await fetchAs(cookie, '/programs/1/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ note: 'محاولة إقفال' }),
  });
  assert.equal(res.status, 302);
  const flash = decodeURIComponent(res.headers.getSetCookie().find((c) => c.startsWith('tpq_flash=')) || '');
  assert.match(flash, /لا يمكن الإقفال/);
});

test('تصدير تقرير البرنامج إلى Excel بترميز عربي سليم', async () => {
  const cookie = await login('manager');
  const res = await fetchAs(cookie, '/reports/program/1/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  // fetch().text() يحذف BOM تلقائيًا، لذا نفحص البايتات الخام
  const bytes = new Uint8Array(await res.clone().arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xEF, 0xBB, 0xBF],
    'يجب أن يبدأ الملف بـ BOM ليفتح صحيحًا في Excel العربي');
  const text = await res.text();
  assert.match(text, /الدرجة من 300/);
  assert.match(text, /تهيئة القاعة/);
});

test('لا يمكن الوصول لبرنامج غير مسند للمستخدم', async () => {
  const admin = await login('admin');
  await fetchAs(admin, '/programs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      name: 'برنامج مغلق الصلاحية', code: 'PRG-SEC', start_date: '2026-03-01',
      end_date: '2026-04-01', planned_sessions: '4',
    }),
  });
  const supervisor = await login('supervisor');
  const res = await fetchAs(supervisor, '/programs/2');
  assert.equal(res.status, 403);
});

test('الخروج يبطل الجلسة', async () => {
  const cookie = await login('officer');
  await fetchAs(cookie, '/logout', { method: 'POST' });
  const res = await fetchAs(cookie, '/programs');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login/);
});
