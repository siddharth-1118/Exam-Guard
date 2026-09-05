/**
 * Media-session control plane (Phase 4A). One logical publisher session per
 * attempt is persisted in `MediaParticipant` (metadata/state only — no media).
 * The participant id IS the session id: reconnect restores the same row.
 *
 * Authorization is enforced here (server-side, never trusting client ids):
 *  - a student can only manage sessions of their OWN active attempts;
 *  - monitors can only list sessions of exams they are assigned to;
 *  - organization boundaries are always enforced.
 */
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MediaParticipant, MediaParticipantStatus, Prisma } from '@examguard/database';
import { signMediaToken } from '@examguard/auth';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../common/config';
import type { UserContext } from '../common/types';
import type { MediaSessionDTO, MediaSessionListItem, MediaTokenDTO } from '@examguard/types';
import type { SubscriberTokenDto } from './dto';
import { isReconnect, nextState } from './state';
import { MediaPresenceService } from './media.presence';

const ACTIVE_PUBLISHER_STATES: MediaParticipantStatus[] = ['CONNECTING', 'ACTIVE', 'RECONNECTING', 'DISCONNECTED'];

/** Attempts in these states cannot be watched live (Phase 4C). */
const NON_WATCHABLE_ATTEMPT_STATES = ['SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED', 'UNDER_REVIEW'];

