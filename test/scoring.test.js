import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TPQ_DB = ':memory:';

const { likertToPct, requiredCount, computeProgram, missingMeasurements } = await import('../src/lib/scoring.js');
const { pickSample, syncProgramTasks, closureReadiness } = await import('../src/lib/scheduler.js');
const { all, get, run } = await import('../src/db/index.js');
const { seedAll } = await import('../src/db/seed.js');
const { FRAMEWORK } = await import('../src/db/framework.js');

seedAll({ demo: true });
const program = get("SELECT * FROM programs WHERE code = 'PRG-001'");

test('BR-01: إجمالي أوزان المؤشرات 300 درجة موزعة 75 + 135 + 90', () => {
  const total = get('SELECT SUM(weight) s FROM indicators WHERE is_active = 1').s;
  assert.equal(total, 300);
  assert.deepEqual(FRAMEWORK.map((s) => s.weight), [75, 135, 90]);
  for (const section of FRAMEWORK) {
    const axesSum = section.axes.reduce(
      (sum, axis) => sum + axis.indicators.reduce((x, i) => x + i.weight, 0), 0,
    );
    assert.equal(axesSum, section.weight, `أوزان قسم ${section.name} لا تطابق وزنه المعلن`);
  }
});

test('BR-03: (المتوسط − 1) ÷ 4 × 100', () => {
  assert.equal(likertToPct(5), 100);
  assert.equal(likertToPct(1), 0);
  assert.equal(likertToPct(3), 50);
  assert.equal(likertToPct(4), 75);
  assert.equal(likertToPct(null), null);
});

test('BR-05: عينة تهيئة القاعات لا تقل عن 50% من اللقاءات', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.1.1'");
  assert.equal(ind.sample_pct, 50);
  assert.equal(requiredCount(ind, { planned_sessions: 12 }, { sessionCount: 12 }), 6);
  assert.equal(requiredCount(ind, { planned_sessions: 11 }, { sessionCount: 11 }), 6); // تقريب لأعلى
});

test('BR-06: الضيافة عينة 25% وبحد أدنى مرتين', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.3.1'");
  assert.equal(requiredCount(ind, {}, { sessionCount: 12 }), 3);
  assert.equal(requiredCount(ind, {}, { sessionCount: 4 }), 2); // الحد الأدنى يغلب النسبة
});

test('BR-07: التجهيزات تحقق مرتان على الأقل', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.2.1'");
  assert.equal(requiredCount(ind, {}, { sessionCount: 50 }), 2);
});

test('BR-08: الدعم والتواصل يُقاس مرتين (منتصف ونهاية)', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-3.1.1'");
  assert.equal(ind.periodicity, 'mid_end');
  assert.equal(requiredCount(ind, {}, {}), 2);
});

test('BR-10: الاستمرارية 5 درجات نية + 15 درجة فعلي', () => {
  const intent = get("SELECT * FROM indicators WHERE code = 'I-3.5.1'");
  const actual = get("SELECT * FROM indicators WHERE code = 'I-3.5.2'");
  assert.equal(intent.weight, 5);
  assert.equal(actual.weight, 15);
  assert.equal(intent.weight + actual.weight, 20);
});

test('العينة توزَّع بانتظام على اللقاءات ولا تتكرر', () => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, seq: i + 1 }));
  const picked = pickSample(sessions, 6);
  assert.equal(picked.length, 6);
  assert.equal(new Set(picked.map((s) => s.id)).size, 6);
  assert.deepEqual(picked.map((s) => s.seq), [1, 3, 5, 7, 9, 11]);
  assert.equal(pickSample(sessions, 20).length, 12); // لا يتجاوز عدد اللقاءات
});

test('توليد المهام يغطي كل مؤشر بعدد القياسات المطلوب', () => {
  syncProgramTasks(program.id);
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.1.1'");
  const tasks = all("SELECT * FROM tasks WHERE program_id = ? AND indicator_id = ? AND status = 'pending'", program.id, ind.id);
  assert.equal(tasks.length, 6);
  assert.ok(tasks.every((t) => t.session_id), 'كل مهمة عينة مرتبطة بلقاء محدد');
  assert.equal(new Set(tasks.map((t) => t.session_id)).size, 6);
});

