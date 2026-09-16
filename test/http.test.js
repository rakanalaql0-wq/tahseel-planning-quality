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
    '/activities', '/surveys', '/impact', '/complaints', '/discipline', '/continuity', '/actions',
    '/team', '/audit', '/close'];
  for (const tab of tabs) {
    const res = await fetchAs(cookie, `/programs/1${tab}`);
    assert.equal(res.status, 200, `فشل فتح /programs/1${tab}`);
    const body = await res.text();
    assert.match(body, /dir="rtl"/, 'الواجهة يجب أن تكون RTL');
  }
  for (const path of ['/app', '/tasks', '/reports', '/notifications', '/admin/metric', '/admin/users', '/admin/audit']) {
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
  assert.match(body, /تهيئة القاعة|جاهزية التجهيزات|ملاءمة القاعة|نظافة القاعات/, 'المشرف يرى مهام البيئة');
  assert.doesNotMatch(body, /مناسبة المعلم|الزيارة الصفية/, 'المشرف لا يرى مهام الجودة العلمية');

  const academic = await login('academic');
  const academicBody = await (await fetchAs(academic, '/tasks')).text();
  assert.match(academicBody, /المحتوى العلمي|مناسبة المعلم|الزيارة الصفية/);
  assert.doesNotMatch(academicBody, /الضيافة|نظافة القاعات/);
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

test('دورة الاستبانة: توليد، فتح بروابط فردية، تعبئة، إغلاق واحتساب النتيجة', async () => {
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

  // رابط عام واحد لم يعد موجودًا — بدلًا منه رابط فردي لكل طالب
  const tokens = [...new Set([...page.matchAll(/\/r\/([A-Za-z0-9_-]{10,})/g)].map((m) => m[1]))];
  assert.ok(tokens.length >= 20, `يجب توليد رابط لكل طالب نشط، وُلّد ${tokens.length}`);

  const fill = async (tok) => {
    const form = await fetch(`${BASE}/r/${tok}`);
    assert.equal(form.status, 200);
    const formBody = await form.text();
    const qIds = [...new Set([...formBody.matchAll(/name="q_(\d+)"/g)].map((m) => m[1]))];
    assert.ok(qIds.length >= 3, 'الاستبانة يجب أن تحتوي أسئلة من مكتبة الأسئلة');
    const answers = new URLSearchParams();
    for (const q of qIds) answers.set(`q_${q}`, '4'); // المتوسط 4 ⇒ 75% وفق BR-03
    return fetch(`${BASE}/r/${tok}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: answers,
    });
  };

  const first = await fill(tokens[0]);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /شكرًا لك/);

  // الرابط يُستخدم مرة واحدة فقط
  const repeat = await fetch(`${BASE}/r/${tokens[0]}`);
  assert.match(await repeat.text(), /سبق أن أجبت/);

  // استجابة واحدة من 22 = عينة غير كافية
  const weak = await (await fetchAs(cookie, surveyPath)).text();
  assert.match(weak, /عينة غير كافية/);

  // تعبئة ما يكفي لتجاوز 70%
  const needed = Math.ceil(tokens.length * 0.7);
  for (const tok of tokens.slice(1, needed)) await fill(tok);
  const strong = await (await fetchAs(cookie, surveyPath)).text();
  assert.match(strong, /عينة كافية/);
  assert.doesNotMatch(strong, /عينة غير كافية/);

  const closed = await fetchAs(cookie, `${surveyPath}/close`, { method: 'POST' });
  const flash = decodeURIComponent(closed.headers.getSetCookie().find((c) => c.startsWith('tpq_flash=')) || '');
  assert.match(flash, /75/, 'المتوسط 4 يعطي 75% وفق BR-03');
});

test('رابط استبانة غير صحيح يُرفض', async () => {
  const res = await fetch(`${BASE}/r/not-a-real-token`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /الرابط غير صحيح/);
});

test('قياس الأثر: إضافة أداة وإدخال الدرجات دون المساس بمقياس الـ300', async () => {
  const cookie = await login('academic');
  const before = await (await fetchAs(cookie, '/programs/1/metric')).text();
  const beforeScore = /الدرجة من 300<\/div>/.test(before) ? before : before;

  const created = await fetchAs(cookie, '/programs/1/impact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      name: 'اختبار عملي للتلاوة', kind: 'practical', max_score: '20',
      mastery_pct: '75', applied_at: '2026-09-01',
    }),
  });
  assert.equal(created.status, 302);
  const toolPath = created.headers.get('location');
  assert.match(toolPath, /^\/impact\/tool\/\d+$/);

  const toolPage = await (await fetchAs(cookie, toolPath)).text();
  const studentIds = [...new Set([...toolPage.matchAll(/name="score_(\d+)"/g)].map((m) => m[1]))];
  assert.ok(studentIds.length > 0, 'شاشة إدخال الدرجات تعرض الطلاب');

  const scores = new URLSearchParams();
  studentIds.forEach((id, i) => scores.set(`score_${id}`, i % 2 === 0 ? '18' : '12'));
  const saved = await fetchAs(cookie, `${toolPath}/results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: scores,
  });
  assert.equal(saved.status, 302);

  const impactPage = await (await fetchAs(cookie, '/programs/1/impact')).text();
  assert.match(impactPage, /مكسب التعلم المعياري/);
  assert.match(impactPage, /مستقل تمامًا عن مقياس الجودة/);

  // مقياس الـ300 لم يتأثر: لا يظهر أي مؤشر أثر في شجرة المقياس
  const after = await (await fetchAs(cookie, '/programs/1/metric')).text();
  assert.doesNotMatch(after, /اختبار عملي للتلاوة/, 'قياس الأثر لا يظهر داخل شجرة المقياس');
  assert.equal(after.includes('/ 300'), beforeScore.includes('/ 300'));
});

test('تصدير قياس الأثر منفصل عن تقرير المقياس', async () => {
  const cookie = await login('manager');
  const res = await fetchAs(cookie, '/programs/1/impact.csv');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /مستقل عن مقياس الجودة/);
  assert.match(text, /مكسب التعلم المعياري/);
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
  assert.match(text, /الدرجة المعيارية من 300/);
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

test('«غير منطبق»: وسم مؤشر يخرجه من المقياس، وإعادة تطبيقه تعيده', async () => {
  const manager = await login('manager');

  const before = await (await fetchAs(manager, '/programs/1/close')).text();
  assert.match(before, /الضيافة والخدمات المساندة/, 'المؤشر يظهر كقياس ناقص قبل الوسم');

  const metric = await (await fetchAs(manager, '/programs/1/metric')).text();
  const option = /<option value="(\d+)">[^<]*الضيافة والخدمات المساندة[^<]*<\/option>/.exec(metric);
  assert.ok(option, 'المؤشر متاح للوسم في قائمة الاختيار');

  const res = await fetchAs(manager, '/programs/1/exemptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ indicator_id: option[1], reason: 'لا تُقدَّم ضيافة في هذا الفوج' }),
  });
  assert.equal(res.status, 302);

  const after = await (await fetchAs(manager, '/programs/1/metric')).text();
  assert.match(after, /غير منطبق/);
  assert.match(after, /لا تُقدَّم ضيافة في هذا الفوج/);
  assert.match(after, /الدرجة المعيارية من 300/);
  assert.match(after, /وزن مستثنى/);

  // لم يعد يمنع الإقفال
  const close = await (await fetchAs(manager, '/programs/1/close')).text();
  assert.doesNotMatch(close, /الضيافة والخدمات المساندة —/, 'اختفى من قائمة القياسات الناقصة');

  // إعادة التطبيق تعيد المؤشر إلى المقياس
  const back = await fetchAs(manager, '/programs/1/exemptions/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ indicator_id: option[1] }),
  });
  assert.equal(back.status, 302);
  const restored = await (await fetchAs(manager, '/programs/1/metric')).text();
  assert.doesNotMatch(restored, /لا تُقدَّم ضيافة في هذا الفوج/);
  const closeAgain = await (await fetchAs(manager, '/programs/1/close')).text();
  assert.match(closeAgain, /الضيافة والخدمات المساندة/, 'عاد ليظهر كقياس مطلوب');
});

