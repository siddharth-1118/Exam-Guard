import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

/** Loose chain type — supertest chains return a request-ish object with .set/.send/.expect. */
type Http = { [method: string]: (url: string) => any };
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

process.env.APP_ENV = 'test';

export interface TestCtx {
  app: INestApplication;
  prisma: PrismaService;
  http: Http;
}

export async function createTestApp(): Promise<TestCtx> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  await app.listen(0);
  return {
    app,
    prisma: app.get(PrismaService),
    http: request(app.getHttpServer()) as unknown as Http,
  };
}

export async function closeTestApp(ctx: TestCtx): Promise<void> {
  await ctx.app.close();
}

let counter = 0;
export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@examguard.test`;
}

export const DEV_PASSWORD = 'ExamGuard!Test2026';

export async function registerOrg(ctx: TestCtx, orgName: string, email?: string) {
  const res = await ctx.http
    .post('/api/v1/auth/register')
    .send({
      email: email ?? uniqueEmail('admin'),
      password: DEV_PASSWORD,
      firstName: 'Test',
      lastName: 'Admin',
      organizationName: orgName,
    })
    .expect(201);
  return res.body as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string; role: string; organizationId: string };
  };
}

export async function login(ctx: TestCtx, email: string) {
  const res = await ctx.http
    .post('/api/v1/auth/login')
    .send({ email, password: DEV_PASSWORD })
    .expect(200);
  return res.body as { accessToken: string; refreshToken: string };
}

export function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export async function createStudent(
  ctx: TestCtx,
  adminToken: string,
  overrides: Partial<{ email: string; firstName: string; lastName: string; studentCode: string }> = {},
) {
  const email = overrides.email ?? uniqueEmail('student');
  const res = await ctx.http
    .post('/api/v1/students')
    .set(authed(adminToken))
    .send({
      email,
      password: DEV_PASSWORD,
      firstName: overrides.firstName ?? 'Sam',
      lastName: overrides.lastName ?? 'Student',
      studentCode: overrides.studentCode ?? `SC-${Date.now().toString().slice(-6)}`,
    })
    .expect(201);
  return { ...(res.body as { id: string; studentCode: string; email: string }), password: DEV_PASSWORD };
}

export async function createMonitor(
  ctx: TestCtx,
  adminToken: string,
  overrides: Partial<{ email: string; firstName: string; lastName: string }> = {},
) {
  const email = overrides.email ?? uniqueEmail('monitor');
  const res = await ctx.http
    .post('/api/v1/monitors')
    .set(authed(adminToken))
    .send({
      email,
      password: DEV_PASSWORD,
      firstName: overrides.firstName ?? 'Moni',
      lastName: overrides.lastName ?? 'Tor',
    })
    .expect(201);
  return { ...(res.body as { id: string; email: string; firstName: string; lastName: string }), password: DEV_PASSWORD };
}

export async function createExam(
  ctx: TestCtx,
  adminToken: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await ctx.http
    .post('/api/v1/exams')
    .set(authed(adminToken))
    .send({
      name: `E2E Exam ${Date.now()}`,
      durationMinutes: 30,
      maxAttempts: 1,
      negativeMarkingEnabled: true,
      negativeMarkingValue: 0.25,
      passingScore: 40,
      autoSubmit: true,
      status: 'OPEN',
      settings: {
        cameraRequired: true,
        microphoneRequired: true,
        screenMonitoringRequired: true,
        identityVerificationRequired: true,
        aiProctoringEnabled: true,
      },
      ...overrides,
    })
    .expect(201);
  return res.body as { id: string; name: string };
}

export async function createMcqQuestion(ctx: TestCtx, adminToken: string) {
  const res = await ctx.http
    .post('/api/v1/questions')
    .set(authed(adminToken))
    .send({
      type: 'SINGLE_CHOICE',
      text: 'E2E: which option is correct?',
      marks: 1,
      negativeMarks: 0.25,
      options: [
        { text: 'A', isCorrect: true, order: 1 },
        { text: 'B', isCorrect: false, order: 2 },
        { text: 'C', isCorrect: false, order: 3 },
      ],
    })
    .expect(201);
  return res.body as { id: string };
}