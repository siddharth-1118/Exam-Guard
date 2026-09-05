import {
  createTestApp,
  closeTestApp,
  registerOrg,
  login,
  createStudent,
  createMonitor,
  createExam,
  createMcqQuestion,
  authed,
  type TestCtx,
} from './test-utils';

describe('exam lifecycle (e2e)', () => {
  let ctx: TestCtx;
  let adminToken: string;
  let studentToken: string;
  let student: { id: string; email: string; studentCode: string };
  let monitorToken: string;
  let examId: string;
  let questionId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const admin = await registerOrg(ctx, `Lifecycle ${Date.now()}`);
    adminToken = admin.accessToken;

    student = await createStudent(ctx, adminToken);
    const studentLogin = await login(ctx, student.email);
    studentToken = studentLogin.accessToken;

    const monitor = await createMonitor(ctx, adminToken);
    const monitorLogin = await login(ctx, monitor.email);
    monitorToken = monitorLogin.accessToken;

    examId = (await createExam(ctx, adminToken)).id;
    questionId = (await createMcqQuestion(ctx, adminToken)).id;

    await ctx.http
      .post(`/api/v1/exams/${examId}/questions`)
      .set(authed(adminToken))
      .send({ questionIds: [questionId] })
      .expect(201);
    await ctx.http
      .post(`/api/v1/exams/${examId}/students`)
      .set(authed(adminToken))
      .send({ studentIds: [student.id] })
      .expect(201);
    await ctx.http
      .post(`/api/v1/exams/${examId}/monitors`)
      .set(authed(adminToken))
      .send({ monitorIds: [monitor.id] })
      .expect(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('lets the assigned student start an attempt and receive sanitized questions', async () => {
    const res = await ctx.http
      .post(`/api/v1/attempts`)
      .set(authed(studentToken))
      .send({ examId })
      .expect(201);
    expect(res.body.attempt.status).toBe('ACTIVE');
    expect(res.body.attempt.remainingMs).toBeGreaterThan(0);
    const q = res.body.questions[0];
    expect(q.id).toBe(questionId);
    // isCorrect must never reach the student
    expect(JSON.stringify(q)).not.toContain('isCorrect');
  });

  it('autosaves answers and computes remaining time from the server', async () => {
    const start = await ctx.http
      .post(`/api/v1/attempts`)
      .set(authed(studentToken))
      .send({ examId })
      .expect(201);
    const attemptId = start.body.attempt.id;

    const saved = await ctx.http
      .post(`/api/v1/attempts/${attemptId}/answers`)
      .set(authed(studentToken))
      .send({ questionId, value: 'x' })
      .expect(201);
    expect(saved.body.savedAt).toBeTruthy();
    expect(typeof saved.body.remainingMs).toBe('number');

    // Save the real correct option id
    const getRes = await ctx.http
      .get(`/api/v1/attempts/${attemptId}`)
      .set(authed(studentToken))
      .expect(200);
    const correctId = getRes.body.questions[0].options.find((o: { text: string }) => o.text === 'A').id;
    await ctx.http
      .post(`/api/v1/attempts/${attemptId}/answers`)
      .set(authed(studentToken))
      .send({ questionId, value: correctId })
      .expect(201);
    const heartbeat = await ctx.http
      .post(`/api/v1/attempts/${attemptId}/heartbeat`)
      .set(authed(studentToken))
      .expect(201);
    expect(heartbeat.body.status).toBe('ACTIVE');
  });

  it('enforces pause server-side: student cannot answer while paused', async () => {
    const start = await ctx.http
      .post(`/api/v1/attempts`)
      .set(authed(studentToken))
      .send({ examId })
      .expect(201);
    const attemptId = start.body.attempt.id;

    const paused = await ctx.http
      .post(`/api/v1/monitoring/students/${student.id}/pause`)
      .set(authed(monitorToken))
      .send({ durationSeconds: 300, reason: 'Security verification required' })
      .expect(201);
    expect(paused.body.status).toBe('PAUSED');

    await ctx.http
      .post(`/api/v1/attempts/${attemptId}/answers`)
      .set(authed(studentToken))
      .send({ questionId, value: 'x' })
      .then((res: any) => expect(res.status).toBe(409));

    const resumed = await ctx.http
      .post(`/api/v1/monitoring/students/${student.id}/resume`)
      .set(authed(monitorToken))
      .send({ reason: 'Verification complete' })
      .expect(201);
    expect(resumed.body.status).toBe('ACTIVE');
  });

  it('submits and scores server-side', async () => {
    const start = await ctx.http
      .post(`/api/v1/attempts`)
      .set(authed(studentToken))
      .send({ examId })
      .expect(201);
    const attemptId = start.body.attempt.id;
    const getRes = await ctx.http
      .get(`/api/v1/attempts/${attemptId}`)
      .set(authed(studentToken))
      .expect(200);
    const correctId = getRes.body.questions[0].options.find((o: { text: string }) => o.text === 'A').id;
    await ctx.http
      .post(`/api/v1/attempts/${attemptId}/answers`)
      .set(authed(studentToken))
      .send({ questionId, value: correctId })
      .expect(201);

    const submitted = await ctx.http
      .post(`/api/v1/attempts/${attemptId}/submit`)
      .set(authed(studentToken))
      .expect(201);
    expect(submitted.body.status).toBe('SUBMITTED');
    expect(submitted.body.score).toBe(1);

    // Duplicate submit rejected
    await ctx.http
      .post(`/api/v1/attempts/${attemptId}/submit`)
      .set(authed(studentToken))
      .expect(409);

    const results = await ctx.http
      .get(`/api/v1/exams/${examId}/results`)
      .set(authed(adminToken))
      .expect(200);
    expect(results.body.some((r: { score: number }) => r.score === 1)).toBe(true);
  });

  it('lets the monitor see assigned students with risk info', async () => {
    const students = await ctx.http
      .get(`/api/v1/monitoring/exams/${examId}/students`)
      .set(authed(monitorToken))
      .expect(200);
    expect(Array.isArray(students.body)).toBe(true);
    const exams = await ctx.http
      .get(`/api/v1/monitoring/exams`)
      .set(authed(monitorToken))
      .expect(200);
    expect(exams.body.some((e: { id: string }) => e.id === examId)).toBe(true);
  });

  it('deduplicates proctoring events retried with the same clientEventId', async () => {
    const fresh = await createStudent(ctx, adminToken);
    await ctx.http
      .post(`/api/v1/exams/${examId}/students`)
      .set(authed(adminToken))
      .send({ studentIds: [fresh.id] })
      .expect(201);
    const freshToken = (await login(ctx, fresh.email)).accessToken;
    const start = await ctx.http
      .post(`/api/v1/attempts`)
      .set(authed(freshToken))
      .send({ examId })
      .expect(201);
    const attemptId = start.body.attempt.id;
    const payload = {
      attemptId,
      type: 'EXAM_WINDOW_LOST_FOCUS',
      severity: 'WARNING',
      clientEventId: `client-${Date.now()}`, // stable across retries
      detail: { reason: 'alt-tab' },
    };
    const first = await ctx.http
      .post(`/api/v1/proctoring/events`)
      .set(authed(freshToken))
      .send(payload)
      .expect(201);
    // Simulate a retry after network loss — must not duplicate the row.
    const second = await ctx.http
      .post(`/api/v1/proctoring/events`)
      .set(authed(freshToken))
      .send(payload)
      .expect(201);
    expect(second.body.id).toBe(first.body.id);
    const count = await ctx.prisma.proctoringEvent.count({
      where: { attemptId, clientEventId: payload.clientEventId },
    });
    expect(count).toBe(1);
  });

  it('upserts camera/mic/screen sessions and reflects them to the monitor', async () => {
    const fresh = await createStudent(ctx, adminToken);
    await ctx.http
      .post(`/api/v1/exams/${examId}/students`)
      .set(authed(adminToken))
      .send({ studentIds: [fresh.id] })
      .expect(201);
    const freshToken = (await login(ctx, fresh.email)).accessToken;
    const start = await ctx.http
      .post(`/api/v1/attempts`)
      .set(authed(freshToken))
      .send({ examId })
      .expect(201);
    const attemptId = start.body.attempt.id;
    await ctx.http
      .post(`/api/v1/proctoring/sessions`)
      .set(authed(freshToken))
      .send({ attemptId, kind: 'CAMERA', status: 'ACTIVE' })
      .expect(201);
    await ctx.http
      .post(`/api/v1/proctoring/sessions`)
      .set(authed(freshToken))
      .send({ attemptId, kind: 'MICROPHONE', status: 'ACTIVE', muted: false, audioLevel: 0.4 })
      .expect(201);
    await ctx.http
      .post(`/api/v1/proctoring/sessions`)
      .set(authed(freshToken))
      .send({ attemptId, kind: 'SCREEN', status: 'ACTIVE' })
      .expect(201);
    const row = await ctx.prisma.cameraSession.findUnique({ where: { attemptId } });
    expect(row?.status).toBe('ACTIVE');
    const students = await ctx.http
      .get(`/api/v1/monitoring/exams/${examId}/students`)
      .set(authed(monitorToken))
      .expect(200);
    const me = students.body.find((s: { attemptId: string | null }) => s.attemptId === attemptId);
    expect(me.cameraConnected).toBe(true);
    expect(me.micConnected).toBe(true);
    expect(me.screenConnected).toBe(true);
  });
});