test('«غير منطبق»: السبب إلزامي، ولا يُستثنى مؤشر له قياسات معتمدة', async () => {
  // تنفيذ قياس فعلي على مؤشر بيئي لنجرب استثناءه بعد ذلك
  const supervisor = await login('supervisor');
  const tasks = await (await fetchAs(supervisor, '/tasks')).text();
  const taskId = /href="\/tasks\/(\d+)"/.exec(tasks)[1];
  const form = await (await fetchAs(supervisor, `/tasks/${taskId}`)).text();
  const indicatorName = /<h1>([^<—]+)/.exec(form)[1].trim().split('—')[0].trim();
  const itemIds = [...new Set([...form.matchAll(/name="state_(\d+)"/g)].map((m) => m[1]))];
  const params = new URLSearchParams();
  for (const id of itemIds) params.set(`state_${id}`, '100');
  await fetchAs(supervisor, `/tasks/${taskId}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const manager = await login('manager');
  const metric = await (await fetchAs(manager, '/programs/1/metric')).text();
  const escaped = indicatorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const option = new RegExp(`<option value="(\\d+)">[^<]*${escaped}[^<]*</option>`).exec(metric);
  assert.ok(option, `لم يُعثر على المؤشر «${indicatorName}» في قائمة الاختيار`);

  // السبب إلزامي
  const noReason = await fetchAs(manager, '/programs/1/exemptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ indicator_id: option[1], reason: '   ' }),
  });
  assert.match(
    decodeURIComponent(noReason.headers.getSetCookie().find((c) => c.startsWith('tpq_flash=')) || ''),
    /إلزامي/,
  );

  // مؤشر له قياس معتمد لا يُستثنى — حتى لا يختفي القياس بلا أثر
  const refused = await fetchAs(manager, '/programs/1/exemptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ indicator_id: option[1], reason: 'محاولة إخفاء قياس' }),
  });
  assert.match(
    decodeURIComponent(refused.headers.getSetCookie().find((c) => c.startsWith('tpq_flash=')) || ''),
    /قياسات معتمدة/,
  );
});

test('مسؤول البرنامج لا يملك صلاحية وسم «غير منطبق»', async () => {
  const officer = await login('officer');
  const res = await fetchAs(officer, '/programs/1/exemptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ indicator_id: '1', reason: 'محاولة' }),
  });
  assert.equal(res.status, 403);
});

test('خلف وسيط HTTPS: الروابط المولّدة تستخدم https لا http', async () => {
  const cookie = await login('quality');
  // محاكاة Codespaces / Nginx: بروتوكول مُمرَّر في الترويسة
  const res = await fetch(`${BASE}/programs/1/surveys`, {
    headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' },
    redirect: 'manual',
  });
  assert.equal(res.status, 200);

  const surveys = await res.text();
  const surveyId = /href="\/surveys\/(\d+)"/.exec(surveys)?.[1];
  assert.ok(surveyId, 'توجد استبانة مفتوحة من اختبار سابق');

  const page = await (await fetch(`${BASE}/surveys/${surveyId}`, {
    headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' },
    redirect: 'manual',
  })).text();

  const links = [...page.matchAll(/(https?):\/\/[^/"\s]+\/r\//g)].map((m) => m[1]);
  assert.ok(links.length > 0, 'الصفحة تعرض روابط توزيع');
  assert.ok(links.every((p) => p === 'https'), 'كل الروابط يجب أن تكون https خلف الوسيط');
});

test('كوكي الجلسة يحمل Secure عند الدخول عبر https فقط', async () => {
  const secure = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https' },
    body: new URLSearchParams({ username: 'manager', password: 'Tahseel@2026' }),
    redirect: 'manual',
  });
  const secureCookie = secure.headers.getSetCookie().find((c) => c.startsWith('tpq_session='));
  assert.match(secureCookie, /Secure/);

  const plain = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'manager', password: 'Tahseel@2026' }),
    redirect: 'manual',
  });
  const plainCookie = plain.headers.getSetCookie().find((c) => c.startsWith('tpq_session='));
  assert.doesNotMatch(plainCookie, /Secure/, 'لا تُوسم Secure على http وإلا تعذّر الدخول محليًا');
});

// ------------------------------ الموقع العام ------------------------------

test('الصفحة الرئيسية تفتح دون تسجيل دخول وتعرض البرامج والمؤشرات', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /dir="rtl"/);
  assert.match(body, /جمعية تحصيل المعرفة/);
  assert.match(body, /برنامج إتقان التلاوة/, 'تظهر البرامج المعلنة');
  assert.match(body, /دخول المنسوبين/, 'يوجد مدخل لتسجيل الدخول');
  assert.doesNotMatch(body, /لوحتي/, 'لا تظهر عناصر المنصة الداخلية للزائر');
});

test('صفحات الموقع العام كلها متاحة للزائر', async () => {
  for (const path of ['/', '/about', '/programs-public', '/programs-public/1', '/activities-public', '/reports-public']) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200, `فشل فتح ${path} للزائر`);
  }
});

test('الموقع العام لا يكشف بيانات شخصية ولا سجلات داخلية', async () => {
  const student = 'أحمد الزهراني'; // طالب في البرنامج التجريبي
  for (const path of ['/', '/programs-public', '/programs-public/1', '/reports-public']) {
    const body = await (await fetch(`${BASE}${path}`)).text();
    assert.doesNotMatch(body, new RegExp(student), `${path} يكشف اسم طالب`);
    assert.doesNotMatch(body, /سجل التدقيق|الشكاوى والمقترحات|الحالات المتعثرة/, `${path} يكشف سجلات داخلية`);
  }
});

test('اللوحة الداخلية انتقلت إلى /app والجذر عام', async () => {
  const anon = await fetch(`${BASE}/app`, { redirect: 'manual' });
  assert.equal(anon.status, 302, '/app يتطلب تسجيل دخول');
  assert.match(anon.headers.get('location'), /^\/login/);

  const cookie = await login('officer');
  const res = await fetchAs(cookie, '/app');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /واجباتي اليوم/);
});

// ------------------------------ القوائم والصلاحيات ------------------------

test('لا تظهر للمستخدم تبويبات لا يملك صلاحيتها', async () => {
  const supervisor = await login('supervisor');
  const body = await (await fetchAs(supervisor, '/programs/1')).text();
  const tabs = [...body.matchAll(/href="\/programs\/1(?:\/([a-z]+))?"[^>]*>\s*<svg[\s\S]*?<span>([^<]+)<\/span>/g)]
    .map((m) => m[2].trim());

  assert.ok(tabs.includes('نظرة عامة'), 'المشرف يرى النظرة العامة');
  assert.ok(tabs.includes('المقياس والدرجة'), 'المشرف يرى المقياس');
  for (const hidden of ['الطلاب', 'الحضور', 'الخطة والمحتوى', 'المعلمون', 'الشكاوى',
    'الاستمرارية', 'سجل التدقيق', 'إقفال البرنامج', 'قياس الأثر']) {
    assert.ok(!tabs.includes(hidden), `المشرف لا يجب أن يرى تبويب «${hidden}»`);
  }
  assert.ok(tabs.length <= 6, `عدد تبويبات المشرف يجب أن يكون مختصرًا، وُجد ${tabs.length}`);
});

test('مسؤول الجودة العلمية يرى تبويباته دون تبويبات غيره', async () => {
  const academic = await login('academic');
  const body = await (await fetchAs(academic, '/programs/1')).text();
  const tabs = [...body.matchAll(/href="\/programs\/1(?:\/[a-z]+)?"[^>]*>\s*<svg[\s\S]*?<span>([^<]+)<\/span>/g)]
    .map((m) => m[1].trim());
  for (const shown of ['الخطة والمحتوى', 'المعلمون', 'الأنشطة', 'قياس الأثر']) {
    assert.ok(tabs.includes(shown), `يجب أن يرى «${shown}»`);
  }
  for (const hidden of ['الحضور', 'الاستمرارية', 'إقفال البرنامج', 'سجل التدقيق']) {
    assert.ok(!tabs.includes(hidden), `لا يجب أن يرى «${hidden}»`);
  }
});

test('الهوية البصرية: الشعار وألوان الجمعية مطبّقة', async () => {
  const logo = await fetch(`${BASE}/logo.svg`);
  assert.equal(logo.status, 200);
  const svg = await logo.text();
  assert.match(svg, /#36AC8D/i, 'الأخضر الأساسي في الشعار');
  assert.match(svg, /#CC9C63/i, 'الذهبي في الشعار');

  const css = await (await fetch(`${BASE}/app.css`)).text();
  for (const color of ['#1F4E4B', '#36AC8D', '#CC9C63', '#E3CAAB']) {
    assert.ok(css.includes(color), `اللون ${color} غير معرّف في الهوية`);
  }
  assert.match(css, /@media \(max-width: 780px\)/, 'توجد قواعد تجاوب للجوال');
  assert.match(css, /table\.stackable/, 'الجداول تتحول إلى بطاقات على الجوال');

  const home = await (await fetch(`${BASE}/`)).text();
  assert.match(home, /logo\.svg/, 'الشعار معروض في الصفحة الرئيسية');
});

test('نظام التصميم: رموز موحّدة ووضع ليلي ونسبة مقروءة', async () => {
  const css = await (await fetch(`${BASE}/app.css`)).text();

  // كل رمز مستخدم لا بد أن يكون معرَّفًا — وإلا انهار اللون بصمت
  const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gmi)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v));
  assert.deepEqual(missing, [], 'رموز مستخدمة بلا تعريف');

  assert.match(css, /@media \(prefers-color-scheme: dark\)/, 'وضع ليلي');
  assert.match(css, /@media \(max-width: 1024px\)/, 'القائمة تُطوى على اللوحي');
  assert.match(css, /\.meter-track/, 'مقياس النسبة بالتصميم الجديد');

  // النسبة تُكتب خارج الشريط لا داخله حتى لا تُقصّ في الأعمدة الضيقة
  const cookie = await login('manager');
  const metric = await (await fetchAs(cookie, '/programs/1/metric')).text();
  assert.match(metric, /<span class="meter-val">/, 'النسبة عنصر مستقل خارج الشريط');
  assert.doesNotMatch(metric, /class="muted num">\d+ من/, 'النص المختلط لا يُجبر على الاتجاه اللاتيني');
});

// ------------------------------ الذكاء والتنظيم ---------------------------

test('اللوحة تبدأ بـ«ابدأ بهذه» وتعرض تشخيصًا لا قوائم فقط', async () => {
  const cookie = await login('officer');
  const body = await (await fetchAs(cookie, '/app')).text();
  assert.match(body, /ابدأ بهذه/, 'توصية بأعلى مهمة أثرًا');
  assert.match(body, /ما يحتاج انتباهك/, 'قسم التشخيص');
  assert.match(body, /مهامك بترتيب الأولوية/, 'ترتيب بالأولوية لا بالتاريخ');
  assert.match(body, /class="insight/, 'بطاقات تشخيصية');
});

test('نظرة البرنامج تعرض التشخيص والمقارنة بدل سرد الأرقام', async () => {
  const cookie = await login('manager');
  const body = await (await fetchAs(cookie, '/programs/1')).text();
  assert.match(body, /التشخيص — ما الذي يحتاج تدخلك/);
  assert.match(body, /حالة البرنامج/);
  assert.match(body, /class="insight/);
});

test('مركز التقارير يجمع المقارنة والاتجاه والمعايرة', async () => {
  const cookie = await login('manager');
  const body = await (await fetchAs(cookie, '/reports')).text();
  assert.match(body, /مركز التقارير/);
  assert.match(body, /مقارنة البرامج/);
  assert.match(body, /اتجاه الأداء عبر الفترات/);
  assert.match(body, /أضعف المؤشرات على مستوى الجمعية/);
  assert.match(body, /المعيارية من 300/);
});

test('تبويبات البرنامج مجمّعة في أقسام مسمّاة', async () => {
  const cookie = await login('admin');
  const body = await (await fetchAs(cookie, '/programs/1')).text();
  assert.match(body, /class="subnav-group"/, 'التبويبات داخل مجموعات');
  for (const group of ['التشغيل', 'القياس', 'المتابعة', 'الإدارة']) {
    assert.match(body, new RegExp(`g-label">${group}`), `مجموعة «${group}» ظاهرة`);
  }
});

