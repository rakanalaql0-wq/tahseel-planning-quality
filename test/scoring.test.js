import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TPQ_DB = ':memory:';

const { likertToPct, requiredCount, computeProgram, missingMeasurements, minResponseRate, responseRate } = await import('../src/lib/scoring.js');
const { pickSample, syncProgramTasks, closureReadiness } = await import('../src/lib/scheduler.js');
const { normalizedGain, programImpact, toolSummary } = await import('../src/lib/impact.js');
const { all, get, run } = await import('../src/db/index.js');
const { seedAll } = await import('../src/db/seed.js');
const { FRAMEWORK, SCALE_VERSION } = await import('../src/db/framework.js');

seedAll({ demo: true });
const program = get("SELECT * FROM programs WHERE code = 'PRG-001'");

const nodeFor = (code) => computeProgram(program.id).sections
  .flatMap((s) => s.axes).flatMap((a) => a.indicators)
  .find((n) => n.indicator.code === code);

// ------------------------------ بنية المقياس ------------------------------

test('BR-01: إجمالي أوزان المؤشرات 300 درجة موزعة 75 + 135 + 90', () => {
  const total = get('SELECT SUM(weight) s FROM indicators WHERE is_active = 1').s;
  assert.equal(total, 300);
  assert.deepEqual(FRAMEWORK.map((s) => s.weight), [75, 135, 90]);
  for (const section of FRAMEWORK) {
    const axesSum = section.axes.reduce(
      (sum, axis) => sum + axis.indicators.reduce((x, i) => x + i.weight, 0), 0,
    );
    assert.equal(axesSum, section.weight, `أوزان قسم ${section.name} لا تطابق وزنه المعلن`);
    for (const axis of section.axes) {
      const indSum = axis.indicators.reduce((x, i) => x + i.weight, 0);
      assert.equal(indSum, axis.weight, `أوزان محور ${axis.name} لا تطابق وزنه المعلن`);
    }
  }
});

test('توزيع المحاور يطابق الهيكل المعتمد', () => {
  const axes = Object.fromEntries(all('SELECT code, weight FROM metric_axes').map((a) => [a.code, a.weight]));
  assert.deepEqual(axes, {
    'A1.1': 20, 'A1.2': 20, 'A1.3': 10, 'A1.4': 20, 'A1.5': 5,      // 75
    'A2.1': 50, 'A2.2': 35, 'A2.3': 20, 'A2.4': 30,                  // 135
    'A3.1': 15, 'A3.2': 30, 'A3.3': 25, 'A3.4': 20,                  // 90
  });
  assert.equal(get("SELECT value FROM settings WHERE key = 'scale_version'").value, SCALE_VERSION);
});

test('تقييم المعلم من مصدرين: استبانة الطلاب والزيارة الصفية، 10 لكل منهما', () => {
  const survey = get("SELECT * FROM indicators WHERE code = 'I-2.1.2'");
  const visit = get("SELECT * FROM indicators WHERE code = 'I-2.1.3'");
  assert.equal(survey.tool, 'survey');
  assert.equal(survey.weight, 10);
  assert.equal(visit.tool, 'checklist');
  assert.equal(visit.weight, 10);
  assert.equal(visit.owner_role, 'academic_quality');
  // الزيارة الصفية مرتان على الأقل، والدرجة متوسط الزيارتين
  assert.equal(visit.periodicity, 'fixed_count');
  assert.equal(visit.min_count, 2);
  assert.equal(requiredCount(visit, {}, { sessionCount: 12 }), 2);
  const items = all('SELECT * FROM checklist_items WHERE indicator_id = ?', visit.id);
  assert.ok(items.length >= 6, 'قائمة الزيارة الصفية تحتاج عناصر كافية');
});

// ------------------------------ قواعد الحساب ------------------------------

test('BR-03: (المتوسط − 1) ÷ 4 × 100', () => {
  assert.equal(likertToPct(5), 100);
  assert.equal(likertToPct(1), 0);
  assert.equal(likertToPct(3), 50);
  assert.equal(likertToPct(4), 75);
  assert.equal(likertToPct(null), null);
});

