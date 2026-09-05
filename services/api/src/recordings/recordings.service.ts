/**
 * Recording lifecycle service (Phase 5).
 *
 * Authorization is enforced server-side and never trusts client-supplied ids:
 *  - the attempt, exam and (optional) participant are resolved from DB state;
 *  - tenant isolation first (organization boundary);
 *  - students only see recordings of their OWN attempts;
 *  - monitors only see recordings of exams they are assigned to;
 *  - org admins / super admins see their whole organization.
 *
 * A recording only becomes READY after the storage layer confirms the object
 * exists and matches the reported size/checksum — a storage failure produces
 * an explicit FAILED state, never a false READY.
 *
 * No media bytes ever pass through this service; objects live in storage.
 */
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ExamAttempt, Recording } from '@examguard/database';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { UserContext } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { RecordingStorage, StorageIntegrityError, StorageObjectNotFoundError } from './storage';
import { nextRecordingStatus } from './state';
import type { ListRecordingsQuery, CreateRecordingDto, FinalizeRecordingDto } from './dto';
import type { RecordingDTO, RecordingKind } from '@examguard/types';

const DEFAULT_RETENTION_DAYS = 90;

type RecordingWithAttempt = Recording & { attempt: ExamAttempt };

/** Attempt states whose evidence is still live and must never be deleted. */
const ACTIVE_ATTEMPT_STATES = ['CREATED', 'READY', 'ACTIVE', 'PAUSED', 'DISCONNECTED'];

