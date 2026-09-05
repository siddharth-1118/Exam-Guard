/**
 * PrivacyService unit tests (C38 GDPR).
 * Mocks Prisma with an in-memory store following the recordings.service.spec.ts
 * pattern. Exercises export, deletion, authorization, and edge cases.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { UserContext } from '../common/types';
import { PrivacyService } from './privacy.service';

// ---------------------------------------------------------------------------
// Fake database
// ---------------------------------------------------------------------------

interface FakeDb {
  students: Array<{
    id: string; userId: string; organizationId: string; studentCode: string; isActive: boolean;
    createdAt: Date;
  }>;
  users: Array<{
    id: string; email: string; firstName: string; lastName: string; passwordHash: string;
    isActive: boolean; tokenVersion: number;
  }>;
  organizations: Array<{ id: string; name: string }>;
  attempts: Array<{
    id: string; examId: string; studentId: string; organizationId: string; status: string;
    startedAt: Date | null; submittedAt: Date | null; score: number | null;
    autoSubmitted: boolean; consent: unknown; createdAt: Date;
  }>;
  answers: Array<{
    attemptId: string; questionId: string; value: unknown; syncedFromOffline: boolean;
    createdAt: Date;
  }>;
  proctoringEvents: Array<{
    id: string; studentId: string; type: string; severity: string; capturedAt: Date;
    detail: unknown;
  }>;
  aiEvents: Array<{
    id: string; eventType: string; confidence: number; status: string; capturedAt: Date;
  }>;
  recordings: Array<{
    id: string; kind: string; status: string; durationMs: number | null; createdAt: Date;
  }>;
  auditLogs: Array<{ action: string; resourceType: string; resourceId: string }>;
  transactionOps: Array<{ target: string; data: unknown }>;
}

function baseDb(): FakeDb {
  const now = new Date();
  return {
    students: [
      { id: 'stu-1', userId: 'user-1', organizationId: 'org-a', studentCode: 'S001', isActive: true, createdAt: now },
      { id: 'stu-2', userId: 'user-2', organizationId: 'org-b', studentCode: 'S002', isActive: true, createdAt: now },
    ],
    users: [
      { id: 'user-1', email: 'alice@test.com', firstName: 'Alice', lastName: 'Smith', passwordHash: 'hash1', isActive: true, tokenVersion: 0 },
      { id: 'user-2', email: 'bob@test.com', firstName: 'Bob', lastName: 'Jones', passwordHash: 'hash2', isActive: true, tokenVersion: 0 },
    ],
    organizations: [
      { id: 'org-a', name: 'Test Org A' },
      { id: 'org-b', name: 'Test Org B' },
    ],
    attempts: [
      { id: 'att-1', examId: 'exam-1', studentId: 'stu-1', organizationId: 'org-a', status: 'ACTIVE', startedAt: now, submittedAt: null, score: null, autoSubmitted: false, consent: { camera: true }, createdAt: now },
    ],
    answers: [
      { attemptId: 'att-1', questionId: 'q-1', value: 'A', syncedFromOffline: false, createdAt: now },
    ],
    proctoringEvents: [
      { id: 'evt-1', studentId: 'stu-1', type: 'CAMERA_CONNECTED', severity: 'INFO', capturedAt: now, detail: null },
    ],
    aiEvents: [
      { id: 'ai-1', eventType: 'FACE_MISSING', confidence: 0.8, status: 'PENDING', capturedAt: now },
    ],
    recordings: [
      { id: 'rec-1', kind: 'CAMERA', status: 'READY', durationMs: 5000, createdAt: now },
    ],
    auditLogs: [],
    transactionOps: [],
  };
}

function resolveStudent(db: FakeDb, id: string) {
  const s = db.students.find((x) => x.id === id);
  if (!s) return null;
  const u = db.users.find((x) => x.id === s.userId)!;
  const org = db.organizations.find((x) => x.id === s.organizationId)!;
  return { ...s, user: u, organization: org };
}

/** Simulate Prisma's { increment: N } shorthand. */
function applyIncrement(value: unknown, target: Record<string, unknown>, key: string): void {
  if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
    target[key] = (target[key] as number) + (value as { increment: number }).increment;
  } else {
    target[key] = value;
  }
}

function makePrisma(db: FakeDb) {
  // eslint-disable-next-line prefer-const
  let prisma: Record<string, unknown>;
  prisma = {
    student: {
      findUnique: jest.fn(async ({ where, include }: { where: { id?: string; userId?: string }; include?: Record<string, boolean> }) => {
        let s;
        if (where.id) s = db.students.find((x) => x.id === where.id);
        else s = db.students.find((x) => x.userId === where.userId);
        if (!s) return null;
        if (include?.user || include?.organization) return resolveStudent(db, s.id);
        return s;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const idx = db.students.findIndex((s) => s.id === where.id);
        if (idx < 0) return null;
        Object.assign(db.students[idx], data);
        return db.students[idx];
      }),
    },
    user: {
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const idx = db.users.findIndex((u) => u.id === where.id);
        if (idx < 0) return null;
        applyIncrement(data.tokenVersion, db.users[idx] as Record<string, unknown>, 'tokenVersion');
        for (const [k, v] of Object.entries(data)) {
          if (k === 'tokenVersion') continue;
          (db.users[idx] as Record<string, unknown>)[k] = v;
        }
        return db.users[idx];
      }),
    },
    examAttempt: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return db.attempts.filter((a) => a.studentId === where.studentId);
      }),
    },
    answer: {
      findMany: jest.fn(async () => db.answers),
    },
    proctoringEvent: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return db.proctoringEvents.filter((e) => e.studentId === where.studentId);
      }),
    },
    aiEvent: {
      findMany: jest.fn(async () => db.aiEvents),
    },
    recording: {
      findMany: jest.fn(async () => db.recordings),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: { action: string } }) => {
        db.auditLogs.push(data as never);
        return data;
      }),
      count: jest.fn(async () => db.auditLogs.length),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      db.transactionOps = [];
      await fn(prisma);
      return prisma;
    }),
  };
  return prisma;
}

