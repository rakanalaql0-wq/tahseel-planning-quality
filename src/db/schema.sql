-- =====================================================================
-- منصة التخطيط والجودة العلمية — جمعية تحصيل المعرفة
-- مخطط قاعدة البيانات (SQLite)
-- مرجع: وثيقة تحليل نظام منصة مقياس الجودة التعليمية — الإصدار الأول
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ------------------------------ الحسابات والصلاحيات ------------------

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT    NOT NULL,
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT,
  phone         TEXT,
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  global_role   TEXT    NOT NULL DEFAULT 'none', -- admin | quality_manager | none
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

-- ------------------------------ البرامج والبنية التشغيلية -----------

CREATE TABLE IF NOT EXISTS venues (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,          -- القاعة
  location TEXT,                   -- الموقع
  capacity INTEGER,
  notes    TEXT
);

CREATE TABLE IF NOT EXISTS teachers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name           TEXT NOT NULL,
  phone               TEXT,
  specialization      TEXT,
  credentials_note    TEXT,        -- وثائق الإثبات
  recommendation_ref  TEXT,        -- التزكية المعتبرة
  suitability_status  TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  verified_by         INTEGER REFERENCES users(id),
  verified_at         TEXT,
  verify_note         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS programs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  code             TEXT UNIQUE,
  kind             TEXT,                  -- نوع البرنامج (دورة / برنامج مستمر ...)
  term             TEXT,                  -- الفترة
  start_date       TEXT,
  end_date         TEXT,
  venue_id         INTEGER REFERENCES venues(id),
  planned_sessions INTEGER NOT NULL DEFAULT 0,   -- عدد اللقاءات
  planned_students INTEGER NOT NULL DEFAULT 0,   -- عدد الطلاب عند البداية
  status           TEXT NOT NULL DEFAULT 'draft', -- draft | active | closing | closed
  closed_at        TEXT,
  final_score      REAL,
  final_coverage   REAL,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ProgramAssignment: ربط المستخدم بدوره داخل البرنامج
CREATE TABLE IF NOT EXISTS program_assignments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,   -- program_officer | supervisor | academic_quality | quality_officer | quality_manager
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (program_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id   INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,     -- رقم اللقاء
  title        TEXT,
  session_date TEXT,
  venue_id     INTEGER REFERENCES venues(id),
  teacher_id   INTEGER REFERENCES teachers(id),
  status       TEXT NOT NULL DEFAULT 'planned', -- planned | held | cancelled
  UNIQUE (program_id, seq)
);

CREATE TABLE IF NOT EXISTS students (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id     INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  full_name      TEXT NOT NULL,
  phone          TEXT,
  status         TEXT NOT NULL DEFAULT 'active', -- active | withdrawn | completed
  joined_at      TEXT,
  withdrawn_at   TEXT,
  withdraw_reason TEXT,
  intent_continue INTEGER,   -- 1 نعم / 0 لا / NULL لم يُسأل (نية الاستمرار)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'present', -- present | absent | late | excused
  note       TEXT,
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, student_id)
);

-- ------------------------------ بنية المقياس -------------------------