@Injectable()
export class RecordingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: RecordingStorage,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** POST /recordings — open a recording session for an attempt. */
  async create(user: UserContext, dto: CreateRecordingDto): Promise<RecordingDTO> {
    const attempt = await this.prisma.examAttempt.findFirst({
      where: { id: dto.attemptId, organizationId: user.orgId ?? undefined },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');

    if (dto.participantId) {
      // A supplied participant must belong to this attempt's own media row —
      // probing another session is indistinguishable from a missing resource.
      const participant = await this.prisma.mediaParticipant.findFirst({
        where: { id: dto.participantId, attemptId: attempt.id, organizationId: attempt.organizationId },
      });
      if (!participant) throw new NotFoundException('Media participant not found');
    }

    const settings = await this.prisma.examSettings.findUnique({ where: { examId: attempt.examId } });
    const retentionDays = settings?.retentionDays ?? DEFAULT_RETENTION_DAYS;

    const id = randomUUID();
    // Server-generated, tenant-scoped key — never client-supplied, no PII.
    const storageKey = `${attempt.organizationId}/recordings/${id}/${dto.kind.toLowerCase()}`;

    const row = await this.prisma.recording.create({
      data: {
        id,
        organizationId: attempt.organizationId,
        examId: attempt.examId,
        attemptId: attempt.id,
        participantId: dto.participantId ?? null,
        kind: dto.kind,
        status: 'PENDING',
        storageKey,
        retentionUntil: new Date(Date.now() + retentionDays * 86_400_000),
        createdBy: user.userId,
      },
    });
    await this.audit(user, 'recording.created', row);
    return this.toDTO(row);
  }

  /** POST /recordings/:id/start — PENDING → RECORDING. */
  async start(user: UserContext, id: string): Promise<RecordingDTO> {
    const row = await this.loadForManage(user, id);
    const started = await this.transition(user, row, 'start', { startedAt: new Date() });
    await this.audit(user, 'recording.started', started);
    return this.toDTO(started);
  }

  /**
   * POST /recordings/:id/finalize — RECORDING → FINALIZING → READY.
   * READY is only reached after the storage layer verifies the object against
   * the reported size and sha256 checksum. Any verification failure (missing
   * object, size/checksum mismatch, storage error) lands the recording in
   * FAILED with an explicit reason.
   */
  async finalize(user: UserContext, id: string, dto: FinalizeRecordingDto): Promise<RecordingDTO> {
    const row = await this.loadForManage(user, id);
    const finalizing = await this.transition(user, row, 'finalize', {});
    try {
      await this.storage.verify(finalizing.storageKey, {
        sizeBytes: dto.sizeBytes,
        checksumSha256: dto.checksumSha256,
      });
    } catch (err) {
      const reason =
        err instanceof StorageObjectNotFoundError
          ? 'object missing from storage at finalize'
          : err instanceof StorageIntegrityError
            ? err.message
            : `storage verification failed: ${err instanceof Error ? err.message : String(err)}`;
      const failed = await this.transition(user, finalizing, 'fail', {
        failureReason: reason,
        endedAt: new Date(),
      });
      await this.audit(user, 'recording.failed', failed);
      throw new ConflictException(`Recording finalization failed: ${reason}`);
    }
    const ready = await this.transition(user, finalizing, 'markReady', {
      endedAt: new Date(),
      sizeBytes: BigInt(dto.sizeBytes),
      durationMs: dto.durationMs,
      checksumSha256: dto.checksumSha256.toLowerCase(),
    });
    await this.audit(user, 'recording.finalized', ready);
    return this.toDTO(ready);
  }

  /** GET /recordings/:id — authorized metadata. */
  async getById(user: UserContext, id: string): Promise<RecordingDTO> {
    const row = await this.loadVisible(user, id);
    return this.toDTO(row);
  }

  /** GET /recordings — org-scoped list with role visibility filters. */
  async list(user: UserContext, query: ListRecordingsQuery): Promise<RecordingDTO[]> {
    const where: Record<string, unknown> = {};
    if (user.orgId !== null) where.organizationId = user.orgId;

    if (user.role === 'STUDENT') {
      const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
      if (!student) return [];
      where.attempt = { studentId: student.id };
    } else if (user.role === 'MONITOR') {
      const assigned = await this.prisma.examMonitorAssignment.findMany({
        where: { monitor: { userId: user.userId } },
        select: { examId: true },
      });
      const examIds = assigned.map((a) => a.examId);
      if (query.examId) {
        if (!examIds.includes(query.examId)) return [];
        where.examId = query.examId;
      } else {
        where.examId = { in: examIds };
      }
    }

    if (query.attemptId) where.attemptId = query.attemptId;
    if (query.examId && user.role !== 'MONITOR') where.examId = query.examId;

    const rows = await this.prisma.recording.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toDTO(r));
  }

  /**
   * GET /recordings/:id/download — authorized access. Audits every access.
   * Returns a stream for the local driver (served by the API with RBAC) or a
   * short-lived presigned URL for the S3 driver.
   */
  async download(
    user: UserContext,
    id: string,
  ): Promise<{ recording: RecordingDTO; contentType: string; stream?: Readable; url?: string }> {
    const row = await this.loadVisible(user, id);
    if (row.status !== 'READY') {
      throw new ForbiddenException(`Recording is not ready for download (status: ${row.status})`);
    }
    await this.audit(user, 'recording.accessed', row);
    if (this.storage.driver === 's3') {
      const url = await this.storage.createDownloadUrl(row.storageKey, { ttlSeconds: 300 });
      return { recording: this.toDTO(row), contentType: contentTypeFor(row.kind), url };
    }
    const stream = await this.storage.openReadStream(row.storageKey);
    return { recording: this.toDTO(row), contentType: contentTypeFor(row.kind), stream };
  }

  /**
   * DELETE /recordings/:id — explicit deletion when retention allows.
   * Evidence of an active attempt can never be deleted; recordings within
   * their retention period are protected unless the caller is an org admin /
   * super admin. The object is removed from storage first; only then is the
   * row marked DELETED (a storage failure leaves the row untouched).
   */
  async remove(user: UserContext, id: string): Promise<RecordingDTO> {
    const row = await this.loadForManage(user, id);
    if (ACTIVE_ATTEMPT_STATES.includes(row.attempt.status)) {
      throw new ForbiddenException('Cannot delete evidence of an active exam attempt');
    }
    if (
      row.retentionUntil &&
      row.retentionUntil.getTime() > Date.now() &&
      !(user.isSuperAdmin || user.role === 'ORG_ADMIN')
    ) {
      throw new ConflictException('Recording is still within its retention period');
    }
    await this.storage.deleteObject(row.storageKey);
    const deleted = await this.transition(user, row, 'delete', {});
    await this.audit(user, 'recording.deleted', deleted);
    return this.toDTO(deleted);
  }

  // -------------------------------------------------------------------------
  // Admin endpoints (called by SFU recording egress)
  // -------------------------------------------------------------------------

  /**
   * Internal finalize: called by SFU after producing a recording file.
   * Skips user auth — protected by admin key at the controller level.
   */
  async adminFinalize(id: string, dto: FinalizeRecordingDto): Promise<RecordingDTO> {
    const row = await this.prisma.recording.findUnique({ where: { id }, include: { attempt: true } }) as RecordingWithAttempt | null;
    if (!row) throw new NotFoundException('Recording not found');
    if (row.status !== 'RECORDING' && row.status !== 'FINALIZING') {
      throw new ConflictException(`Cannot finalize recording in status ${row.status}`);
    }
    const finalizing = row.status === 'RECORDING'
      ? await this.adminTransition(row, 'finalize', {})
      : row;
    try {
      await this.storage.verify(finalizing.storageKey, {
        sizeBytes: dto.sizeBytes,
        checksumSha256: dto.checksumSha256,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.adminTransition(finalizing, 'fail', { failureReason: reason, endedAt: new Date() });
      throw new ConflictException(`Storage verification failed: ${reason}`);
    }
    const ready = await this.adminTransition(finalizing, 'markReady', {
      endedAt: new Date(),
      sizeBytes: BigInt(dto.sizeBytes),
      durationMs: dto.durationMs,
      checksumSha256: dto.checksumSha256.toLowerCase(),
    });
    await this.auditSystem(row.organizationId, 'recording.finalized', row.attemptId, {
      recordingId: id, sizeBytes: dto.sizeBytes, durationMs: dto.durationMs,
    });
    return this.toDTO(ready);
  }

  /** Internal fail: called by SFU when recording fails. */
  async adminFail(id: string, reason: string): Promise<RecordingDTO> {
    const row = await this.prisma.recording.findUnique({ where: { id }, include: { attempt: true } }) as RecordingWithAttempt | null;
    if (!row) throw new NotFoundException('Recording not found');
    if (row.status === 'READY' || row.status === 'DELETED') {
      return this.toDTO(row);
    }
    const failed = await this.adminTransition(row, 'fail', { failureReason: reason, endedAt: new Date() });
    await this.auditSystem(row.organizationId, 'recording.failed', row.attemptId, {
      recordingId: id, reason,
    });
    return this.toDTO(failed);
  }

  /** Admin transition (no user context needed). */
  private async adminTransition(
    row: Recording & { attempt: ExamAttempt },
    event: 'start' | 'finalize' | 'markReady' | 'fail' | 'delete',
    data: Record<string, unknown>,
  ): Promise<Recording> {
    const next = nextRecordingStatus(row.status, event);
    if (!next) throw new ConflictException(`Invalid transition: ${row.status} -> ${event}`);
    const result = await this.prisma.recording.updateMany({
      where: { id: row.id, status: row.status },
      data: { ...data, status: next } as never,
    });
    if (result.count === 0) throw new ConflictException('Recording state changed concurrently');
    const updated = await this.prisma.recording.findUnique({ where: { id: row.id } });
    if (!updated) throw new NotFoundException('Recording not found');
    return updated;
  }

  /** System-initiated audit row (no actor). */
  private async auditSystem(
    organizationId: string, action: string, attemptId: string, detail: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: { organizationId, action, resourceType: 'Recording', resourceId: attemptId, detail: detail as object },
    });
  }

  // -------------------------------------------------------------------------
  // Authorization helpers
  // -------------------------------------------------------------------------

  /** Role-scoped visibility for read/download (tenant + ownership isolation). */
  private async loadVisible(user: UserContext, id: string): Promise<RecordingWithAttempt> {
    const row = await this.prisma.recording.findUnique({
      where: { id },
      include: { attempt: true },
    });
    if (!row) throw new NotFoundException('Recording not found');
    if (row.organizationId !== user.orgId) throw new NotFoundException('Recording not found');

    if (user.role === 'STUDENT') {
      const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
      if (!student || row.attempt.studentId !== student.id) {
        throw new NotFoundException('Recording not found');
      }
      return row;
    }
    if (user.isSuperAdmin || user.role === 'ORG_ADMIN') return row;
    if (user.role === 'MONITOR') {
      const assigned = await this.prisma.examMonitorAssignment.findFirst({
        where: { examId: row.examId, monitor: { userId: user.userId } },
      });
      if (!assigned) throw new NotFoundException('Recording not found');
      return row;
    }
    // EXAM_MANAGER: same-org visibility (already enforced above).
    return row;
  }

  /** Manage-scoped lookup: super admin or same-organization caller. */
  private async loadForManage(user: UserContext, id: string): Promise<RecordingWithAttempt> {
    const row = await this.prisma.recording.findUnique({
      where: { id },
      include: { attempt: true },
    });
    if (!row) throw new NotFoundException('Recording not found');
    if (!user.isSuperAdmin && row.organizationId !== user.orgId) {
      throw new NotFoundException('Recording not found');
    }
    return row;
  }

  /** Guarded state transition — invalid or concurrent transitions are rejected. */
  private async transition(
    user: UserContext,
    row: Recording,
    event: 'start' | 'finalize' | 'markReady' | 'fail' | 'delete',
    data: Record<string, unknown>,
  ): Promise<Recording> {
    const next = nextRecordingStatus(row.status, event);
    if (!next) {
      throw new ConflictException(`Invalid recording transition: ${row.status} -> ${event}`);
    }
    const result = await this.prisma.recording.updateMany({
      where: { id: row.id, status: row.status },
      data: { ...data, status: next } as never,
    });
    if (result.count === 0) {
      throw new ConflictException('Recording state changed concurrently');
    }
    const updated = await this.prisma.recording.findUnique({ where: { id: row.id } });
    if (!updated) throw new NotFoundException('Recording not found');
    return updated;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async audit(user: UserContext, action: string, row: Recording): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: row.organizationId,
        actorUserId: user.userId,
        actorEmail: user.email,
        action,
        resourceType: 'Recording',
        resourceId: row.id,
        detail: {
          recordingId: row.id,
          attemptId: row.attemptId,
          kind: row.kind,
          status: row.status,
        } as object,
      },
    });
  }

  private toDTO(row: Recording): RecordingDTO {
    return {
      id: row.id,
      organizationId: row.organizationId,
      examId: row.examId,
      attemptId: row.attemptId,
      participantId: row.participantId,
      kind: row.kind as RecordingKind,
      status: row.status,
      storageKey: row.storageKey,
      sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
      durationMs: row.durationMs,
      checksumSha256: row.checksumSha256,
      startedAt: row.startedAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
      failureReason: row.failureReason,
      retentionUntil: row.retentionUntil?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function contentTypeFor(kind: RecordingKind): string {
  return kind === 'MICROPHONE' ? 'audio/webm' : 'video/webm';
}