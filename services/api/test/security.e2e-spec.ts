import {
  createTestApp,
  closeTestApp,
  registerOrg,
  login,
  createStudent,
  createMonitor,
  createExam,
  authed,
  uniqueEmail,
  type TestCtx,
} from './test-utils';

describe('security & multi-tenancy (e2e)', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('isolates organizations: A cannot read B exams/students/results', async () => {
    const orgA = await registerOrg(ctx, `Isolation A ${Date.now()}`);
    const orgB = await registerOrg(ctx, `Isolation B ${Date.now()}`);

    const studentB = await createStudent(ctx, orgB.accessToken);
    const examB = await createExam(ctx, orgB.accessToken);
    await ctx.http
      .post(`/api/v1/exams/${examB.id}/students`)
      .set(authed(orgB.accessToken))
      .send({ studentIds: [studentB.id] })
      .expect(201);

    // Org A tries to read B's exam, students, results, audit
    await ctx.http.get(`/api/v1/exams/${examB.id}`).set(authed(orgA.accessToken)).expect(404);
    await ctx.http.get(`/api/v1/students`).set(authed(orgA.accessToken)).expect(200)
      .then((res: any) => expect(res.body.some((s: { email: string }) => s.email === studentB.email)).toBe(false));
    await ctx.http.get(`/api/v1/exams/${examB.id}/results`).set(authed(orgA.accessToken)).expect(404);
    await ctx.http.get(`/api/v1/audit`).set(authed(orgA.accessToken)).expect(200)
      .then((res: any) => expect(res.body.rows.every((r: { organizationId: string }) => r.organizationId === orgA.user.organizationId)).toBe(true));
  });

  it('blocks cross-org attempt access', async () => {
    const orgA = await registerOrg(ctx, `Attempt A ${Date.now()}`);
    const orgB = await registerOrg(ctx, `Attempt B ${Date.now()}`);
    const studentA = await createStudent(ctx, orgA.accessToken);
    const examA = await createExam(ctx, orgA.accessToken);
    await ctx.http
      .post(`/api/v1/exams/${examA.id}/students`)
      .set(authed(orgA.accessToken))
      .send({ studentIds: [studentA.id] })
      .expect(201);
    const studentALogin = await login(ctx, studentA.email);
    const start = await ctx.http
      .post(`/api/v1/attempts`)
      .set(authed(studentALogin.accessToken))
      .send({ examId: examA.id })
      .expect(201);

    const studentB = await createStudent(ctx, orgB.accessToken);
    const studentBLogin = await login(ctx, studentB.email);
    await ctx.http
      .get(`/api/v1/attempts/${start.body.attempt.id}`)
      .set(authed(studentBLogin.accessToken))
      .expect(403);
  });

  it('student cannot access admin APIs (privilege escalation)', async () => {
    const org = await registerOrg(ctx, `Escalation ${Date.now()}`);
    const student = await createStudent(ctx, org.accessToken);
    const token = (await login(ctx, student.email)).accessToken;

    await ctx.http.get(`/api/v1/users`).set(authed(token)).expect(403);
    await ctx.http.get(`/api/v1/organizations`).set(authed(token)).expect(403);
    await ctx.http.get(`/api/v1/audit`).set(authed(token)).expect(403);
    await ctx.http.get(`/api/v1/reports/dashboard`).set(authed(token)).expect(403);
    await ctx.http.post(`/api/v1/exams`).set(authed(token)).send({ name: 'x' }).expect(403);
  });

  it('monitor cannot access unassigned students or admin operations', async () => {
    const org = await registerOrg(ctx, `Monitor scope ${Date.now()}`);
    const student = await createStudent(ctx, org.accessToken);
    const examA = await createExam(ctx, org.accessToken);
    const examB = await createExam(ctx, org.accessToken);
    await ctx.http
      .post(`/api/v1/exams/${examA.id}/students`)
      .set(authed(org.accessToken))
      .send({ studentIds: [student.id] })
      .expect(201);

    const monitorProfile = await createMonitor(ctx, org.accessToken);
    const monitor = (await login(ctx, monitorProfile.email)).accessToken;

    // Not assigned to examA (no monitor assignment) → forbidden
    await ctx.http
      .get(`/api/v1/monitoring/exams/${examA.id}/students`)
      .set(authed(monitor))
      .expect(403);
    // Assigned to nothing, cannot see any monitoring exam
    const exams = await ctx.http.get(`/api/v1/monitoring/exams`).set(authed(monitor)).expect(200);
    expect(exams.body.length).toBe(0);
    // Monitor cannot perform admin ops
    await ctx.http.get(`/api/v1/users`).set(authed(monitor)).expect(403);
    await ctx.http.delete(`/api/v1/exams/${examB.id}`).set(authed(monitor)).expect(403);
  });

  it('rejects submit after termination and writes the termination audit', async () => {
    const org = await registerOrg(ctx, `Terminate ${Date.now()}`);
    const student = await createStudent(ctx, org.accessToken);
    const exam = await createExam(ctx, org.accessToken);
    await ctx.http
      .post(`/api/v1/exams/${exam.id}/students`)
      .set(authed(org.accessToken))
      .send({ studentIds: [student.id] })
      .expect(201);
    const monitorProfile = await createMonitor(ctx, org.accessToken);
    const monitor = (await login(ctx, monitorProfile.email)).accessToken;
    await ctx.http
      .post(`/api/v1/exams/${exam.id}/monitors`)
      .set(authed(org.accessToken))
      .send({ monitorIds: [monitorProfile.id] })
      .expect(201);

    const studentLogin = await login(ctx, student.email);
    const start = await ctx.http
      .post(`/api/v1/attempts`)
      .set(authed(studentLogin.accessToken))
      .send({ examId: exam.id })
      .expect(201);
    const attemptId = start.body.attempt.id;

    await ctx.http
      .post(`/api/v1/monitoring/students/${student.id}/terminate`)
      .set(authed(monitor))
      .send({ reason: 'Confirmed unauthorized materials' })
      .expect(201);

    await ctx.http
      .post(`/api/v1/attempts/${attemptId}/submit`)
      .set(authed(studentLogin.accessToken))
      .expect(409);
    await ctx.http
      .post(`/api/v1/attempts/${attemptId}/answers`)
      .set(authed(studentLogin.accessToken))
      .send({ questionId: '00000000-0000-4000-8000-000000000001', value: 'x' })
      .expect(409);

    const audit = await ctx.http.get(`/api/v1/audit`).set(authed(org.accessToken)).expect(200);
    expect(audit.body.rows.some((r: { action: string }) => r.action === 'monitoring.terminate')).toBe(true);
  });

  it('rejects writes after the server-authoritative deadline (time security)', async () => {
    const org = await registerOrg(ctx, `Timing ${Date.now()}`);
    const student = await createStudent(ctx, org.accessToken);
    const exam = await createExam(ctx, org.accessToken, { durationMinutes: 30 });
    await ctx.http
      .post(`/api/v1/exams/${exam.id}/students`)
      .set(authed(org.accessToken))
      .send({ studentIds: [student.id] })
      .expect(201);
    const studentLogin = await login(ctx, student.email);
    const start = await ctx.http
      .post(`/api/v1/attempts`)
      .set(authed(studentLogin.accessToken))
      .send({ examId: exam.id })
      .expect(201);
    const attemptId = start.body.attempt.id;

    // Move the attempt's start into the past → server deadline already passed
    await ctx.prisma.examAttempt.update({
      where: { id: attemptId },
      data: { startedAt: new Date(Date.now() - 31 * 60_000) },
    });

    // Student clock manipulation is irrelevant; the server rejects the write
    await ctx.http
      .post(`/api/v1/attempts/${attemptId}/answers`)
      .set(authed(studentLogin.accessToken))
      .send({ questionId: '00000000-0000-4000-8000-000000000001', value: 'x' })
      .expect(409);

    // Heartbeat triggers server-side auto-submit
    const hb = await ctx.http
      .post(`/api/v1/attempts/${attemptId}/heartbeat`)
      .set(authed(studentLogin.accessToken))
      .expect(201);
    expect(hb.body.status).toBe('AUTO_SUBMITTED');
  });

  it('validates monitor creation and negative-marking values (400, not 500)', async () => {
    const org = await registerOrg(ctx, `Monitor DTO ${Date.now()}`);
    // Missing password must be a validation 400, never a 500.
    await ctx.http
      .post(`/api/v1/monitors`)
      .set(authed(org.accessToken))
      .send({ email: uniqueEmail('monitor-nopw'), firstName: 'No', lastName: 'Password' })
      .expect(400);
    await ctx.http
      .post(`/api/v1/monitors`)
      .set(authed(org.accessToken))
      .send({ email: uniqueEmail('monitor-bad'), password: 'short', firstName: 'Bad', lastName: 'Pw' })
      .expect(400);
    // Negative marking is a fraction in 0..1
    await ctx.http
      .post(`/api/v1/exams`)
      .set(authed(org.accessToken))
      .send({ name: 'Bad neg', durationMinutes: 30, negativeMarkingEnabled: true, negativeMarkingValue: 2.5 })
      .expect(400);
  });

  it('applies the exam-level negative-marking override when scoring', async () => {
    const org = await registerOrg(ctx, `NegMark ${Date.now()}`);
    // Negative marking is a fraction in 0..1
    const exam = await createExam(ctx, org.accessToken, { negativeMarkingValue: 0.5 });
    const student = await createStudent(ctx, org.accessToken);
    await ctx.http
      .post(`/api/v1/exams/${exam.id}/students`)
      .set(authed(org.accessToken))
      .send({ studentIds: [student.id] })
      .expect(201);
    const mk = async (text: string) => {
      const r = await ctx.http
        .post(`/api/v1/questions`)
        .set(authed(org.accessToken))
        .send({
          type: 'SINGLE_CHOICE',
          text,
          marks: 2,
          negativeMarks: 0.25,
          options: [
            { text: 'A', isCorrect: true },
            { text: 'B', isCorrect: false },
          ],
        })
        .expect(201);
      return r.body as { id: string };
    };
    const [qRight, qWrong] = [await mk('Neg override right'), await mk('Neg override wrong')];
    await ctx.http
      .post(`/api/v1/exams/${exam.id}/questions`)
      .set(authed(org.accessToken))
      .send({ questionIds: [qRight.id, qWrong.id] })
      .expect(201);
    const studentLogin = await login(ctx, student.email);
    const start = await ctx.http
      .post(`/api/v1/attempts`)
      .set(authed(studentLogin.accessToken))
      .send({ examId: exam.id })
      .expect(201);
    const attemptId = start.body.attempt.id;
    const qs = start.body.questions as Array<{ id: string; options: Array<{ id: string; text: string }> }>;
    const rightQ = qs.find((q) => q.id === qRight.id)!;
    const wrongQ = qs.find((q) => q.id === qWrong.id)!;
    // Answer qRight correctly (option A) and qWrong incorrectly (option B).
    await ctx.http
      .post(`/api/v1/attempts/${attemptId}/answers`)
      .set(authed(studentLogin.accessToken))
      .send({ questionId: rightQ.id, value: rightQ.options.find((o) => o.text === 'A')!.id })
      .expect(201);
    await ctx.http
      .post(`/api/v1/attempts/${attemptId}/answers`)
      .set(authed(studentLogin.accessToken))
      .send({ questionId: wrongQ.id, value: wrongQ.options.find((o) => o.text === 'B')!.id })
      .expect(201);
    const submit = await ctx.http
      .post(`/api/v1/attempts/${attemptId}/submit`)
      .set(authed(studentLogin.accessToken))
      .expect(201);
    // Right answer +2 marks; wrong answer deducts the exam-level override
    // 0.5 → total exactly 1.5 (not 1.75 from the question-level 0.25).
    expect(submit.body.score).toBe(1.5);
  });

  it('rejects DTO whitelist violations', async () => {
    const org = await registerOrg(ctx, `Whitelist ${Date.now()}`);
    await ctx.http
      .post(`/api/v1/exams`)
      .set(authed(org.accessToken))
      .send({ name: 'X', evil: 'injected', organizationId: org.user.organizationId })
      .expect(400);
  });

  it('rejects refresh tokens after logout (revocation)', async () => {
    const org = await registerOrg(ctx, `Revoke ${Date.now()}`);
    await ctx.http
      .post(`/api/v1/auth/logout`)
      .set(authed(org.accessToken))
      .expect(200);
    await ctx.http
      .post(`/api/v1/auth/refresh`)
      .send({ refreshToken: org.refreshToken })
      .expect(401);
  });

  it('rate-limits login attempts (default 10/min per IP)', async () => {
    const limit = Number(process.env.THROTTLE_AUTH_LIMIT ?? 10);
    const email = uniqueEmail('ratelimit');
    // Earlier tests in this file share the login budget, so probe until the
    // endpoint starts returning 429 (must happen within limit + 2 attempts).
    let saw429 = false;
    for (let i = 0; i < limit + 2 && !saw429; i += 1) {
      const res = await ctx.http
        .post(`/api/v1/auth/login`)
        .send({ email, password: 'wrong-password-123' });
      if (res.status === 429) {
        saw429 = true;
      } else {
        expect(res.status).toBe(401);
      }
    }
    expect(saw429).toBe(true);
  });
});