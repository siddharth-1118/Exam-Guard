/**
 * RecordingsService security matrix (Phase 5). Prisma is mocked with an
 * in-memory store; storage is an in-memory double of RecordingStorage so the
 * full lifecycle — including storage verification and failure — is exercised
 * without external services. Isolation expectations mirror production rules:
 * anything the caller must not see surfaces as NotFound, never as data.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Recording } from '@examguard/database';
import type { UserContext } from '../common/types';
import { RecordingsService } from './recordings.service';
import {
  RecordingStorage,
  StorageIntegrityError,
  StorageObjectNotFoundError,
  StorageDownloadUrlNotSupportedError,
} from './storage';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

class MemoryStorage extends RecordingStorage {
  readonly driver = 'local' as const;
  readonly objects = new Map<string, Buffer>();

  async putObject(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }
  async getMetadata(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new StorageObjectNotFoundError(key);
    return { key, sizeBytes: body.length };
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async openReadStream(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new StorageObjectNotFoundError(key);
    return Readable.from([body]);
  }
  async verify(key: string, expected: { sizeBytes?: number; checksumSha256?: string }) {
    const body = this.objects.get(key);
    if (!body) throw new StorageObjectNotFoundError(key);
    if (expected.sizeBytes !== undefined && body.length !== expected.sizeBytes) {
      throw new StorageIntegrityError(`size mismatch for ${key}: expected ${expected.sizeBytes}, found ${body.length}`);
    }
    if (expected.checksumSha256) {
      const actual = sha256(body);
      if (actual !== expected.checksumSha256.toLowerCase()) {
        throw new StorageIntegrityError(`sha256 mismatch for ${key}: expected ${expected.checksumSha256}, found ${actual}`);
      }
    }
    return { key, sizeBytes: body.length, checksumSha256: expected.checksumSha256 ?? null };
  }
  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async createDownloadUrl(): Promise<string> {
    throw new StorageDownloadUrlNotSupportedError('local');
  }
}

type Row = Recording & { attempt: { id: string; status: string; organizationId: string; studentId: string } };

function rec(overrides: Partial<Row> = {}): Row {
  const id = overrides.id ?? randomUUID();
  const attemptId = overrides.attemptId ?? 'attempt-a';
  const now = new Date();
  const base: Row = {
    id,
    organizationId: 'org-a',
    examId: 'exam-a',
    attemptId,
    participantId: null,
    kind: 'CAMERA',
    status: 'PENDING',
    storageKey: `org-a/recordings/${id}/camera`,
    sizeBytes: null,
    durationMs: null,
    checksumSha256: null,
    startedAt: null,
    endedAt: null,
    failureReason: null,
    retentionUntil: new Date(now.getTime() + 90 * 86_400_000),
    createdBy: 'admin-1',
    createdAt: now,
    updatedAt: now,
    attempt: {
      id: attemptId,
      status: 'ACTIVE',
      organizationId: 'org-a',
      studentId: 'student-1',
    },
  };
  return { ...base, ...overrides, attempt: overrides.attempt ?? base.attempt } as Row;
}

interface FakeDb {
  recordings: Row[];
  attempts: Array<{ id: string; organizationId: string; examId: string; studentId: string; status: string }>;
  students: Array<{ id: string; userId: string; organizationId: string }>;
  assignments: Array<{ examId: string; monitor: { userId: string } }>;
  audit: Array<{ action: string; resourceType: string; resourceId: string; organizationId: string }>;
}

function makePrisma(db: FakeDb) {
  const prisma = {
    recording: {
      create: jest.fn(async ({ data }: { data: Partial<Row> }) => {
        const row = rec(data as Partial<Row>);
        db.recordings.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        return db.recordings.find((r) => r.id === where.id) ?? null;
      }),
      findMany: jest.fn(async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
        let rows = db.recordings.filter((r) => matches(r, where));
        if (orderBy && (orderBy as { createdAt?: string }).createdAt === 'desc') {
          rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return take ? rows.slice(0, take) : rows;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; status: string }; data: Partial<Row> }) => {
        const idx = db.recordings.findIndex((r) => r.id === where.id && r.status === where.status);
        if (idx < 0) return { count: 0 };
        db.recordings[idx] = { ...db.recordings[idx], ...data } as Row;
        return { count: 1 };
      }),
    },
    examAttempt: {
      findFirst: jest.fn(async ({ where }: { where: { id?: string; organizationId?: string } }) => {
        return (
          db.attempts.find(
            (a) =>
              a.id === where.id &&
              (where.organizationId === undefined || a.organizationId === where.organizationId),
          ) ?? null
        );
      }),
    },
    examSettings: {
      findUnique: jest.fn(async () => null),
    },
    mediaParticipant: {
      findFirst: jest.fn(async () => null),
    },
    student: {
      findUnique: jest.fn(async ({ where }: { where: { userId: string } }) => {
        return db.students.find((s) => s.userId === where.userId) ?? null;
      }),
    },
    examMonitorAssignment: {
      findFirst: jest.fn(async ({ where }: { where: { examId: string; monitor: { userId: string } } }) => {
        return (
          db.assignments.find(
            (a) => a.examId === where.examId && a.monitor.userId === where.monitor.userId,
          ) ?? null
        );
      }),
      findMany: jest.fn(async ({ where }: { where: { monitor: { userId: string } } }) => {
        return db.assignments.filter((a) => a.monitor.userId === where.monitor.userId);
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: object }) => {
        db.audit.push(data as FakeDb['audit'][number]);
        return data;
      }),
    },
  };
  return prisma;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'attempt') {
      const attempt = value as { studentId?: string };
      if (attempt.studentId && row.attempt.studentId !== attempt.studentId) return false;
      continue;
    }
    if (key === 'examId') {
      if (typeof value === 'object' && value !== null && 'in' in value) {
        if (!(value as { in: string[] }).in.includes(row.examId)) return false;
      } else if (row.examId !== value) return false;
      continue;
    }
    if (key === 'retentionUntil' && typeof value === 'object' && value !== null && 'lt' in value) {
      const field = (row as unknown as Record<string, Date>)[key];
      if (!(field instanceof Date) || !(field.getTime() < (value as { lt: Date }).lt.getTime())) {
        return false;
      }
      continue;
    }
    if ((row as unknown as Record<string, unknown>)[key] !== value) return false;
  }
  return true;
}

function user(overrides: Partial<UserContext>): UserContext {
  return {
    userId: 'admin-1',
    email: 'admin@a.test',
    firstName: 'A',
    lastName: 'Admin',
    role: 'ORG_ADMIN',
    orgId: 'org-a',
    permissions: [],
    isSuperAdmin: false,
    ...overrides,
  };
}

function baseDb(): FakeDb {
  return {
    recordings: [],
    attempts: [{ id: 'attempt-a', organizationId: 'org-a', examId: 'exam-a', studentId: 'student-1', status: 'ACTIVE' }],
    students: [
      { id: 'student-1', userId: 'student-user-1', organizationId: 'org-a' },
      { id: 'student-2', userId: 'student-user-2', organizationId: 'org-a' },
    ],
    assignments: [],
    audit: [],
  };
}

function makeSvc(db: FakeDb, storage = new MemoryStorage()) {
  const prisma = makePrisma(db) as unknown as ConstructorParameters<typeof RecordingsService>[0];
  return { svc: new RecordingsService(prisma, storage), prisma, storage };
}

describe('RecordingsService — authorization matrix', () => {
  it('creates a PENDING recording with server-generated tenant-scoped key and retention', async () => {
    const db = baseDb();
    const { svc, storage } = makeSvc(db);
    const created = await svc.create(user({}), { attemptId: 'attempt-a', kind: 'CAMERA' });
    expect(created.status).toBe('PENDING');
    expect(created.storageKey).toBe(`org-a/recordings/${created.id}/camera`);
    expect(created.organizationId).toBe('org-a');
    expect(created.retentionUntil).toBeTruthy();
    expect(storage.exists(created.storageKey)).resolves.toBe(false); // no object yet
    expect(db.audit.some((a) => a.action === 'recording.created')).toBe(true);
  });

  it('rejects attempts outside the caller organization', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    await expect(svc.create(user({ orgId: 'org-b' }), { attemptId: 'attempt-a', kind: 'CAMERA' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects an unknown participant for the attempt', async () => {
    const db = baseDb();
    const { svc, prisma } = makeSvc(db);
    (prisma as unknown as { mediaParticipant: { findFirst: jest.Mock } }).mediaParticipant.findFirst.mockResolvedValue(
      null,
    );
    await expect(
      svc.create(user({}), { attemptId: 'attempt-a', kind: 'CAMERA', participantId: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides recordings across organizations (tenant isolation)', async () => {
    const db = baseDb();
    db.recordings.push(rec({ id: 'rec-org-a', status: 'READY' }));
    const { svc } = makeSvc(db);
    await expect(svc.getById(user({ orgId: 'org-b' }), 'rec-org-a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('prevents student A from reading student B recording; owner can read', async () => {
    const db = baseDb();
    db.recordings.push(
      rec({
        id: 'rec-student-1',
        status: 'READY',
        attempt: { id: 'attempt-a', status: 'SUBMITTED', organizationId: 'org-a', studentId: 'student-1' },
      }),
    );
    const { svc } = makeSvc(db);

    const other = user({ userId: 'student-user-2', role: 'STUDENT', orgId: 'org-a' });
    await expect(svc.getById(other, 'rec-student-1')).rejects.toBeInstanceOf(NotFoundException);

    const owner = user({ userId: 'student-user-1', role: 'STUDENT', orgId: 'org-a' });
    await expect(svc.getById(owner, 'rec-student-1')).resolves.toMatchObject({ id: 'rec-student-1' });
  });

  it('prevents unassigned monitors from reading; assigned monitor can', async () => {
    const db = baseDb();
    db.recordings.push(rec({ id: 'rec-mon', status: 'READY' }));
    const { svc } = makeSvc(db);

    const unassigned = user({ userId: 'monitor-x', role: 'MONITOR', orgId: 'org-a' });
    await expect(svc.getById(unassigned, 'rec-mon')).rejects.toBeInstanceOf(NotFoundException);

    db.assignments.push({ examId: 'exam-a', monitor: { userId: 'monitor-x' } });
    await expect(svc.getById(unassigned, 'rec-mon')).resolves.toMatchObject({ id: 'rec-mon' });
  });

  it('returns NotFound for unknown or foreign recording ids', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    await expect(svc.getById(user({}), randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getById(user({}), 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists only what the caller may see (student own attempts; monitor assigned exams)', async () => {
    const db = baseDb();
    db.recordings.push(
      rec({ id: 'r-own', attemptId: 'attempt-a', status: 'READY' }),
      rec({
        id: 'r-other',
        attemptId: 'attempt-b',
        status: 'READY',
        attempt: { id: 'attempt-b', status: 'SUBMITTED', organizationId: 'org-a', studentId: 'student-2' },
      }),
    );
    const { svc } = makeSvc(db);

    const student = user({ userId: 'student-user-1', role: 'STUDENT', orgId: 'org-a' });
    const listed = await svc.list(student, {});
    expect(listed.map((r) => r.id)).toEqual(['r-own']);

    const monitor = user({ userId: 'monitor-1', role: 'MONITOR', orgId: 'org-a' });
    expect(await svc.list(monitor, {})).toHaveLength(0);
    db.assignments.push({ examId: 'exam-a', monitor: { userId: 'monitor-1' } });
    expect((await svc.list(monitor, {})).map((r) => r.id)).toContain('r-own');
    // Asking for an exam they are not assigned to yields nothing
    expect(await svc.list(monitor, { examId: 'exam-other' })).toHaveLength(0);
  });
});

describe('RecordingsService — lifecycle and state machine', () => {
  it('runs create -> start -> finalize -> READY with real checksum verification', async () => {
    const db = baseDb();
    const storage = new MemoryStorage();
    const { svc } = makeSvc(db, storage);
    const created = await svc.create(user({}), { attemptId: 'attempt-a', kind: 'SCREEN' });
    expect(created.status).toBe('PENDING');

    const started = await svc.start(user({}), created.id);
    expect(started.status).toBe('RECORDING');
    expect(started.startedAt).toBeTruthy();
    expect(db.audit.some((a) => a.action === 'recording.started')).toBe(true);

    const bytes = Buffer.from('real-egress-bytes');
    await storage.putObject(created.storageKey, bytes);

    const ready = await svc.finalize(user({}), created.id, {
      sizeBytes: bytes.length,
      durationMs: 5_000,
      checksumSha256: sha256(bytes),
    });
    expect(ready.status).toBe('READY');
    expect(ready.sizeBytes).toBe(bytes.length);
    expect(ready.durationMs).toBe(5_000);
    expect(ready.checksumSha256).toBe(sha256(bytes));
    expect(ready.endedAt).toBeTruthy();
    expect(db.audit.some((a) => a.action === 'recording.finalized')).toBe(true);
  });

  it('rejects invalid lifecycle transitions (409)', async () => {
    const db = baseDb();
    db.recordings.push(rec({ id: 'r-pending' }), rec({ id: 'r-recording', status: 'RECORDING', startedAt: new Date() }));
    const { svc } = makeSvc(db);

    await expect(svc.finalize(user({}), 'r-pending', { sizeBytes: 1, durationMs: 1, checksumSha256: '0'.repeat(64) })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.start(user({}), 'r-recording')).rejects.toBeInstanceOf(ConflictException);
  });

  it('marks storage failures FAILED instead of falsely reporting READY', async () => {
    const db = baseDb();
    const { svc } = makeSvc(db);
    const created = await svc.create(user({}), { attemptId: 'attempt-a', kind: 'CAMERA' });
    await svc.start(user({}), created.id);

    // Object missing entirely
    await expect(
      svc.finalize(user({}), created.id, { sizeBytes: 100, durationMs: 1, checksumSha256: '0'.repeat(64) }),
    ).rejects.toBeInstanceOf(ConflictException);
    let row = db.recordings.find((r) => r.id === created.id)!;
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toContain('missing');

    // Checksum mismatch on a present object
    const again = await svc.create(user({}), { attemptId: 'attempt-a', kind: 'CAMERA' });
    await svc.start(user({}), again.id);
    const storage = (makeSvc(db).storage);
    await storage.putObject(again.storageKey, Buffer.from('actual-bytes'));
    await expect(
      svc.finalize(user({}), again.id, {
        sizeBytes: 12,
        durationMs: 1,
        checksumSha256: '1'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    row = db.recordings.find((r) => r.id === again.id)!;
    expect(row.status).toBe('FAILED');
    expect(db.audit.some((a) => a.action === 'recording.failed')).toBe(true);
  });

  it('downloads only READY recordings and audits the access', async () => {
    const db = baseDb();
    const storage = new MemoryStorage();
    const { svc } = makeSvc(db, storage);
    const created = await svc.create(user({}), { attemptId: 'attempt-a', kind: 'CAMERA' });
    await expect(svc.download(user({}), created.id)).rejects.toBeInstanceOf(ForbiddenException);

    await storage.putObject(created.storageKey, Buffer.from('bytes'));
    await svc.start(user({}), created.id);
    await svc.finalize(user({}), created.id, { sizeBytes: 5, durationMs: 1, checksumSha256: sha256(Buffer.from('bytes')) });

    const owner = user({ userId: 'student-user-1', role: 'STUDENT', orgId: 'org-a' });
    const result = await svc.download(owner, created.id);
    expect(result.stream).toBeTruthy();
    expect(db.audit.some((a) => a.action === 'recording.accessed')).toBe(true);
  });

  it('blocks deletion of evidence of an active attempt', async () => {
    const db = baseDb();
    db.recordings.push(rec({ id: 'r-live' })); // attempt is ACTIVE
    const { svc } = makeSvc(db);
    await expect(svc.remove(user({}), 'r-live')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('deletes a terminal-attempt recording: object removed, row DELETED, audited', async () => {
    const db = baseDb();
    const storage = new MemoryStorage();
    const { svc } = makeSvc(db, storage);
    const created = await svc.create(user({}), { attemptId: 'attempt-a', kind: 'CAMERA' });
    await storage.putObject(created.storageKey, Buffer.from('x'));
    db.recordings.find((r) => r.id === created.id)!.attempt = {
      id: 'attempt-a',
      status: 'SUBMITTED',
      organizationId: 'org-a',
      studentId: 'student-1',
    };

    const deleted = await svc.remove(user({}), created.id);
    expect(deleted.status).toBe('DELETED');
    expect(storage.exists(created.storageKey)).resolves.toBe(false);
    expect(db.audit.some((a) => a.action === 'recording.deleted')).toBe(true);
  });
});