function user(overrides: Partial<UserContext> = {}): UserContext {
  return {
    userId: 'admin-1', email: 'admin@test.com', firstName: 'A', lastName: 'Admin',
    role: 'ORG_ADMIN', orgId: 'org-a', permissions: [], isSuperAdmin: false,
    ...overrides,
  };
}

function makeSvc(db: FakeDb) {
  const prisma = makePrisma(db) as unknown as ConstructorParameters<typeof PrivacyService>[0];
  return { svc: new PrivacyService(prisma), prisma, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PrivacyService — export', () => {
  it('returns structured JSON with all student data fields', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const result = await svc.exportStudentData(user({}), 'stu-1');

    expect(result.student.id).toBe('stu-1');
    expect(result.student.email).toBe('alice@test.com');
    expect(result.student.firstName).toBe('Alice');
    expect(result.organization.id).toBe('org-a');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].id).toBe('att-1');
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].questionId).toBe('q-1');
    expect(result.proctoringEvents).toHaveLength(1);
    expect(result.aiEvents).toHaveLength(1);
    expect(result.recordings).toHaveLength(1);
    expect(result.consent).toEqual({ camera: true });
    expect(result.metadata.totalAttempts).toBe(1);
    expect(result.metadata.totalAnswers).toBe(1);
  });

  it('audits the export request', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    await svc.exportStudentData(user({}), 'stu-1');
    expect(db.auditLogs.some((a) => a.action === 'gdpr.export')).toBe(true);
  });

  it('rejects export for unknown student', async () => {
    const { svc } = makeSvc(baseDb());
    await expect(svc.exportStudentData(user({}), 'nonexistent')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('prevents student A from exporting student B data', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const otherStudent = user({ userId: 'user-2', role: 'STUDENT', orgId: 'org-a' });
    await expect(svc.exportStudentData(otherStudent, 'stu-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows student to export own data', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const owner = user({ userId: 'user-1', role: 'STUDENT', orgId: 'org-a' });
    const result = await svc.exportStudentData(owner, 'stu-1');
    expect(result.student.id).toBe('stu-1');
  });

  it('prevents cross-org admin from exporting', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const foreignAdmin = user({ orgId: 'org-b', role: 'ORG_ADMIN' });
    await expect(svc.exportStudentData(foreignAdmin, 'stu-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows super admin to export across orgs', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const superAdmin = user({ isSuperAdmin: true, orgId: null });
    const result = await svc.exportStudentData(superAdmin, 'stu-1');
    expect(result.student.id).toBe('stu-1');
  });
});

describe('PrivacyService — deletion', () => {
  it('anonymizes user data and deactivates student', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const result = await svc.requestDeletion(user({}), 'stu-1');

    expect(result.deleted).toBe(true);
    expect(result.anonymizedAt).toBeTruthy();
    expect(result.preservedAuditLogs).toBeGreaterThanOrEqual(0);

    // Verify anonymization happened in the fake DB
    const userRow = db.users.find((u) => u.id === 'user-1')!;
    expect(userRow.email).toContain('[DELETED-');
    expect(userRow.firstName).toBe('[DELETED]');
    expect(userRow.lastName).toBe('[DELETED]');
    expect(userRow.passwordHash).toBe('[DELETED]');
    expect(userRow.isActive).toBe(false);
    expect(userRow.tokenVersion).toBe(1); // 0 + increment: 1

    const studentRow = db.students.find((s) => s.id === 'stu-1')!;
    expect(studentRow.isActive).toBe(false);
  });

  it('creates deletion audit record', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    await svc.requestDeletion(user({}), 'stu-1', 'privacy request');
    expect(db.auditLogs.some((a) => a.action === 'gdpr.deletion-requested')).toBe(true);
  });

  it('handles deletion without reason', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const result = await svc.requestDeletion(user({}), 'stu-1');
    expect(result.deleted).toBe(true);
    expect(db.auditLogs.some((a) => a.action === 'gdpr.deletion-requested')).toBe(true);
  });

  it('rejects deletion for unknown student', async () => {
    const { svc } = makeSvc(baseDb());
    await expect(svc.requestDeletion(user({}), 'nonexistent')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('prevents student A from deleting student B account', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const otherStudent = user({ userId: 'user-2', role: 'STUDENT', orgId: 'org-a' });
    await expect(svc.requestDeletion(otherStudent, 'stu-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows student to delete own account', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const owner = user({ userId: 'user-1', role: 'STUDENT', orgId: 'org-a' });
    const result = await svc.requestDeletion(owner, 'stu-1');
    expect(result.deleted).toBe(true);
  });

  it('prevents cross-org admin from deleting', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const foreignAdmin = user({ orgId: 'org-b', role: 'ORG_ADMIN' });
    await expect(svc.requestDeletion(foreignAdmin, 'stu-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows super admin to delete across orgs', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const superAdmin = user({ isSuperAdmin: true, orgId: null });
    const result = await svc.requestDeletion(superAdmin, 'stu-1');
    expect(result.deleted).toBe(true);
  });

  it('second deletion is safe (user already anonymized)', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    await svc.requestDeletion(user({}), 'stu-1');
    // Second call — user already deactivated, should still succeed
    const result = await svc.requestDeletion(user({}), 'stu-1');
    expect(result.deleted).toBe(true);
  });
});