CREATE TABLE IF NOT EXISTS metric_sections (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL UNIQUE,
  name   TEXT NOT NULL,
  weight REAL NOT NULL,          -- الدرجة الكاملة للقسم
  sort   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS metric_axes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL REFERENCES metric_sections(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  weight     REAL NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS indicators (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  axis_id     INTEGER NOT NULL REFERENCES metric_axes(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  weight      REAL NOT NULL,
  tool        TEXT NOT NULL,  -- checklist | survey | record
  owner_role  TEXT NOT NULL,  -- الدور المسؤول عن القياس
  periodicity TEXT NOT NULL,  -- before_start | mid | end | per_session_sample | fixed_count | per_main_activity | continuous
  sample_pct  REAL,           -- نسبة العينة من اللقاءات (BR-05/BR-06)
  min_count   INTEGER,        -- الحد الأدنى لعدد القياسات (BR-06/BR-07)
  record_rule TEXT,           -- قاعدة حساب السجلات التشغيلية
  description TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  indicator_id INTEGER NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  text         TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (indicator_id, code)
);

-- بنك أسئلة الاستبانات المرتبط بالمؤشرات
CREATE TABLE IF NOT EXISTS question_bank (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  text         TEXT NOT NULL,
  indicator_id INTEGER REFERENCES indicators(id) ON DELETE SET NULL,
  point        TEXT NOT NULL,  -- mid | end | activity
  sort         INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------ المهام والجدولة ----------------------

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id    INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  indicator_id  INTEGER REFERENCES indicators(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,   -- checklist | survey | record
  title         TEXT NOT NULL,
  session_id    INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  activity_id   INTEGER,
  seq           INTEGER NOT NULL DEFAULT 1,  -- ترتيب القياس ضمن العينة
  assigned_role TEXT NOT NULL,
  assigned_user_id INTEGER REFERENCES users(id),
  due_date      TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | done | cancelled
  ref_type      TEXT,   -- verification | survey
  ref_id        INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  UNIQUE (program_id, indicator_id, seq, session_id)
);

-- ------------------------------ التحقق وقوائم التحقق -----------------

CREATE TABLE IF NOT EXISTS verifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  program_id   INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  indicator_id INTEGER NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  score_pct    REAL,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | submitted
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS verification_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  verification_id   INTEGER NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
  checklist_item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  state             INTEGER NOT NULL,  -- 100 | 50 | 0  (BR-02)
  note              TEXT,              -- إلزامية عند 50 أو 0 (BR-04)
  UNIQUE (verification_id, checklist_item_id)
);

-- ------------------------------ الاستبانات ---------------------------

CREATE TABLE IF NOT EXISTS surveys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  program_id   INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  point        TEXT NOT NULL,      -- mid | end | activity
  activity_id  INTEGER,
  teacher_id   INTEGER REFERENCES teachers(id),
  token        TEXT NOT NULL UNIQUE,  -- رابط التوزيع العام
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | open | closed
  opened_at    TEXT,
  closed_at    TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS survey_questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id    INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  text         TEXT NOT NULL,
  indicator_id INTEGER REFERENCES indicators(id) ON DELETE SET NULL,
  sort         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id     INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  respondent_key TEXT,
  submitted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS survey_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
  value       INTEGER NOT NULL,  -- 1..5
  UNIQUE (response_id, question_id)
);

-- ------------------------------ الخطة والمحتوى -----------------------

CREATE TABLE IF NOT EXISTS plans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id      INTEGER NOT NULL UNIQUE REFERENCES programs(id) ON DELETE CASCADE,
  objectives      TEXT,
  outcomes        TEXT,
  timeline        TEXT,
  content_outline TEXT,
  is_approved     INTEGER NOT NULL DEFAULT 0,
  approved_by     INTEGER REFERENCES users(id),
  approved_at     TEXT,
  change_note     TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------ الأنشطة ------------------------------

CREATE TABLE IF NOT EXISTS activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id    INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT,     -- إثرائي / تطبيقي / ترفيهي ...
  is_main       INTEGER NOT NULL DEFAULT 0,   -- النشاط الرئيس (BR-09)
  activity_date TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'planned', -- planned | done | cancelled
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------ الشكاوى والانضباط --------------------

CREATE TABLE IF NOT EXISTS complaints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id  INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  ref_code    TEXT,
  kind        TEXT NOT NULL DEFAULT 'complaint', -- complaint | suggestion
  source      TEXT,     -- طالب / ولي أمر / معلم ...
  title       TEXT NOT NULL,
  body        TEXT,
  severity    TEXT NOT NULL DEFAULT 'normal',
  sla_days    INTEGER NOT NULL DEFAULT 5,
  due_date    TEXT,
  assigned_to INTEGER REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'open', -- open | in_progress | closed
  opened_at   TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at   TEXT,
  close_note  TEXT,
  verified_by INTEGER REFERENCES users(id),   -- التحقق النهائي (مدير التخطيط والجودة)
  verified_at TEXT
);

CREATE TABLE IF NOT EXISTS discipline_cases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id  INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  student_id  INTEGER REFERENCES students(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'attendance', -- attendance | behavior | academic
  description TEXT NOT NULL,
  action      TEXT,
  channel     TEXT,   -- قناة التواصل
  status      TEXT NOT NULL DEFAULT 'open', -- open | followed | closed
  opened_at   TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at   TEXT,
  created_by  INTEGER REFERENCES users(id)
);

-- ------------------------------ الإجراءات التصحيحية ------------------

CREATE TABLE IF NOT EXISTS corrective_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id  INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'corrective', -- corrective | improvement
  origin_type TEXT,    -- verification | survey | complaint | manual
  origin_id   INTEGER,
  title       TEXT NOT NULL,
  description TEXT,
  owner_id    INTEGER REFERENCES users(id),
  due_date    TEXT,
  status      TEXT NOT NULL DEFAULT 'open', -- open | in_progress | done | cancelled
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at   TEXT,
  close_note  TEXT
);