/** Media tokens live 5 minutes and are scoped to exactly one participant. */
const MEDIA_TOKEN_TTL_SECONDS = 300;

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly presence: MediaPresenceService,
  ) {}

  // -------------------------------------------------------------------------
  // REST: session lifecycle
  // -------------------------------------------------------------------------

  /** POST /media/sessions — create-or-reuse the attempt's publisher session. */
  async createForStudent(user: UserContext, attemptId: string): Promise<MediaSessionDTO> {
    const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
    if (!student || student.organizationId !== user.orgId) {
      throw new ForbiddenException('Only students can create publisher sessions');
    }
    const attempt = await this.prisma.examAttempt.findFirst({
      where: { id: attemptId, studentId: student.id, organizationId: student.organizationId },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.status !== 'ACTIVE') {
      throw new ForbiddenException(`Attempt is not active (status: ${attempt.status})`);
    }

    // Idempotency: reuse an existing non-terminal session for this attempt.
    const existing = await this.prisma.mediaParticipant.findUnique({ where: { attemptId } });
    if (existing && existing.status !== 'ENDED' && existing.status !== 'FAILED') {
      return this.toDTO(existing);
    }
    // Re-open a terminal row when the attempt is still ACTIVE (new session,
    // same logical participant slot — bounded by the unique attemptId).
    if (existing) {
      const reopened = await this.updateRow(
        { attemptId, status: { in: ['ENDED', 'FAILED'] } },
        { status: 'CONNECTING', endedAt: null, connectedAt: null, lastSeenAt: null, reconnects: 0 },
      );
      if (reopened) {
        await this.audit(user, 'media.session.create', attemptId, { reopened: true, participantId: reopened.id });
        return this.toDTO(reopened);
      }
    }

    const created = await this.prisma.mediaParticipant.create({
      data: {
        attemptId: attempt.id,
        examId: attempt.examId,
        studentId: attempt.studentId,
        organizationId: attempt.organizationId,
        role: 'PUBLISHER',
        status: 'CONNECTING',
      },
    });
    await this.audit(user, 'media.session.create', attempt.id, { participantId: created.id });
    return this.toDTO(created);
  }

  /** GET /media/sessions/:id — owner student or authorized exam watcher. */
  async getById(user: UserContext, id: string): Promise<MediaSessionDTO> {
    const session = await this.findVisible(user, id);
    return this.toDTO(session);
  }

  /** POST /media/sessions/:id/end — idempotent student-owner end. */
  async endById(user: UserContext, id: string): Promise<MediaSessionDTO> {
    const session = await this.findVisible(user, id);
    const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
    const isOwner = student !== null && session.studentId === student.id;
    const isWatcher =
      user.isSuperAdmin ||
      user.role === 'ORG_ADMIN' ||
      (await this.isAssignedMonitor(user, session.examId)) !== false;
    if (!isOwner && !isWatcher) throw new ForbiddenException('Not permitted to end this session');

    if (session.status === 'ENDED') return this.toDTO(session); // idempotent
    const ended = await this.updateRow(
      { id, status: { in: ACTIVE_PUBLISHER_STATES } },
      { status: 'ENDED', endedAt: new Date() },
    );
    const finalRow = ended ?? session;
    if (ended) {
      // Ephemeral presence: the session ended — remove key + lease (fail-safe).
      await this.presence.removePresence(id, session.organizationId).catch(() => undefined);
    }
    await this.audit(user, 'media.session.end', session.attemptId, { participantId: id, idempotent: !ended });
    return this.toDTO(finalRow);
  }

  /**
   * POST /media/token — short-lived SFU publisher credential (Phase 4B).
   * Server-authorized: only the owner of an ACTIVE attempt (whose media session
   * was created through the normal flow) can obtain a token for it. The token
   * is signed with the shared JWT secret, expires in 5 minutes, and carries
   * org/exam/attempt/participant — the SFU re-derives authorization from it.
   */
  async issuePublisherToken(user: UserContext, attemptId: string): Promise<MediaTokenDTO> {

    const session = await this.createForStudent(user, attemptId);
    const token = await signMediaToken(
      {
        sub: session.participantId,
        orgId: session.organizationId,
        examId: session.examId,
        attemptId: session.attemptId,
        participantId: session.participantId,
        role: 'publisher',
      },
      this.config.jwtSecret,
      MEDIA_TOKEN_TTL_SECONDS,
    );
    await this.audit(user, 'media.token.issued', attemptId, {
      participantId: session.participantId,
      ttlSeconds: MEDIA_TOKEN_TTL_SECONDS,
    });
    return {
      token,
      sfuUrl: this.config.sfuUrl,
      mediaSessionId: session.id,
      participantId: session.participantId,
      attemptId: session.attemptId,
      expiresInSeconds: MEDIA_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * POST /media/subscriber-token (Phase 4C) — short-lived monitor credential.
   * Server-authorized end to end: only a monitor/org-watcher assigned to the
   * attempt's exam can obtain a token; the attempt must still be watchable
   * (not submitted/terminated); the participant is derived from the attempt's
   * own media row (a supplied participantId must match, or the request 404s).
   * The token is scoped to org/exam/attempt/participant + role 'subscriber'
   * and expires like publisher tokens.
   */
  async issueSubscriberToken(user: UserContext, dto: SubscriberTokenDto): Promise<MediaTokenDTO> {
    const attempt = await this.prisma.examAttempt.findFirst({
      where: { id: dto.attemptId, organizationId: user.orgId ?? undefined },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    // Monitor/exam authorization: org admins & super admins pass; monitors must
    // be assigned to this exam. Student roles never reach this endpoint.
    await this.assertExamWatchAccess(user, attempt.examId);
    if (NON_WATCHABLE_ATTEMPT_STATES.includes(attempt.status)) {
      throw new ForbiddenException(`Attempt is not watchable (status: ${attempt.status})`);
    }
    const row = await this.prisma.mediaParticipant.findUnique({ where: { attemptId: attempt.id } });
    if (!row) throw new NotFoundException('No media session for this attempt');
    if (dto.participantId && dto.participantId !== row.id) {
      // Wrong-participant probing is indistinguishable from a missing resource.
      throw new NotFoundException('Media session not found');
    }
    const token = await signMediaToken(
      {
        sub: row.id,
        orgId: row.organizationId,
        examId: row.examId,
        attemptId: row.attemptId,
        participantId: row.id,
        role: 'subscriber',
      },
      this.config.jwtSecret,
      MEDIA_TOKEN_TTL_SECONDS,
    );
    await this.audit(user, 'media.token.issued-subscriber', attempt.id, {
      participantId: row.id,
      ttlSeconds: MEDIA_TOKEN_TTL_SECONDS,
    });
    return {
      token,
      sfuUrl: this.config.sfuUrl,
      mediaSessionId: row.id,
      participantId: row.id,
      attemptId: row.attemptId,
      expiresInSeconds: MEDIA_TOKEN_TTL_SECONDS,
    };
  }

  /** Exam watch authorization shared by REST discovery and the WS gateway. */
  async assertExamWatchAccess(user: UserContext, examId: string): Promise<void> {
    const exam = await this.prisma.exam.findFirst({
      where: { id: examId, organizationId: user.orgId ?? undefined },
      select: { id: true },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    if (!(user.isSuperAdmin || user.role === 'ORG_ADMIN')) {
      const assigned = await this.isAssignedMonitor(user, examId);
      if (!assigned) throw new ForbiddenException('Not assigned to this exam');
    }
  }

  /** GET /media/sessions?examId= — authorized monitor discovery (metadata only). */
  async listForExam(user: UserContext, examId: string): Promise<MediaSessionListItem[]> {
    await this.assertExamWatchAccess(user, examId);
    const rows = await this.prisma.mediaParticipant.findMany({
      where: { examId },
      include: { student: { include: { user: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => ({
      studentId: row.studentId,
      studentCode: row.student.studentCode,
      studentName: `${row.student.user.firstName} ${row.student.user.lastName}`,
      attemptId: row.attemptId,
      mediaSessionId: row.id,
      participantId: row.id,
      state: row.status,
      connectedAt: row.connectedAt?.toISOString() ?? null,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
    }));
  }

  // -------------------------------------------------------------------------
  // Gateway-driven state transitions (meaningful lifecycle changes only)
  // -------------------------------------------------------------------------

  /**
   * Gateway join (fresh or reconnect). Returns the row plus whether this was a
   * reconnect of the same logical participant. Rejects non-active attempts.
   */
  async gatewayJoin(user: UserContext, attemptId: string): Promise<{ session: MediaSessionDTO; reconnected: boolean }> {
    const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
    if (!student || student.organizationId !== user.orgId) {
      throw new ForbiddenException('Not a student of this organization');
    }
    const attempt = await this.prisma.examAttempt.findFirst({
      where: { id: attemptId, studentId: student.id, organizationId: student.organizationId },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.status !== 'ACTIVE') {
      throw new ForbiddenException(`Attempt is not active (status: ${attempt.status})`);
    }

    const row = await this.prisma.mediaParticipant.findUnique({ where: { attemptId } });
    if (!row || (row.status !== 'CONNECTING' && row.status !== 'ACTIVE' && row.status !== 'RECONNECTING' && row.status !== 'DISCONNECTED')) {
      throw new ForbiddenException('No open media session for this attempt — create one first');
    }

    const reconnected = isReconnect(row.status);
    const next = nextState(row.status, 'connected');
    const now = new Date();
    const updated = await this.updateRow(
      { id: row.id, status: { in: ['CONNECTING', 'ACTIVE', 'RECONNECTING', 'DISCONNECTED'] } },
      {
        status: next ?? 'ACTIVE',
        connectedAt: row.connectedAt ?? now,
        lastSeenAt: now,
        ...(reconnected ? { reconnects: { increment: 1 } } : {}),
      },
    );
    const finalRow = updated ?? row;
    if (reconnected) {
      await this.audit(user, 'media.session.reconnected', attemptId, { participantId: row.id });
    } else {
      await this.audit(user, 'media.session.connected', attemptId, { participantId: row.id });
    }
    return { session: this.toDTO(finalRow), reconnected };
  }

  /** Socket lost → reconnect window opens (ACTIVE → RECONNECTING). */
  async gatewaySocketLost(userId: string, participantId: string): Promise<void> {
    await this.updateRow(
      { id: participantId, status: 'ACTIVE' },
      { status: 'RECONNECTING', lastSeenAt: new Date() },
    );
    const row = await this.prisma.mediaParticipant.findUnique({ where: { id: participantId } });
    if (row) await this.auditById(userId, 'media.session.reconnecting', row);
  }

  /** Grace window elapsed without a reconnect (RECONNECTING → DISCONNECTED). */
  async gatewayExpire(userId: string, participantId: string): Promise<void> {
    const row = await this.prisma.mediaParticipant.findUnique({ where: { id: participantId } });
    if (!row) return;
    await this.updateRow(
      { id: participantId, status: 'RECONNECTING' },
      { status: 'DISCONNECTED', lastSeenAt: new Date() },
    );
    await this.auditById(userId, 'media.session.disconnected', row);
  }

  /** Throttled presence touch — no audit, no row churn beyond lastSeenAt. */
  async touchPresence(participantId: string): Promise<void> {
    await this.prisma.mediaParticipant.updateMany({
      where: { id: participantId, status: 'ACTIVE' },
      data: { lastSeenAt: new Date() },
    });
  }

  async monitorExamForParticipant(participantId: string): Promise<{ examId: string; organizationId: string } | null> {
    const row = await this.prisma.mediaParticipant.findUnique({
      where: { id: participantId },
      select: { examId: true, organizationId: true },
    });
    return row;
  }

  // -------------------------------------------------------------------------
  // Server-side SFU eviction (Phase 4D — cleanup must not depend on the client)
  // -------------------------------------------------------------------------

  /** All participant rows of an attempt (any status — rooms key off row id). */
  async findParticipantsByAttempt(attemptId: string): Promise<
    Array<{ id: string; organizationId: string; status: string }>
  > {
    return this.prisma.mediaParticipant.findMany({
      where: { attemptId },
      select: { id: true, organizationId: true, status: true },
    });
  }

  /**
   * Asks the SFU to tear the participant's room down now. Idempotent — the SFU
   * answers 404 when the room is already gone, which is reported as false.
   * Internal endpoint, never exposed to media clients.
   */
  async evictSfuRoom(participantId: string, reason: string): Promise<boolean> {
    const url = `${sfuHttpOrigin(this.config.sfuUrl)}/admin/evict`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sfu-admin-key': this.config.sfuAdminKey,
        },
        body: JSON.stringify({ participantId, reason }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      this.logger.warn(`sfu evict ${participantId.slice(0, 8)} -> http ${res.status}`);
      return false;
    } catch (err) {
      this.logger.warn(
        `sfu evict ${participantId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** Audit row without an actor (server-initiated cleanup, sweeper/eviction). */
  async auditSystem(
    organizationId: string,
    action: string,
    attemptId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        action,
        resourceType: 'ExamAttempt',
        resourceId: attemptId,
        detail: detail as object,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Shared lookups / helpers
  // -------------------------------------------------------------------------

  private async findVisible(user: UserContext, id: string): Promise<MediaParticipant> {
    const session = await this.prisma.mediaParticipant.findUnique({
      where: { id },
      include: { student: true },
    });
    if (!session) throw new NotFoundException('Media session not found');
    // Tenant isolation first: session org must be the caller's org.
    if (session.organizationId !== user.orgId) throw new NotFoundException('Media session not found');

    if (user.role === 'STUDENT') {
      const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
      if (!student || session.studentId !== student.id) {
        throw new NotFoundException('Media session not found');
      }
      return session;
    }
    // Watchers: super admins / org admins / exam-assigned monitors.
    if (user.isSuperAdmin || user.role === 'ORG_ADMIN') return session;
    const assigned = await this.prisma.examMonitorAssignment.findFirst({
      where: { examId: session.examId, monitor: { userId: user.userId } },
    });
    if (!assigned) throw new NotFoundException('Media session not found');
    return session;
  }

  private async isAssignedMonitor(user: UserContext, examId: string): Promise<boolean> {
    const assigned = await this.prisma.examMonitorAssignment.findFirst({
      where: { examId, monitor: { userId: user.userId } },
    });
    return assigned !== null;
  }

  private async updateRow(
    where: Prisma.MediaParticipantWhereInput,
    data: Prisma.MediaParticipantUpdateManyMutationInput,
  ): Promise<MediaParticipant | null> {
    const target = await this.prisma.mediaParticipant.findFirst({ where });
    if (!target) return null;
    // Optimistic guarded update (the find+update is not atomic, but the WHERE
    // re-checks the status — a concurrent transition ends the row first).
    const result = await this.prisma.mediaParticipant.updateMany({
      where: { ...where, id: target.id },
      data,
    });
    return result.count > 0 ? this.prisma.mediaParticipant.findUnique({ where: { id: target.id } }) : null;
  }

  private toDTO(row: MediaParticipant): MediaSessionDTO {
    return {
      id: row.id,
      participantId: row.id,
      attemptId: row.attemptId,
      examId: row.examId,
      studentId: row.studentId,
      organizationId: row.organizationId,
      state: row.status,
      connectedAt: row.connectedAt?.toISOString() ?? null,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async audit(
    user: UserContext,
    action: string,
    attemptId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const attempt = await this.prisma.examAttempt.findUnique({
      where: { id: attemptId },
      select: { organizationId: true },
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId: attempt?.organizationId ?? user.orgId,
        actorUserId: user.userId,
        action,
        resourceType: 'ExamAttempt',
        resourceId: attemptId,
        detail: detail as object,
      },
    });
  }

  private async auditById(userId: string, action: string, row: MediaParticipant): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: row.organizationId,
        actorUserId: userId,
        action,
        resourceType: 'ExamAttempt',
        resourceId: row.attemptId,
        detail: { participantId: row.id, state: row.status },
      },
    });
  }
}

/** ws://host:port/path → http://host:port (for internal admin calls). */
function sfuHttpOrigin(sfuUrl: string): string {
  try {
    const u = new URL(sfuUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return 'http://localhost:4010';
  }
}