test('BR-05: عينة تهيئة القاعات لا تقل عن 50% من اللقاءات', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.3.1'");
  assert.equal(ind.sample_pct, 50);
  assert.equal(requiredCount(ind, { planned_sessions: 12 }, { sessionCount: 12 }), 6);
  assert.equal(requiredCount(ind, { planned_sessions: 11 }, { sessionCount: 11 }), 6); // تقريب لأعلى
});

test('BR-06: الضيافة عينة 25% وبحد أدنى مرتين', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.5.1'");
  assert.equal(ind.weight, 5);
  assert.equal(requiredCount(ind, {}, { sessionCount: 12 }), 3);
  assert.equal(requiredCount(ind, {}, { sessionCount: 4 }), 2); // الحد الأدنى يغلب النسبة
});

test('BR-07: التجهيزات تحقق مرتان على الأقل', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.4.1'");
  assert.equal(requiredCount(ind, {}, { sessionCount: 50 }), 2);
});

test('BR-08: الدعم والتواصل يُقاس مرتين (منتصف ونهاية)', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-3.2.1'");
  assert.equal(ind.periodicity, 'mid_end');
  assert.equal(ind.weight, 30);
  assert.equal(requiredCount(ind, {}, {}), 2);
});

test('BR-10: الاستمرارية 5 درجات رغبة + 15 درجة فعلي', () => {
  const intent = get("SELECT * FROM indicators WHERE code = 'I-3.4.1'");
  const actual = get("SELECT * FROM indicators WHERE code = 'I-3.4.2'");
  assert.equal(intent.weight, 5);
  assert.equal(actual.weight, 15);
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
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.3.1'");
  const tasks = all("SELECT * FROM tasks WHERE program_id = ? AND indicator_id = ? AND status = 'pending'", program.id, ind.id);
  assert.equal(tasks.length, 6);
  assert.ok(tasks.every((t) => t.session_id), 'كل مهمة عينة مرتبطة بلقاء محدد');
  assert.equal(new Set(tasks.map((t) => t.session_id)).size, 6);
});

test('BR-02 + حساب نتيجة قائمة التحقق كمتوسط موزون للعناصر', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.4.1'"); // 6 عناصر، وزن 20
  const items = all('SELECT * FROM checklist_items WHERE indicator_id = ? ORDER BY sort', ind.id);
  const task = get("SELECT * FROM tasks WHERE program_id = ? AND indicator_id = ? AND status = 'pending' LIMIT 1", program.id, ind.id);
  run('INSERT INTO verifications (task_id, program_id, indicator_id) VALUES (?, ?, ?)', task.id, program.id, ind.id);
  const v = get('SELECT * FROM verifications WHERE task_id = ?', task.id);
  const states = [100, 100, 50, 0, 100, 100]; // المتوسط = 75
  items.forEach((item, i) => {
    run('INSERT INTO verification_items (verification_id, checklist_item_id, state, note) VALUES (?, ?, ?, ?)',
      v.id, item.id, states[i], states[i] < 100 ? 'ملاحظة' : null);
  });
  const score = states.reduce((a, b) => a + b, 0) / states.length;
  run("UPDATE verifications SET score_pct = ?, status = 'submitted', completed_at = datetime('now') WHERE id = ?", score, v.id);
  run("UPDATE tasks SET status = 'done' WHERE id = ?", task.id);

  const node = nodeFor('I-1.4.1');
  assert.equal(node.score_pct, 75);
  assert.equal(node.earned, (20 * 75) / 100); // 15 من 20
  assert.equal(node.required, 2);
  assert.equal(node.completed, 1);
  assert.equal(node.coverage_pct, 50);
});

test('جلسات المتابعة: النسبة من الحالات التي عُقدت لها جلسة موثّقة', () => {
  // البرنامج التجريبي فيه حالة واحدة بجلسة متابعة موثقة
  assert.equal(nodeFor('I-2.4.3').score_pct, 100);
  run(`INSERT INTO discipline_cases (program_id, kind, description, action, status)
       VALUES (?, 'behavior', 'حالة بلا جلسة متابعة', 'تنبيه شفهي', 'open')`, program.id);
  assert.equal(nodeFor('I-2.4.3').score_pct, 50); // 1 من 2
  run("DELETE FROM discipline_cases WHERE description = 'حالة بلا جلسة متابعة'");
  assert.equal(nodeFor('I-2.4.3').score_pct, 100);
});