-- ------------------------------ الشواهد والتنبيهات والتدقيق ----------

CREATE TABLE IF NOT EXISTS evidences (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,   -- verification | complaint | activity | teacher | plan | corrective_action | discipline_case
  entity_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'link', -- file | link
  title       TEXT,
  url         TEXT,
  file_name   TEXT,
  file_path   TEXT,
  mime_type   TEXT,
  size_bytes  INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id INTEGER REFERENCES programs(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,  -- due_soon | overdue | sample_gap | not_met | info
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  dedupe_key TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  user_name   TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   INTEGER,
  program_id  INTEGER,
  before_json TEXT,
  after_json  TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------ الفهارس ------------------------------

CREATE INDEX IF NOT EXISTS ix_tasks_user     ON tasks(assigned_user_id, status, due_date);
CREATE INDEX IF NOT EXISTS ix_tasks_program  ON tasks(program_id, status);
CREATE INDEX IF NOT EXISTS ix_tasks_role     ON tasks(program_id, assigned_role, status);
CREATE INDEX IF NOT EXISTS ix_verif_program  ON verifications(program_id, indicator_id, status);
CREATE INDEX IF NOT EXISTS ix_assign_user    ON program_assignments(user_id);
CREATE INDEX IF NOT EXISTS ix_assign_program ON program_assignments(program_id);
CREATE INDEX IF NOT EXISTS ix_students_prog  ON students(program_id, status);
CREATE INDEX IF NOT EXISTS ix_sessions_prog  ON sessions(program_id, seq);
CREATE INDEX IF NOT EXISTS ix_evid_entity    ON evidences(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_notif_user     ON notifications(user_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_entity   ON audit_logs(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_program  ON audit_logs(program_id, created_at);
CREATE INDEX IF NOT EXISTS ix_complaints_p   ON complaints(program_id, status);
CREATE INDEX IF NOT EXISTS ix_actions_p      ON corrective_actions(program_id, status);
CREATE INDEX IF NOT EXISTS ix_surveys_p      ON surveys(program_id, point, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notif_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- =====================================================================
-- الإصدار الثاني من المقياس: ضبط الاستبانات + قياس الأثر
-- =====================================================================

-- دعوات الاستبانة: رمز فريد لكل طالب يمنع التكرار ويحفظ سرية الإجابة.
-- الجدول يسجّل «أن الطالب أجاب» فقط، ولا يربط إجابته بهويته إطلاقًا.
CREATE TABLE IF NOT EXISTS survey_invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id  INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  token      TEXT    NOT NULL UNIQUE,
  used_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (survey_id, student_id)
);

-- ------------------------------ قياس الأثر ---------------------------
-- وحدة مستقلة تمامًا عن مقياس الـ300: تقيس ما تعلّمه الطالب فعلًا،
-- ولا تدخل في احتساب الدرجة ولا في اكتمال القياس.

CREATE TABLE IF NOT EXISTS impact_tools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id  INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,         -- pre | post | practical
  max_score   REAL    NOT NULL DEFAULT 100,
  mastery_pct REAL    NOT NULL DEFAULT 80,   -- حد الإتقان
  applied_at  TEXT,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS impact_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id     INTEGER NOT NULL REFERENCES impact_tools(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score       REAL    NOT NULL,
  note        TEXT,
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tool_id, student_id)
);

CREATE INDEX IF NOT EXISTS ix_invites_survey ON survey_invites(survey_id, used_at);
CREATE INDEX IF NOT EXISTS ix_impact_tools_p ON impact_tools(program_id, kind);
CREATE INDEX IF NOT EXISTS ix_impact_res     ON impact_results(tool_id);

-- استثناء مؤشر من مقياس برنامج معيّن («غير منطبق»).
-- الوزن المستثنى يخرج من المقياس ومن اكتمال القياس، والسبب إلزامي وموثّق.
CREATE TABLE IF NOT EXISTS indicator_exemptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id   INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  indicator_id INTEGER NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  reason       TEXT    NOT NULL,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (program_id, indicator_id)
);

CREATE INDEX IF NOT EXISTS ix_exempt_program ON indicator_exemptions(program_id);
