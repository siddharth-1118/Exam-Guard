import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DEFAULT_RISK_WEIGHTS, RiskTracker, type RiskWeights } from '@examguard/security';
import type { RiskLevel } from '@examguard/types';
import { Prisma } from '@examguard/database';
import { PrismaService } from '../prisma/prisma.service';

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === null || value === undefined ? undefined : (value as Prisma.InputJsonValue);
}
import { EventBus } from '../common/event-bus';
import type { UserContext } from '../common/types';
import {
  CreateAiEventDto,
  CreateProctoringEventDto,
  FlagStudentDto,
  PauseExamDto,
  ResumeExamDto,
  SendMessageDto,
  TerminateExamDto,
  UpdateMediaSessionDto,
} from './dto';

/**
 * Monitor interventions (spec §14-§17). Every action is:
 * 1) authorization-checked (assigned exam + proctor:intervene),
 * 2) enforced server-side (status changes on the attempt),
 * 3) recorded in monitor_actions + audit_logs,
 * 4) fanned out through the event bus (realtime in Phase 4).
 */
@Injectable()
export class MonitoringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  // -------------------------------------------------------------------------
  // Dashboards
  // -------------------------------------------------------------------------

  async listExams(user: UserContext) {
    const exams = await this.prisma.exam.findMany({
      where: {
        organizationId: user.orgId!,
        monitorAssignments: { some: { monitor: { userId: user.userId } } },
      },
      include: {
        _count: { select: { assignments: true } },
      },
    });
    const out = [];
    for (const exam of exams) {
      const [active, suspicious, critical] = await Promise.all([
        this.prisma.examAttempt.count({ where: { examId: exam.id, status: 'ACTIVE' } }),
        this.prisma.examAttempt.count({
          where: { examId: exam.id, riskScores: { some: { level: 'SUSPICIOUS' } } },
        }),
        this.prisma.examAttempt.count({
          where: { examId: exam.id, riskScores: { some: { level: 'CRITICAL' } } },
        }),
      ]);
      out.push({
        id: exam.id,
        name: exam.name,
        status: exam.status,
        assignedStudents: exam._count.assignments,
        active,
        suspicious,
        critical,
      });
    }
    return out;
  }

  async examStudents(user: UserContext, examId: string) {
    await this.requireAssignedExam(user, examId);
    const assignments = await this.prisma.examAssignment.findMany({
      where: { examId },
      include: {
        student: {
          include: {
            user: true,
            attempts: { where: { examId }, orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });
    const out = [];
    for (const assignment of assignments) {
      const attempt = assignment.student.attempts[0] ?? null;
      const risk = attempt
        ? await this.prisma.riskScore.findFirst({
            where: { attemptId: attempt.id },
            orderBy: { computedAt: 'desc' },
          })
        : null;
      const [camera, mic, screen] = attempt
        ? await Promise.all([
            this.prisma.cameraSession.findUnique({ where: { attemptId: attempt.id } }),
            this.prisma.microphoneSession.findUnique({ where: { attemptId: attempt.id } }),
            this.prisma.screenSession.findUnique({ where: { attemptId: attempt.id } }),
          ])
        : [null, null, null];
      const participant = attempt
        ? await this.prisma.mediaParticipant.findUnique({ where: { attemptId: attempt.id } })
        : null;
      out.push({
        assignmentId: assignment.id,
        studentId: assignment.student.id,
        studentName: `${assignment.student.user.firstName} ${assignment.student.user.lastName}`,
        studentCode: assignment.student.studentCode,
        status: attempt?.status ?? 'NOT_STARTED',
        attemptId: attempt?.id ?? null,
        riskScore: risk?.score ?? 0,
        riskLevel: risk?.level ?? 'NORMAL',
        cameraConnected: camera?.status === 'ACTIVE',
        micConnected: mic?.status === 'ACTIVE',
        screenConnected: screen?.status === 'ACTIVE',
        mediaLive: participant?.status === 'ACTIVE',
        lastSignalAt: attempt
          ? (await this.prisma.deviceSession.findUnique({ where: { attemptId: attempt.id } }))?.lastSignalAt ?? null
          : null,
      });
    }
    return out;
  }

  async studentDetail(user: UserContext, studentId: string) {
    const student = await this.prisma.student.findFirst({
      where: { id: studentId, organizationId: user.orgId! },
      include: { user: true },
    });
    if (!student) throw new NotFoundException('Student not found');

    const attempt = await this.prisma.examAttempt.findFirst({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!attempt) throw new NotFoundException('No attempt found for this student');
    await this.requireAssignedExam(user, attempt.examId);

    const [exam, device, camera, mic, screen, participant, events, aiEvents, actions, messages, risk] =
      await Promise.all([
        this.prisma.exam.findUnique({ where: { id: attempt.examId } }),
        this.prisma.deviceSession.findUnique({ where: { attemptId: attempt.id } }),
        this.prisma.cameraSession.findUnique({ where: { attemptId: attempt.id } }),
        this.prisma.microphoneSession.findUnique({ where: { attemptId: attempt.id } }),
        this.prisma.screenSession.findUnique({ where: { attemptId: attempt.id } }),
        this.prisma.mediaParticipant.findUnique({ where: { attemptId: attempt.id } }),
        this.prisma.proctoringEvent.findMany({
          where: { attemptId: attempt.id },
          orderBy: { capturedAt: 'desc' },
          take: 100,
        }),
        this.prisma.aiEvent.findMany({
          where: { attemptId: attempt.id },
          orderBy: { capturedAt: 'desc' },
          take: 100,
        }),
        this.prisma.monitorAction.findMany({
          where: { attemptId: attempt.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { monitor: { select: { email: true, firstName: true, lastName: true } } },
        }),
        this.prisma.message.findMany({
          where: { attemptId: attempt.id },
          orderBy: { createdAt: 'asc' },
          take: 50,
        }),
        this.prisma.riskScore.findFirst({
          where: { attemptId: attempt.id },
          orderBy: { computedAt: 'desc' },
        }),
      ]);

    return {
      identity: {
        studentId: student.id,
        studentCode: student.studentCode,
        name: `${student.user.firstName} ${student.user.lastName}`,
        email: student.user.email,
      },
      exam: { id: exam?.id, name: exam?.name ?? '', status: exam?.status ?? null },
      attempt: {
        id: attempt.id,
        status: attempt.status,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        score: attempt.score,
      },
      connection: {
        device: device?.deviceInfo ?? null,
        os: device?.os ?? null,
        appVersion: device?.appVersion ?? null,
        lastSignalAt: device?.lastSignalAt ?? null,
      },
      media: {
        camera: camera ? { status: camera.status, muted: camera.muted } : null,
        microphone: mic ? { status: mic.status, muted: mic.muted, audioLevel: mic.audioLevel } : null,
        screen: screen ? { status: screen.status } : null,
        live: participant
          ? {
              status: participant.status,
              sfuParticipantId: participant.sfuParticipantId,
              reconnects: participant.reconnects,
              connectedAt: participant.connectedAt,
              lastSeenAt: participant.lastSeenAt,
            }
          : null,
      },
      risk: risk ? { score: risk.score, level: risk.level, computedAt: risk.computedAt } : null,
      events,
      aiEvents,
      actions,
      messages,
    };
  }

  // -------------------------------------------------------------------------
  // Interventions — server-enforced (spec §14-§16)
  // -------------------------------------------------------------------------

  async pause(user: UserContext, studentId: string, dto: PauseExamDto) {
    const { attempt, exam } = await this.requireAttemptForStudent(user, studentId);
    // Atomic guard: only ACTIVE attempts can be paused. If another monitor
    // terminated/resumed concurrently, this updateMany returns count=0.
    const result = await this.prisma.examAttempt.updateMany({
      where: { id: attempt.id, status: 'ACTIVE' },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
    if (result.count === 0) {
      throw new ConflictException(`Cannot pause an attempt in status ${attempt.status} (state changed concurrently)`);
    }
    const updated = await this.prisma.examAttempt.findUnique({ where: { id: attempt.id } });
    if (!updated) throw new ConflictException('Attempt not found after pause');
    await this.recordAction(user, attempt, 'PAUSE', dto.reason, { durationSeconds: dto.durationSeconds });
    await this.audit(user, attempt, 'monitoring.pause', { durationSeconds: dto.durationSeconds, reason: dto.reason });
    this.eventBus.emitStudentPaused(
      { attemptId: attempt.id, reason: dto.reason, durationSeconds: dto.durationSeconds, remainingMs: 0 },
      { attemptId: attempt.id, examId: exam.id, organizationId: attempt.organizationId },
    );
    return { attemptId: attempt.id, status: updated.status };
  }

  async resume(user: UserContext, studentId: string, dto: ResumeExamDto) {
    const { attempt, exam } = await this.requireAttemptForStudent(user, studentId);
    if (attempt.status !== 'PAUSED' || !attempt.pausedAt) {
      throw new ConflictException('Attempt is not paused');
    }
    const pauseSeconds = Math.round((Date.now() - attempt.pausedAt.getTime()) / 1000);
    const accumulated = attempt.accumulatedPausedSeconds + pauseSeconds;

    const examRow = await this.prisma.exam.findUnique({ where: { id: exam.id } });
    const deadline = attempt.startedAt!.getTime() + examRow!.durationMinutes * 60_000 + accumulated * 1000;
    const expired = deadline <= Date.now();

    // Atomic guard: only PAUSED attempts can be resumed
    const result = await this.prisma.examAttempt.updateMany({
      where: { id: attempt.id, status: 'PAUSED' },
      data: {
        status: expired ? 'AUTO_SUBMITTED' : 'ACTIVE',
        pausedAt: null,
        accumulatedPausedSeconds: accumulated,
        ...(expired ? { submittedAt: new Date(), autoSubmitted: true } : {}),
      },
    });
    if (result.count === 0) {
      throw new ConflictException('Attempt is not paused (state changed concurrently)');
    }
    const updated = await this.prisma.examAttempt.findUnique({ where: { id: attempt.id } });
    if (!updated) throw new ConflictException('Attempt not found after resume');
    await this.recordAction(user, attempt, 'RESUME', dto.reason, { pauseSeconds });
    await this.audit(user, attempt, 'monitoring.resume', { pauseSeconds, reason: dto.reason });
    this.eventBus.emit('student.resumed', { attemptId: attempt.id, expired }, {
      attemptId: attempt.id,
      examId: exam.id,
      organizationId: attempt.organizationId,
    });
    return { attemptId: attempt.id, status: updated.status, expired };
  }

  async terminate(user: UserContext, studentId: string, dto: TerminateExamDto) {
    const { attempt, exam } = await this.requireAttemptForStudent(user, studentId);
    if (attempt.status === 'SUBMITTED' || attempt.status === 'AUTO_SUBMITTED') {
      throw new ConflictException('Attempt already submitted; cannot terminate');
    }
    // Atomic guard: only ACTIVE/PAUSED/DISCONNECTED attempts can be terminated
    const result = await this.prisma.examAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['ACTIVE', 'PAUSED', 'DISCONNECTED'] } },
      data: { status: 'TERMINATED', pausedAt: null },
    });
    if (result.count === 0) {
      throw new ConflictException(`Cannot terminate attempt in status ${attempt.status} (state changed concurrently)`);
    }
    const updated = await this.prisma.examAttempt.findUnique({ where: { id: attempt.id } });
    if (!updated) throw new ConflictException('Attempt not found after terminate');
    await this.recordAction(user, attempt, 'TERMINATE', dto.reason, null);
    await this.audit(user, attempt, 'monitoring.terminate', { reason: dto.reason });
    // Terminating the exam also ends any live SFU publisher participant.
    await this.prisma.mediaParticipant.updateMany({
      where: { attemptId: attempt.id, status: { in: ['CONNECTING', 'ACTIVE', 'RECONNECTING', 'DISCONNECTED'] } },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    this.eventBus.emit('student.terminated', { attemptId: attempt.id, reason: dto.reason }, {
      attemptId: attempt.id,
      examId: exam.id,
      organizationId: attempt.organizationId,
    });
    return { attemptId: attempt.id, status: updated.status };
  }

  async sendMessage(user: UserContext, studentId: string, dto: SendMessageDto) {
    const { attempt, exam } = await this.requireAttemptForStudent(user, studentId);
    const student = await this.prisma.student.findUnique({ where: { id: studentId } });
    const message = await this.prisma.message.create({
      data: {
        attemptId: attempt.id,
        fromUserId: user.userId,
        toUserId: student!.userId,
        content: dto.content,
        kind: 'CUSTOM',
        deliveredAt: new Date(),
      },
    });
    await this.recordAction(user, attempt, 'MESSAGE', null, { messageId: message.id, content: dto.content });
    await this.audit(user, attempt, 'monitoring.message', { messageId: message.id });
    this.eventBus.emit('monitor.action', { attemptId: attempt.id, action: 'MESSAGE', monitorId: user.userId }, {
      attemptId: attempt.id,
      examId: exam.id,
      organizationId: attempt.organizationId,
    });
    return { messageId: message.id, sentAt: message.createdAt };
  }

  async flag(user: UserContext, studentId: string, dto: FlagStudentDto) {
    const { attempt, exam } = await this.requireAttemptForStudent(user, studentId);
    await this.recordAction(user, attempt, 'FLAG', dto.note, null);
    await this.audit(user, attempt, 'monitoring.flag', { note: dto.note });
    this.eventBus.emit('monitor.action', { attemptId: attempt.id, action: 'FLAG', monitorId: user.userId }, {
      attemptId: attempt.id,
      examId: exam.id,
      organizationId: attempt.organizationId,
    });
    return { flagged: true, attemptId: attempt.id };
  }

  // -------------------------------------------------------------------------
  // Event ingest (student client → proctoring events; AI service → ai events)
  // -------------------------------------------------------------------------

  async createProctoringEvent(user: UserContext, dto: CreateProctoringEventDto) {
    const attempt = await this.findAttemptForEvent(user, dto.attemptId);

    // Idempotent ingest (spec §18): the desktop event queue replays events with
    // a stable clientEventId after network failures, so a retry must not create
    // a duplicate record. NULL clientEventId events are never deduplicated.
    if (dto.clientEventId) {
      const existing = await this.prisma.proctoringEvent.findUnique({
        where: { clientEventId: dto.clientEventId },
      });
      if (existing) return existing;
    }

    const event = await this.prisma.proctoringEvent.create({
      data: {
        attemptId: attempt.id,
        studentId: attempt.studentId,
        examId: attempt.examId,
        organizationId: attempt.organizationId,
        type: dto.type as never,
        severity: (dto.severity ?? 'INFO') as never,
        detail: toJson(dto.detail),
        clientEventId: dto.clientEventId ?? null,
      },
    });
    this.eventBus.emit('student.focus.lost', { attemptId: attempt.id, type: dto.type }, {
      attemptId: attempt.id,
      examId: attempt.examId,
      organizationId: attempt.organizationId,
    });
    return event;
  }

  /**
   * Upserts the live device-session row (camera/mic/screen) so monitor
   * dashboards reflect the student desktop's real media state.
   */
  async updateMediaSession(user: UserContext, dto: UpdateMediaSessionDto) {
    const attempt = await this.findAttemptForEvent(user, dto.attemptId);
    const base = { attemptId: attempt.id, status: dto.status as never };
    let row: unknown;
    if (dto.kind === 'CAMERA') {
      row = await this.prisma.cameraSession.upsert({
        where: { attemptId: attempt.id },
        update: { ...base, endedAt: dto.status === 'ENDED' ? new Date() : null, lastSignalAt: new Date() },
        create: { ...base, startedAt: new Date(), lastSignalAt: new Date() },
      });
    } else if (dto.kind === 'MICROPHONE') {
      row = await this.prisma.microphoneSession.upsert({
        where: { attemptId: attempt.id },
        update: {
          ...base,
          muted: dto.muted ?? undefined,
          audioLevel: dto.audioLevel ?? undefined,
          endedAt: dto.status === 'ENDED' ? new Date() : null,
          lastSignalAt: new Date(),
        },
        create: {
          ...base,
          muted: dto.muted ?? false,
          audioLevel: dto.audioLevel ?? 0,
          startedAt: new Date(),
          lastSignalAt: new Date(),
        },
      });
    } else {
      row = await this.prisma.screenSession.upsert({
        where: { attemptId: attempt.id },
        update: { ...base, endedAt: dto.status === 'ENDED' ? new Date() : null, lastSignalAt: new Date() },
        create: { ...base, startedAt: new Date(), lastSignalAt: new Date() },
      });
    }
    return row;
  }

  async createAiEvent(user: UserContext, dto: CreateAiEventDto) {
    if (dto.confidence < 0 || dto.confidence > 1) {
      throw new BadRequestException('Confidence must be between 0.0 and 1.0');
    }
    const attempt = await this.findAttemptForEvent(user, dto.attemptId);

    // AI Cooldown / Deduplication: suppress duplicate alerts of same eventType within 5s
    const fiveSecondsAgo = new Date(Date.now() - 5_000);
    const recentDuplicate = await this.prisma.aiEvent.findFirst({
      where: {
        attemptId: attempt.id,
        eventType: dto.eventType as never,
        capturedAt: { gte: fiveSecondsAgo },
      },
    });

    if (recentDuplicate) {
      // Update confidence if higher, but don't emit duplicate alert flood
      return this.prisma.aiEvent.update({
        where: { id: recentDuplicate.id },
        data: { confidence: Math.max(recentDuplicate.confidence, dto.confidence) },
      });
    }

    const event = await this.prisma.aiEvent.create({
      data: {
        attemptId: attempt.id,
        eventType: dto.eventType as never,
        confidence: dto.confidence,
        evidenceRef: dto.evidenceRef ?? null,
        modelVersion: dto.modelVersion ?? null,
      },
    });
    const risk = await this.recomputeRisk(attempt.id);
    this.eventBus.emitAiAlert(
      {
        attemptId: attempt.id,
        eventType: dto.eventType,
        confidence: dto.confidence,
        riskScore: risk.score,
        riskLevel: risk.level,
      },
      { attemptId: attempt.id, examId: attempt.examId, organizationId: attempt.organizationId },
    );
    return event;
  }

  async reviewAiEvent(user: UserContext, eventId: string, status: 'DISMISSED' | 'CONFIRMED' | 'FLAGGED') {
    const event = await this.prisma.aiEvent.findUnique({ where: { id: eventId }, include: { attempt: true } });
    if (!event) throw new NotFoundException('AI event not found');
    await this.requireAssignedExam(user, event.attempt.examId);
    const updated = await this.prisma.aiEvent.update({
      where: { id: eventId },
      data: { status, reviewedBy: user.userId, reviewedAt: new Date() },
    });

    await this.audit(user, event.attempt, 'ai.event.reviewed', {
      eventId,
      eventType: event.eventType,
      status,
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async requireAssignedExam(user: UserContext, examId: string) {
    if (user.isSuperAdmin || user.role === 'ORG_ADMIN' || user.role === 'EXAM_MANAGER') return;
    const assigned = await this.prisma.examMonitorAssignment.findFirst({
      where: { examId, monitor: { userId: user.userId } },
    });
    if (!assigned) throw new ForbiddenException('Not assigned to this exam');
  }

  private async requireAttemptForStudent(user: UserContext, studentIdOrAttemptId: string) {
    const student = await this.prisma.student.findFirst({
      where: {
        OR: [
          { id: studentIdOrAttemptId },
          { attempts: { some: { id: studentIdOrAttemptId } } },
        ],
        organizationId: user.orgId!,
      },
    });
    if (!student) throw new NotFoundException('Student not found');
    const attempt = await this.prisma.examAttempt.findFirst({
      where: {
        studentId: student.id,
        ...(studentIdOrAttemptId !== student.id ? { id: studentIdOrAttemptId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!attempt) throw new NotFoundException('No active attempt for this student');
    await this.requireAssignedExam(user, attempt.examId);
    const exam = await this.prisma.exam.findUnique({ where: { id: attempt.examId } });
    if (!exam) throw new NotFoundException('Exam not found');
    return { attempt, exam };
  }

  private async findAttemptForEvent(user: UserContext, attemptId: string) {
    const attempt = await this.prisma.examAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (user.role === 'STUDENT') {
      const student = await this.prisma.student.findFirst({
        where: { userId: user.userId, organizationId: user.orgId! },
      });
      if (!student || attempt.studentId !== student.id) throw new ForbiddenException('Not your attempt');
    } else {
      await this.requireAssignedExam(user, attempt.examId);
    }
    return attempt;
  }

  private async recomputeRisk(attemptId: string): Promise<{ score: number; level: RiskLevel }> {
    const attempt = await this.prisma.examAttempt.findUnique({
      where: { id: attemptId },
      include: { exam: { include: { settings: true } } },
    });
    if (!attempt) return { score: 0, level: 'NORMAL' };
    const events = await this.prisma.aiEvent.findMany({
      where: { attemptId },
      orderBy: { capturedAt: 'asc' },
      take: 500,
    });
    const weights: RiskWeights =
      (attempt.exam.settings?.riskWeights as RiskWeights | null) ?? DEFAULT_RISK_WEIGHTS;
    const tracker = new RiskTracker(weights);
    let last: ReturnType<RiskTracker['add']> = { score: 0, level: 'NORMAL', events: [] };
    for (const event of events) {
      last = tracker.add({
        eventType: event.eventType as never,
        confidence: event.confidence,
        timestamp: event.capturedAt.getTime(),
      });
    }
    await this.prisma.riskScore.create({
      data: {
        attemptId,
        score: last.score,
        level: last.level,
        configSnapshot: toJson(weights),
      },
    });
    return { score: last.score, level: last.level };
  }

  private async recordAction(
    user: UserContext,
    attempt: { id: string; studentId: string; examId: string },
    action: string,
    reason: string | null,
    payload: Record<string, unknown> | null,
  ) {
    await this.prisma.monitorAction.create({
      data: {
        monitorId: user.userId,
        studentId: attempt.studentId,
        examId: attempt.examId,
        attemptId: attempt.id,
        action: action as never,
        reason,
        payload: toJson(payload),
      },
    });
  }

  private async audit(
    user: UserContext,
    attempt: { id: string; organizationId: string },
    action: string,
    detail: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organizationId: attempt.organizationId,
        actorUserId: user.userId,
        actorEmail: user.email,
        action,
        resourceType: 'ExamAttempt',
        resourceId: attempt.id,
        detail: toJson(detail),
      },
    });
  }
}