test('BR-11: اكتمال القياس محسوب مستقلاً عن نتيجة الجودة', () => {
  const r = computeProgram(program.id);
  assert.ok(r.coverage_pct < 100, 'الاكتمال أقل من 100% لوجود قياسات لم تُنفّذ');
  assert.ok(r.quality_pct > 0, 'نتيجة الجودة محسوبة على ما تم قياسه فقط');
  assert.notEqual(r.quality_pct, r.coverage_pct);
  assert.equal(r.total_weight, 300);
  assert.ok(r.earned <= r.measured_weight);
});

// ------------------------------ كفاية عينة الاستبانة ----------------------

test('الحد الأدنى المعتمد لنسبة الاستجابة هو 70%', () => {
  assert.equal(minResponseRate(), 70);
  assert.equal(responseRate({ target_count: 20 }, 14), 70);
  assert.equal(responseRate({ target_count: 0 }, 5), null);
});

test('استبانة دون 70% تُوسم عينة غير كافية ولا تُحتسب في الاكتمال', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-3.3.1'"); // الرضا والانتماء — 25 درجة
  const active = all("SELECT id FROM students WHERE program_id = ? AND status <> 'withdrawn'", program.id);

  const addSurvey = (tokenValue, target, responders) => {
    run(`INSERT INTO surveys (program_id, title, point, token, status, target_count)
         VALUES (?, ?, 'end', ?, 'open', ?)`, program.id, `استبانة ${tokenValue}`, tokenValue, target);
    const survey = get('SELECT * FROM surveys WHERE token = ?', tokenValue);
    const bank = all('SELECT * FROM question_bank WHERE indicator_id = ? AND point = ?', ind.id, 'end');
    for (const q of bank) {
      run('INSERT INTO survey_questions (survey_id, code, text, indicator_id) VALUES (?, ?, ?, ?)',
        survey.id, q.code, q.text, ind.id);
    }
    const questions = all('SELECT * FROM survey_questions WHERE survey_id = ?', survey.id);
    for (let i = 0; i < responders; i += 1) {
      run('INSERT INTO survey_responses (survey_id) VALUES (?)', survey.id);
      const resp = get('SELECT * FROM survey_responses ORDER BY id DESC LIMIT 1');
      for (const q of questions) {
        run('INSERT INTO survey_answers (response_id, question_id, value) VALUES (?, ?, ?)', resp.id, q.id, 4);
      }
    }
    return survey;
  };

  // 5 من 22 = 22.7% — أقل من الحد
  const weak = addSurvey('tok-weak', active.length, 5);
  let node = nodeFor('I-3.3.1');
  assert.equal(node.score_pct, 75, 'النتيجة تُحسب وتُعرض للاطلاع');
  assert.equal(node.completed, 0, 'العينة غير الكافية لا تُحتسب ضمن الاكتمال');
  assert.equal(node.coverage_pct, 0);
  assert.equal(node.insufficient.length, 1);
  assert.ok(node.insufficient[0].rate < 70);

  // إضافة استجابات حتى تتجاوز 70%
  const questions = all('SELECT * FROM survey_questions WHERE survey_id = ?', weak.id);
  for (let i = 0; i < 12; i += 1) {
    run('INSERT INTO survey_responses (survey_id) VALUES (?)', weak.id);
    const resp = get('SELECT * FROM survey_responses ORDER BY id DESC LIMIT 1');
    for (const q of questions) {
      run('INSERT INTO survey_answers (response_id, question_id, value) VALUES (?, ?, ?)', resp.id, q.id, 4);
    }
  }
  node = nodeFor('I-3.3.1');
  assert.equal(node.insufficient.length, 0, 'بعد تجاوز 70% تصبح العينة كافية');
  assert.equal(node.completed, 1);
  assert.equal(node.earned, (25 * 75) / 100);
});

test('البرنامج لا يكون جاهزًا للإقفال مع وجود قياسات ناقصة أو شكاوى مفتوحة', () => {
  const readiness = closureReadiness(program.id);
  assert.ok(readiness.gaps.length > 0);
  assert.ok(readiness.openComplaints.length > 0);
  assert.equal(readiness.ready, false);
  assert.equal(missingMeasurements(program.id).length, readiness.gaps.length);
});