test('BR-02 + حساب نتيجة قائمة التحقق كمتوسط موزون للعناصر', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.2.1'");
  const items = all('SELECT * FROM checklist_items WHERE indicator_id = ? ORDER BY sort', ind.id);
  const task = get("SELECT * FROM tasks WHERE program_id = ? AND indicator_id = ? AND status = 'pending' LIMIT 1", program.id, ind.id);
  run('INSERT INTO verifications (task_id, program_id, indicator_id) VALUES (?, ?, ?)', task.id, program.id, ind.id);
  const v = get('SELECT * FROM verifications WHERE task_id = ?', task.id);
  // 5 عناصر: 100, 100, 50, 0, 100 => (100+100+50+0+100)/5 = 70
  const states = [100, 100, 50, 0, 100];
  items.forEach((item, i) => {
    run('INSERT INTO verification_items (verification_id, checklist_item_id, state, note) VALUES (?, ?, ?, ?)',
      v.id, item.id, states[i], states[i] < 100 ? 'ملاحظة' : null);
  });
  const score = states.reduce((a, b) => a + b, 0) / states.length;
  run("UPDATE verifications SET score_pct = ?, status = 'submitted', completed_at = datetime('now') WHERE id = ?", score, v.id);
  run("UPDATE tasks SET status = 'done' WHERE id = ?", task.id);

  const result = computeProgram(program.id);
  const node = result.sections.flatMap((s) => s.axes).flatMap((a) => a.indicators)
    .find((n) => n.indicator.code === 'I-1.2.1');
  assert.equal(node.score_pct, 70);
  assert.equal(node.earned, (20 * 70) / 100); // 14 من 20
  assert.equal(node.required, 2);
  assert.equal(node.completed, 1);
  assert.equal(node.coverage_pct, 50);
});

test('BR-11: اكتمال القياس محسوب مستقلاً عن نتيجة الجودة', () => {
  const r = computeProgram(program.id);
  assert.ok(r.coverage_pct < 100, 'الاكتمال أقل من 100% لوجود قياسات لم تُنفّذ');
  assert.ok(r.quality_pct > 0, 'نتيجة الجودة محسوبة على ما تم قياسه فقط');
  assert.notEqual(r.quality_pct, r.coverage_pct);
  assert.equal(r.total_weight, 300);
  assert.ok(r.earned <= r.measured_weight);
});

test('البرنامج لا يكون جاهزًا للإقفال مع وجود قياسات ناقصة أو شكاوى مفتوحة', () => {
  const readiness = closureReadiness(program.id);
  assert.ok(readiness.gaps.length > 0);
  assert.ok(readiness.openComplaints.length > 0);
  assert.equal(readiness.ready, false);
  assert.equal(missingMeasurements(program.id).length, readiness.gaps.length);
});

test('نتيجة الاستبانة تُحتسب من متوسط الأسئلة المرتبطة بالمؤشر', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-3.2.1'");
  run(`INSERT INTO surveys (program_id, title, point, token, status) VALUES (?, 'اختبار', 'end', 'tok-test', 'open')`, program.id);
  const survey = get("SELECT * FROM surveys WHERE token = 'tok-test'");
  const bank = all('SELECT * FROM question_bank WHERE indicator_id = ? AND point = ?', ind.id, 'end');
  for (const q of bank) {
    run('INSERT INTO survey_questions (survey_id, code, text, indicator_id) VALUES (?, ?, ?, ?)',
      survey.id, q.code, q.text, ind.id);
  }
  const questions = all('SELECT * FROM survey_questions WHERE survey_id = ?', survey.id);
  // إجابتان: كلها 5 ثم كلها 3 => المتوسط 4 => (4-1)/4*100 = 75%
  for (const value of [5, 3]) {
    run('INSERT INTO survey_responses (survey_id) VALUES (?)', survey.id);
    const resp = get('SELECT * FROM survey_responses ORDER BY id DESC LIMIT 1');
    for (const q of questions) {
      run('INSERT INTO survey_answers (response_id, question_id, value) VALUES (?, ?, ?)', resp.id, q.id, value);
    }
  }
  const node = computeProgram(program.id).sections.flatMap((s) => s.axes).flatMap((a) => a.indicators)
    .find((n) => n.indicator.code === 'I-3.2.1');
  assert.equal(node.score_pct, 75);
  assert.equal(node.earned, 15); // 20 × 75%
});

test('BR-12: لا يوجد سؤال استبانة مرتبط بمؤشرات قوائم التحقق (سلامة المحتوى)', () => {
  const bad = all(
    `SELECT q.code FROM question_bank q JOIN indicators i ON i.id = q.indicator_id
      WHERE i.tool <> 'survey'`,
  );
  assert.deepEqual(bad, [], 'مكتبة الأسئلة يجب ألا تقيس مؤشرات السلامة العلمية');
});
