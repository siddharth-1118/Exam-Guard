/* Live verification probe — runs against the running API on :4000.
 * Covers: exam CRUD validation, all 7 question types, student session flow,
 * autosave persistence, server scoring, monitor interventions, audit trail,
 * dashboard mutability, cross-org isolation.
 */
const BASE = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = 'ExamGuard!Dev2026';
let failures = 0;
const results = [];

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function login(email) {
  const r = await api('/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return r;
}

(async () => {
  const admin = await login('admin@northstar.edu');
  check('seeded org-admin login', admin.status === 201 || admin.status === 200, `status=${admin.status}`);
  const adminToken = admin.json.accessToken;
  const orgId = admin.json.user.organizationId;

  // ---- Dashboard baseline ----
  const dash0 = await api('/api/v1/reports/dashboard', { token: adminToken });
  check('dashboard baseline', dash0.status === 200 && typeof dash0.json.totalStudents === 'number', JSON.stringify(dash0.json));

  // ---- Exam CRUD validation ----
  const noName = await api('/api/v1/exams', { method: 'POST', token: adminToken, body: { name: '', durationMinutes: 60 } });
  check('exam: missing name rejected', noName.status === 400, `status=${noName.status}`);
  const negDur = await api('/api/v1/exams', { method: 'POST', token: adminToken, body: { name: 'Bad', durationMinutes: -5 } });
  check('exam: negative duration rejected', negDur.status === 400, `status=${negDur.status}`);
  const badNegMark = await api('/api/v1/exams', { method: 'POST', token: adminToken, body: { name: 'Bad2', durationMinutes: 60, negativeMarkingEnabled: true, negativeMarkingValue: 2.5 } });
  check('exam: negative marking >1 rejected', badNegMark.status === 400, `status=${badNegMark.status}`);
  const noAuth = await api('/api/v1/exams', { method: 'POST', body: { name: 'NoAuth', durationMinutes: 60 } });
  check('exam: unauthenticated rejected', noAuth.status === 401, `status=${noAuth.status}`);

  // ---- Create a valid exam ----
  const exam = await api('/api/v1/exams', {
    method: 'POST', token: adminToken,
    body: {
      name: `QA Live Exam ${Date.now() % 100000}`,
      description: 'Created by the QA verification probe',
      durationMinutes: 30,
      maxAttempts: 1,
      negativeMarkingEnabled: true,
      negativeMarkingValue: 0.25,
      passingScore: 40,
      autoSubmit: true,
      status: 'OPEN',
      startAt: new Date(Date.now() - 3600_000).toISOString(),
      endAt: new Date(Date.now() + 3600_000).toISOString(),
      settings: { cameraRequired: true, microphoneRequired: true, screenMonitoringRequired: true },
    },
  });
  check('exam: valid creation', exam.status === 201, `status=${exam.status}`);
  const examId = exam.json.id;

  const patch = await api(`/api/v1/exams/${examId}`, { method: 'PATCH', token: adminToken, body: { name: exam.json.name + ' (edited)' } });
  check('exam: patch', patch.status === 200, `status=${patch.status}`);

  // ---- Questions: all 7 types ----
  const qDefs = [
    { type: 'SINGLE_CHOICE', text: 'QA: Which Java keyword is used to define a constant?', marks: 1, negativeMarks: 0.25, options: [{ text: 'final', isCorrect: true }, { text: 'static', isCorrect: false }, { text: 'let', isCorrect: false }] },
    { type: 'MULTIPLE_CHOICE', text: 'QA: Primitive types in Java?', marks: 2, negativeMarks: 0.5, options: [{ text: 'int', isCorrect: true }, { text: 'String', isCorrect: false }, { text: 'boolean', isCorrect: true }] },
    { type: 'TRUE_FALSE', text: 'QA: Java is case-sensitive.', marks: 1, negativeMarks: 0.25, options: [{ text: 'True', isCorrect: true }, { text: 'False', isCorrect: false }] },
    { type: 'SHORT_ANSWER', text: 'QA: JVM garbage collection component?', marks: 2 },
    { type: 'LONG_ANSWER', text: 'QA: Abstract class vs interface?', marks: 5 },
    { type: 'NUMERIC', text: 'QA: 2+2 = ?', marks: 1, negativeMarks: 0.25, metadata: { tolerance: 0.001 }, options: [{ text: '4', isCorrect: true }] },
    { type: 'CODE', text: 'QA: Sum an int array.', marks: 5, metadata: { language: 'java' } },
  ];
  const questionIds = [];
  for (const def of qDefs) {
    const r = await api('/api/v1/questions', { method: 'POST', token: adminToken, body: def });
    check(`question: ${def.type} created`, r.status === 201, `status=${r.status}`);
    if (r.status === 201) questionIds.push(r.json.id);
  }
  const link = await api(`/api/v1/exams/${examId}/questions`, { method: 'POST', token: adminToken, body: { questionIds } });
  check('exam: questions linked', link.status === 201 || link.status === 200, `status=${link.status}`);

  // ---- Student + assignment ----
  const stuEmail = `qa.student.${Date.now() % 100000}@northstar.edu`;
  const stu = await api('/api/v1/students', { method: 'POST', token: adminToken, body: { email: stuEmail, password: PASSWORD, firstName: 'QA', lastName: 'Student', studentCode: `QA-${Date.now() % 100000}` } });
  check('student: created', stu.status === 201, `status=${stu.status}`);
  const assign = await api(`/api/v1/exams/${examId}/students`, { method: 'POST', token: adminToken, body: { studentIds: [stu.json.id] } });
  check('student: assigned to exam', assign.status === 201 || assign.status === 200, `status=${assign.status}`);

  // ---- Monitor + assignment ----
  const monEmail = `qa.monitor.${Date.now() % 100000}@northstar.edu`;
  const mon = await api('/api/v1/monitors', { method: 'POST', token: adminToken, body: { email: monEmail, password: PASSWORD, firstName: 'QA', lastName: 'Monitor' } });
  check('monitor: created', mon.status === 201, `status=${mon.status}`);
  const monAssign = await api(`/api/v1/exams/${examId}/monitors`, { method: 'POST', token: adminToken, body: { monitorIds: [mon.json.id] } });
  check('monitor: assigned to exam', monAssign.status === 201 || monAssign.status === 200, `status=${monAssign.status}`);

  // ---- Student session flow ----
  const stuLogin = await login(stuEmail);
  check('student: login', stuLogin.status === 201 || stuLogin.status === 200, `status=${stuLogin.status}`);
  const stuToken = stuLogin.json.accessToken;

  const start = await api('/api/v1/attempts', { method: 'POST', token: stuToken, body: { examId, consent: { agreed: true, at: new Date().toISOString() }, deviceInfo: { os: 'qa-probe', appVersion: '0.0.0' } } });
  check('attempt: start', start.status === 201, `status=${start.status} ${JSON.stringify(start.json).slice(0, 120)}`);
  const attemptId = start.json.attempt?.id;
  const gotQuestions = start.json.questions;
  check('attempt: questions sanitized (no isCorrect leaked)', gotQuestions?.length === 7 && gotQuestions.every((q) => q.options === undefined || q.options.every((o) => o.isCorrect === undefined)), `count=${gotQuestions?.length}`);

  // ---- Answer + autosave persistence ----
  const mcqQ = gotQuestions[0];
  const correctOption = (mcqQ) => null; // correct answer known only to server; pick option via stored value
  // We know option ids; correct is the first option for SINGLE_CHOICE per our seed ordering.
  const ans1 = await api(`/api/v1/attempts/${attemptId}/answers`, { method: 'POST', token: stuToken, body: { questionId: mcqQ.id, value: mcqQ.options[0].id } });
  check('answer: autosave', ans1.status === 201, `status=${ans1.status} remainingMs=${ans1.json?.remainingMs}`);
  const reopen = await api(`/api/v1/attempts/${attemptId}`, { token: stuToken });
  const saved = reopen.json.answers?.find((a) => a.questionId === mcqQ.id);
  check('answer: persists after reopen', saved?.value === mcqQ.options[0].id, JSON.stringify(saved));

  // Timer sanity: remainingMs positive and ≤ duration
  check('timer: server-authoritative remainingMs', typeof ans1.json?.remainingMs === 'number' && ans1.json.remainingMs > 0 && ans1.json.remainingMs <= 30 * 60_000, `remainingMs=${ans1.json?.remainingMs}`);

  // ---- Wrong answer → negative marking ----
  const tfQ = gotQuestions[2]; // TRUE_FALSE
  const wrongOption = tfQ.options.find((o) => o.id !== tfQ.options[0].id).id; // pick the incorrect one
  await api(`/api/v1/attempts/${attemptId}/answers`, { method: 'POST', token: stuToken, body: { questionId: tfQ.id, value: wrongOption } });

  // ---- Monitor intervention: pause → student blocked ----
  const monLogin = await login(monEmail);
  check('monitor: login', monLogin.status === 201 || monLogin.status === 200, `status=${monLogin.status}`);
  const monToken = monLogin.json.accessToken;

  const monitorList = await api('/api/v1/monitoring/exams', { token: monToken });
  const monExam = monitorList.json?.find((e) => e.id === examId);
  check('monitor: sees assigned exam', !!monExam, JSON.stringify(monitorList.json).slice(0, 120));

  const pause = await api(`/api/v1/monitoring/students/${stu.json.id}/pause`, { method: 'POST', token: monToken, body: { reason: 'QA probe: pause enforcement', durationSeconds: 60 } });
  check('monitor: pause', pause.status === 201, `status=${pause.status} ${JSON.stringify(pause.json)}`);
  const blockWrite = await api(`/api/v1/attempts/${attemptId}/answers`, { method: 'POST', token: stuToken, body: { questionId: mcqQ.id, value: mcqQ.options[1].id } });
  check('pause: student cannot answer (server-enforced)', blockWrite.status === 409, `status=${blockWrite.status} ${JSON.stringify(blockWrite.json).slice(0, 100)}`);

  const resume = await api(`/api/v1/monitoring/students/${stu.json.id}/resume`, { method: 'POST', token: monToken, body: { reason: 'QA probe: resume' } });
  check('monitor: resume', resume.status === 201 && resume.json.status === 'ACTIVE', `status=${resume.status} ${JSON.stringify(resume.json)}`);

  // ---- Message + flag ----
  const msg = await api(`/api/v1/monitoring/students/${stu.json.id}/message`, { method: 'POST', token: monToken, body: { content: 'Please keep your face visible.' } });
  check('monitor: message', msg.status === 201, `status=${msg.status}`);
  const flag = await api(`/api/v1/monitoring/students/${stu.json.id}/flag`, { method: 'POST', token: monToken, body: { note: 'QA probe flag' } });
  check('monitor: flag', flag.status === 201, `status=${flag.status}`);

  // ---- Submit + server scoring ----
  const submit = await api(`/api/v1/attempts/${attemptId}/submit`, { method: 'POST', token: stuToken });
  check('attempt: submit', submit.status === 201, `status=${submit.status} ${JSON.stringify(submit.json).slice(0, 150)}`);
  // Exam mixes auto + manual (SHORT/LONG/CODE) questions → score pending manual grading.
  check('attempt: score pending manual grading (mixed exam)', submit.json.score === null, `score=${submit.json.score}`);
  const dupSubmit = await api(`/api/v1/attempts/${attemptId}/submit`, { method: 'POST', token: stuToken });
  check('attempt: double submit rejected', dupSubmit.status === 409, `status=${dupSubmit.status}`);

  // ---- Monitor sees student detail ----
  const detail = await api(`/api/v1/monitoring/students/${stu.json.id}`, { token: monToken });
  check('monitor: student detail', detail.status === 200 && detail.json.attempt?.status === 'SUBMITTED', `status=${detail.status}`);

  // ---- Audit log contains the chain ----
  const audit = await api('/api/v1/audit', { token: adminToken });
  const actions = ['attempt.start', 'attempt.submit', 'monitoring.pause', 'monitoring.resume', 'monitoring.message', 'monitoring.flag'];
  const auditRows = audit.json?.rows ?? [];
  const found = actions.filter((a) => auditRows.some((r) => r.action === a));
  check('audit: intervention chain logged', found.length === actions.length, `found=${found.join(',')}`);

  // ---- Dashboard reflects changes ----
  const dash1 = await api('/api/v1/reports/dashboard', { token: adminToken });
  check('dashboard: totalStudents increased', dash1.json.totalStudents === dash0.json.totalStudents + 1, `${dash0.json.totalStudents} → ${dash1.json.totalStudents}`);

  // ---- Cross-org isolation (live) ----
  const orgB = await api('/api/v1/auth/register', {
    method: 'POST',
    body: { email: `qa.orgb.${Date.now() % 100000}@example.com`, password: PASSWORD, firstName: 'OrgB', lastName: 'Admin', organizationName: `QA OrgB ${Date.now() % 100000}` },
  });
  check('register: org B', orgB.status === 201, `status=${orgB.status}`);
  const bToken = orgB.json.accessToken;
  const bSees = await api(`/api/v1/exams/${examId}`, { token: bToken });
  check('isolation: org B cannot read org A exam (404)', bSees.status === 404, `status=${bSees.status}`);
  const bPatch = await api(`/api/v1/exams/${examId}`, { method: 'PATCH', token: bToken, body: { name: 'hacked' } });
  check('isolation: org B cannot modify org A exam', bPatch.status === 404, `status=${bPatch.status}`);
  const bStudents = await api('/api/v1/students', { token: bToken });
  check('isolation: org B sees only its own students', bStudents.status === 200 && !bStudents.json.some((s) => s.email === stuEmail), `status=${bStudents.status}`);
  const bAudit = await api('/api/v1/audit', { token: bToken });
  check('isolation: audit scoped to org', bAudit.json?.rows.every((r) => r.organizationId === orgB.json.user.organizationId), `status=${bAudit.status}`);

  // ---- Privilege: student cannot reach admin APIs ----
  const stuAdmin = await api('/api/v1/users', { token: stuToken });
  check('privilege: student blocked from admin API', stuAdmin.status === 403, `status=${stuAdmin.status}`);

  // ---- Termination on a fresh attempt ----
  const stu2Email = `qa.term.${Date.now() % 100000}@northstar.edu`;
  const stu2 = await api('/api/v1/students', { method: 'POST', token: adminToken, body: { email: stu2Email, password: PASSWORD, firstName: 'QA', lastName: 'Term', studentCode: `QT-${Date.now() % 100000}` } });
  await api(`/api/v1/exams/${examId}/students`, { method: 'POST', token: adminToken, body: { studentIds: [stu2.json.id] } });
  const stu2Login = await login(stu2Email);
  const s2 = await api('/api/v1/attempts', { method: 'POST', token: stu2Login.json.accessToken, body: { examId, consent: { agreed: true }, deviceInfo: { os: 'qa-probe' } } });
  const term = await api(`/api/v1/monitoring/students/${stu2.json.id}/terminate`, { method: 'POST', token: monToken, body: { reason: 'QA probe: termination' } });
  check('monitor: terminate', term.status === 201 && term.json.status === 'TERMINATED', `status=${term.status}`);
  const afterTerm = await api(`/api/v1/attempts/${s2.json.attempt.id}/submit`, { method: 'POST', token: stu2Login.json.accessToken });
  check('termination: submit after terminate rejected', afterTerm.status === 409, `status=${afterTerm.status}`);

  // ---- Token security ----
  const badTok = await api('/api/v1/exams', { token: 'garbage.token.here' });
  check('token: garbage rejected', badTok.status === 401, `status=${badTok.status}`);
  const modifiedTok = adminToken.slice(0, -4) + 'AAAA';
  const modTok = await api('/api/v1/exams', { token: modifiedTok });
  check('token: modified rejected', modTok.status === 401, `status=${modTok.status}`);

  // ---- Input validation probes ----
  const huge = await api('/api/v1/exams', { method: 'POST', token: adminToken, body: { name: 'x'.repeat(5000), durationMinutes: 60 } });
  check('validation: oversized name rejected', huge.status === 400, `status=${huge.status}`);
  const sql = await api('/api/v1/exams', { method: 'POST', token: adminToken, body: { name: "'; DROP TABLE exams;--", durationMinutes: 60 } });
  check('validation: SQL-like string handled (no 500)', sql.status === 400 || sql.status === 201, `status=${sql.status}`);
  const badUuid = await api('/api/v1/exams/not-a-uuid', { token: adminToken });
  check('validation: invalid uuid handled', badUuid.status === 400 || badUuid.status === 404, `status=${badUuid.status}`);

  console.log(`\n===== ${results.length - failures}/${results.length} passed =====`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('SCRIPT ERROR:', e.message); process.exit(2); });