test('BR-12: لا يوجد سؤال استبانة مرتبط بمؤشرات قوائم التحقق (سلامة المحتوى)', () => {
  const bad = all(
    `SELECT q.code FROM question_bank q JOIN indicators i ON i.id = q.indicator_id
      WHERE i.tool <> 'survey'`,
  );
  assert.deepEqual(bad, [], 'مكتبة الأسئلة يجب ألا تقيس مؤشرات السلامة العلمية');
});

// ------------------------------ قياس الأثر --------------------------------

test('مكسب التعلم المعياري = (بعدي − قبلي) ÷ (100 − قبلي)', () => {
  assert.equal(normalizedGain(40, 70), 50);   // تحقق نصف التحسن الممكن
  assert.equal(normalizedGain(0, 100), 100);
  assert.equal(normalizedGain(50, 50), 0);
  assert.equal(normalizedGain(100, 100), null);
  assert.equal(normalizedGain(null, 80), null);
});

test('قياس الأثر يحسب المتوسطات والإتقان والتحسن ولا يمس مقياس الـ300', () => {
  const before = computeProgram(program.id);
  const im = programImpact(program.id);

  assert.ok(im.has_data);
  assert.ok(im.pre_pct > 0 && im.pre_pct < 60, 'متوسط قبلي منخفض كما في البيانات التجريبية');
  assert.ok(im.post_pct > im.pre_pct, 'المتوسط البعدي أعلى من القبلي');
  assert.ok(im.normalized_gain > 0);
  assert.equal(im.improved_count, im.paired_count, 'كل من قيس قبليًا وبعديًا تحسّن مستواه');

  const post = im.tools.find((t) => t.tool.kind === 'post');
  assert.ok(post.measured < post.eligible, 'طالبان لم يُقاسا بعديًا — تظهر تغطية ناقصة');
  assert.ok(post.coverage_pct < 100);

  // الشرط الجوهري: قياس الأثر لا يغيّر الدرجة ولا الاكتمال
  const after = computeProgram(program.id);
  assert.equal(after.earned, before.earned);
  assert.equal(after.total_weight, 300);
  assert.equal(after.coverage_pct, before.coverage_pct);
  const impactIndicators = all("SELECT code FROM indicators WHERE code LIKE '%أثر%' OR record_rule LIKE 'impact%'");
  assert.deepEqual(impactIndicators, [], 'لا يوجد مؤشر أثر داخل مقياس الـ300');
});

test('ملخص أداة القياس يحسب الإتقان مقابل الدرجة العظمى', () => {
  run(`INSERT INTO impact_tools (program_id, name, kind, max_score, mastery_pct)
       VALUES (?, 'تقييم عملي تجريبي', 'practical', 20, 75)`, program.id);
  const tool = get("SELECT * FROM impact_tools WHERE name = 'تقييم عملي تجريبي'");
  const students = all("SELECT id FROM students WHERE program_id = ? AND status <> 'withdrawn' LIMIT 4", program.id);
  [20, 15, 10, 18].forEach((score, i) => {
    run('INSERT INTO impact_results (tool_id, student_id, score) VALUES (?, ?, ?)', tool.id, students[i].id, score);
  });
  const s = toolSummary(tool.id);
  assert.equal(s.measured, 4);
  assert.equal(s.avg_pct, ((100 + 75 + 50 + 90) / 4));
  assert.equal(s.max_pct, 100);
  assert.equal(s.min_pct, 50);
  assert.equal(s.mastered, 3);  // 100، 75، 90 ≥ 75
  assert.equal(s.mastery_rate, 75);
});

// ------------------------------ قاعدة «غير منطبق» ------------------------