test('الإجراءات المتكررة تُدمج وتُوسم في لوحة الإجراءات', async () => {
  const supervisor = await login('supervisor');

  // أخفق نفس العنصر في قياسين متتاليين لنفس المؤشر
  const fail = async () => {
    const tasks = await (await fetchAs(supervisor, '/tasks')).text();
    const ids = [...tasks.matchAll(/href="\/tasks\/(\d+)"/g)].map((m) => m[1]);
    for (const id of ids) {
      const form = await (await fetchAs(supervisor, `/tasks/${id}`)).text();
      if (!/نظافة القاعات والمرافق/.test(form)) continue;
      const items = [...new Set([...form.matchAll(/name="state_(\d+)"/g)].map((m) => m[1]))];
      if (!items.length) continue;
      const params = new URLSearchParams();
      items.forEach((it, i) => {
        params.set(`state_${it}`, i === 0 ? '0' : '100');
        if (i === 0) params.set(`note_${it}`, 'حاويات النفايات ممتلئة');
      });
      params.set('auto_action', '1');
      const res = await fetchAs(supervisor, `/tasks/${id}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      return decodeURIComponent(res.headers.getSetCookie().find((c) => c.startsWith('tpq_flash=')) || '');
    }
    return null;
  };

  const first = await fail();
  assert.ok(first, 'نُفّذ قياس أول');
  assert.match(first, /إجراءً جديدًا|دُمجت في إجراء قائم/);

  const second = await fail();
  assert.ok(second, 'نُفّذ قياس ثانٍ');
  assert.match(second, /دُمجت في إجراء قائم/, 'المشكلة نفسها تُدمج في إجراء واحد لا تتكرر');

  const board = await (await fetchAs(supervisor, '/programs/1/actions')).text();
  assert.match(board, /تكرر \d+×/, 'عدّاد التكرار ظاهر على البطاقة');

  // ولا تتضاعف البطاقات: عنوان المشكلة يظهر مرة واحدة فقط
  const occurrences = (board.match(/حاويات النفايات|معالجة: حاويات/g) || []).length;
  assert.ok(occurrences <= 2, `المشكلة الواحدة بطاقة واحدة، وُجدت ${occurrences} مرة`);
});