test('وسم مؤشر «غير منطبق» يخرج وزنه من المقياس ومن اكتمال القياس', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.5.1'"); // الضيافة — 5 درجات
  const before = computeProgram(program.id);
  assert.equal(before.total_weight, 300);
  assert.equal(before.exempt_weight, 0);
  const gapsBefore = missingMeasurements(program.id).length;
  assert.ok(missingMeasurements(program.id).some((g) => g.indicator.code === 'I-1.5.1'));

  run('INSERT INTO indicator_exemptions (program_id, indicator_id, reason) VALUES (?, ?, ?)',
    program.id, ind.id, 'البرنامج لا يتضمن ضيافة');

  const after = computeProgram(program.id);
  assert.equal(after.declared_weight, 300, 'الوزن المعلن يبقى 300');
  assert.equal(after.total_weight, 295, 'الوزن المنطبق ينقص بمقدار المؤشر المستثنى');
  assert.equal(after.exempt_weight, 5);
  assert.equal(after.exemptions.length, 1);
  assert.equal(after.exemptions[0].reason, 'البرنامج لا يتضمن ضيافة');

  // لم يعد قياسًا ناقصًا ولا يمنع الإقفال
  assert.equal(missingMeasurements(program.id).length, gapsBefore - 1);
  assert.ok(!missingMeasurements(program.id).some((g) => g.indicator.code === 'I-1.5.1'));

  // المؤشر يبقى ظاهرًا في الشجرة موسومًا، بوزن فعلي صفر
  const node = nodeFor('I-1.5.1');
  assert.equal(node.exempt, true);
  assert.equal(node.weight, 5, 'الوزن المعلن يُعرض للمستخدم');
  assert.equal(node.effective_weight, 0);
  assert.equal(node.earned, 0);
  assert.equal(node.required, 0);
  assert.equal(node.coverage_pct, null);

  // قسم البيئة ينقص وزنه المنطبق من 75 إلى 70
  const section = after.sections.find((s) => s.section.code === 'S1');
  assert.equal(section.declared_weight, 75);
  assert.equal(section.weight, 70);
  assert.equal(section.exempt_weight, 5);
});

test('الدرجة المعيارية من 300 تُبقي البرامج قابلة للمقارنة رغم اختلاف الاستثناءات', () => {
  const r = computeProgram(program.id);
  // المحقق ÷ الوزن المنطبق × الوزن المعلن
  assert.equal(r.normalized_score, (r.earned / r.total_weight) * 300);
  assert.ok(r.normalized_score > r.earned, 'المعيارية أعلى لأن الوزن المنطبق أقل من 300');
});

test('إعادة تطبيق المؤشر تعيد وزنه ومهامه إلى المقياس', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.5.1'");
  run('DELETE FROM indicator_exemptions WHERE program_id = ? AND indicator_id = ?', program.id, ind.id);
  syncProgramTasks(program.id);

  const r = computeProgram(program.id);
  assert.equal(r.total_weight, 300);
  assert.equal(r.exempt_weight, 0);
  assert.equal(nodeFor('I-1.5.1').exempt, false);
  assert.ok(missingMeasurements(program.id).some((g) => g.indicator.code === 'I-1.5.1'));
  const tasks = all("SELECT * FROM tasks WHERE program_id = ? AND indicator_id = ? AND status = 'pending'", program.id, ind.id);
  assert.ok(tasks.length > 0, 'تُولَّد مهام المؤشر من جديد بعد إعادة تطبيقه');
});

test('توليد المهام يتجاهل المؤشرات غير المنطبقة ويلغي مهامها المعلّقة', () => {
  const ind = get("SELECT * FROM indicators WHERE code = 'I-1.5.1'");
  const beforeCount = all("SELECT * FROM tasks WHERE program_id = ? AND indicator_id = ? AND status = 'pending'", program.id, ind.id).length;
  assert.ok(beforeCount > 0);

  run('INSERT INTO indicator_exemptions (program_id, indicator_id, reason) VALUES (?, ?, ?)',
    program.id, ind.id, 'برنامج عن بُعد');
  const res = syncProgramTasks(program.id);
  assert.ok(res.cancelled >= beforeCount);
  assert.equal(
    all("SELECT * FROM tasks WHERE program_id = ? AND indicator_id = ? AND status = 'pending'", program.id, ind.id).length,
    0, 'لا مهام معلّقة لمؤشر غير منطبق',
  );
  run('DELETE FROM indicator_exemptions WHERE program_id = ? AND indicator_id = ?', program.id, ind.id);
  syncProgramTasks(program.id);
});
