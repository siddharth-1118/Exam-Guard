import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ACTIVE_ATTEMPT_STATUSES, type AttemptStatus } from '@examguard/types';
import { computeScore, type GradableQuestion } from '@examguard/security';
import { Prisma } from '@examguard/database';
import { PrismaService } from '../prisma/prisma.service';

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === null || value === undefined ? undefined : (value as Prisma.InputJsonValue);
}
import { EventBus } from '../common/event-bus';
import type { UserContext } from '../common/types';
import { RegradeAttemptDto, SaveAnswerDto, StartAttemptDto } from './dto';
import { RecordingsService } from '../recordings/recordings.service';

type AttemptRow = {
  id: string;
  examId: string;
  status: AttemptStatus;
  startedAt: Date | null;
  submittedAt: Date | null;
  pausedAt: Date | null;
  accumulatedPausedSeconds: number;
  organizationId: string;
  autoSubmitted: boolean;
  score: number | null;
};

/**
 * Server-authoritative exam timing (spec §38).
 * deadlineMs = startedAt + durationMinutes*60_000 + accumulatedPausedSeconds*1_000
 * While PAUSED the clock is frozen (pausedAt set); on resume the pause duration
 * is folded into accumulatedPausedSeconds. Client clocks are never consulted.
 */
@Injectable()
export class AttemptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
    private readonly recordingsService: RecordingsService,
  ) {}


  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  async start(user: UserContext, dto: StartAttemptDto) {
    if (!user.orgId) throw new BadRequestException('Organization required');

    const exam = await this.prisma.exam.findFirst({
      where: { id: dto.examId, organizationId: user.orgId },
      include: { settings: true },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status === 'DRAFT') throw new BadRequestException('Exam is not open');
    if (exam.startAt && new Date() < exam.startAt) {
      throw new BadRequestException('Exam has not started');
    }
    if (exam.endAt && new Date() > exam.endAt) {
      throw new BadRequestException('Exam has ended');
    }

    const student = await this.prisma.student.findFirst({
      where: { organizationId: user.orgId, userId: user.userId },
    });
    if (!student) throw new ForbiddenException('Not a registered student');
    const assignment = await this.prisma.examAssignment.findUnique({
      where: { examId_studentId: { examId: exam.id, studentId: student.id } },
    });
    if (!assignment) throw new ForbiddenException('Not assigned to this exam');

    // Check identity verification requirement
    if (exam.settings?.identityVerificationRequired) {
      const consentObj = (dto.consent ?? {}) as Record<string, unknown>;
      if (!consentObj.identityVerified && !consentObj.consentGiven && consentObj.agreed !== true) {
        throw new BadRequestException(
          'Identity verification and student consent are required to start this examination',
        );
      }
    }

    const existing = await this.prisma.examAttempt.findFirst({
      where: { examId: exam.id, studentId: student.id },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    if (existing && ACTIVE_ATTEMPT_STATUSES.includes(existing.status as AttemptStatus)) {
      return { attempt: await this.toAttemptView(existing, exam.durationMinutes) };
    }
    if (existing && existing.status === 'SUBMITTED' && exam.maxAttempts <= 1) {
      throw new ConflictException('Attempt already submitted');
    }
    if (existing && (existing.status === 'TERMINATED' || existing.status === 'UNDER_REVIEW')) {
      throw new ConflictException('Attempt is not eligible for another start');
    }

    const attempt = await this.prisma.$transaction(async (tx) => {
      const created = await tx.examAttempt.create({
        data: {
          examId: exam.id,
          studentId: student.id,
          organizationId: user.orgId!,
          status: 'ACTIVE',
          startedAt: new Date(),
          consent: toJson(dto.consent),
        },
      });
      await tx.deviceSession.create({
        data: {
          attemptId: created.id,
          studentId: student.id,
          organizationId: user.orgId!,
          os: dto.deviceInfo?.os ?? null,
          appVersion: dto.deviceInfo?.appVersion ?? null,
          deviceInfo: toJson(dto.deviceInfo),
        },
      });
      return created;
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.orgId!,
        actorUserId: user.userId,
        actorEmail: user.email,
        action: 'attempt.start',
        resourceType: 'ExamAttempt',
        resourceId: attempt.id,
        detail: { examId: exam.id },
      },
    });

    this.eventBus.emit('student.connected', { attemptId: attempt.id }, {
      attemptId: attempt.id,
      examId: exam.id,
      organizationId: user.orgId!,
    });

    const questions = await this.loadQuestionsForStudent(exam.id);
    return {
      attempt: await this.toAttemptView(attempt, exam.durationMinutes),
      questions,
    };
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async getAttempt(user: UserContext, attemptId: string) {
    const attempt = await this.findVisibleAttempt(user, attemptId);
    const exam = await this.prisma.exam.findUnique({ where: { id: attempt.examId } });
    if (!exam) throw new NotFoundException('Exam not found');
    if (user.role === 'STUDENT') {
      const questions = await this.loadQuestionsForStudent(exam.id);
      const answers = await this.prisma.answer.findMany({ where: { attemptId } });
      return {
        attempt: await this.toAttemptView(attempt, exam.durationMinutes),
        questions,
        answers: answers.map((a) => ({ questionId: a.questionId, value: a.value })),
      };
    }
    return { attempt: await this.toAttemptView(attempt, exam.durationMinutes) };
  }

  // -------------------------------------------------------------------------
  // Answers (autosave) — server-authoritative
  // -------------------------------------------------------------------------

  async saveAnswer(user: UserContext, attemptId: string, dto: SaveAnswerDto) {
    const attempt = await this.findVisibleAttempt(user, attemptId);
    const exam = await this.prisma.exam.findUnique({ where: { id: attempt.examId } });
    if (!exam) throw new NotFoundException('Exam not found');
    this.assertCanWrite(attempt);

    if (this.remainingMs(attempt, exam.durationMinutes) <= 0) {
      throw new ConflictException('Exam time has expired; answers are locked');
    }

    const belongsToExam = await this.prisma.examQuestion.findUnique({
      where: { examId_questionId: { examId: attempt.examId, questionId: dto.questionId } },
    });
    if (!belongsToExam) throw new BadRequestException('Question does not belong to this exam');

    await this.prisma.answer.upsert({
      where: { attemptId_questionId: { attemptId, questionId: dto.questionId } },
      update: { value: dto.value as never },
      create: {
        attemptId,
        questionId: dto.questionId,
        value: dto.value as never,
        syncedFromOffline: Boolean(dto.syncedFromOffline),
      },
    });

    return {
      savedAt: new Date().toISOString(),
      serverTime: new Date().toISOString(),
      remainingMs: this.remainingMs(attempt, exam.durationMinutes),
    };
  }

  // -------------------------------------------------------------------------
  // Heartbeat / liveness
  // -------------------------------------------------------------------------

  async heartbeat(user: UserContext, attemptId: string) {
    const attempt = await this.findVisibleAttempt(user, attemptId);
    const exam = await this.prisma.exam.findUnique({ where: { id: attempt.examId } });
    if (!exam) throw new NotFoundException('Exam not found');

    if (attempt.status !== 'PAUSED' && this.remainingMs(attempt, exam.durationMinutes) <= 0) {
      await this.finalizeSubmit(attempt, true, user.userId);
      return this.toAttemptView(await this.reload(attempt.id), exam.durationMinutes);
    }

    await this.prisma.deviceSession.updateMany({
      where: { attemptId },
      data: { lastSignalAt: new Date(), status: 'ACTIVE' },
    });

    let updated = attempt;
    if (attempt.status === 'DISCONNECTED') {
      updated = await this.prisma.examAttempt.update({
        where: { id: attempt.id },
        data: { status: 'ACTIVE' },
      });
      this.eventBus.emit('student.connected', { attemptId }, {
        attemptId,
        examId: exam.id,
        organizationId: attempt.organizationId,
      });
    }

    return this.toAttemptView(updated, exam.durationMinutes);
  }

  /** Marks stale ACTIVE attempts DISCONNECTED (liveness sweep). */
  @Interval(60_000)
  async livenessSweep(): Promise<void> {
    if (process.env.APP_ENV === 'test') return;
    const staleBefore = new Date(Date.now() - 90_000);
    const stale = await this.prisma.examAttempt.findMany({
      where: {
        status: 'ACTIVE',
        startedAt: { not: null },
        deviceSession: { lastSignalAt: { lt: staleBefore } },
      },
    });
    for (const attempt of stale) {
      await this.prisma.examAttempt.update({
        where: { id: attempt.id },
        data: { status: 'DISCONNECTED' },
      });
      this.eventBus.emit('student.disconnected', { attemptId: attempt.id }, {
        attemptId: attempt.id,
        examId: attempt.examId,
        organizationId: attempt.organizationId,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Submit (student-initiated)
  // -------------------------------------------------------------------------

  async submit(user: UserContext, attemptId: string) {
    const attempt = await this.findVisibleAttempt(user, attemptId);
    const exam = await this.prisma.exam.findUnique({ where: { id: attempt.examId } });
    if (attempt.status === 'SUBMITTED' || attempt.status === 'AUTO_SUBMITTED') {
      return this.toAttemptView(attempt, exam?.durationMinutes ?? 60);
    }
    if (attempt.status === 'TERMINATED') {
      throw new ConflictException('Attempt was terminated; submission is not allowed');
    }
    this.assertCanWrite(attempt);
    await this.finalizeSubmit(attempt, false, user.userId);
    return this.toAttemptView(await this.reload(attempt.id), exam?.durationMinutes ?? 60);
  }

  async regrade(user: UserContext, attemptId: string, dto?: RegradeAttemptDto) {
    const attempt = await this.findVisibleAttempt(user, attemptId);
    if (user.role === 'STUDENT') {
      throw new ForbiddenException('Students cannot regrade attempts');
    }
    const exam = await this.prisma.exam.findUnique({ where: { id: attempt.examId } });
    if (!exam) throw new NotFoundException('Exam not found');

    if (dto?.grades && dto.grades.length > 0) {
      for (const item of dto.grades) {
        const belongsToExam = await this.prisma.examQuestion.findUnique({
          where: { examId_questionId: { examId: attempt.examId, questionId: item.questionId } },
        });
        if (belongsToExam) {
          await this.prisma.answer.upsert({
            where: { attemptId_questionId: { attemptId, questionId: item.questionId } },
            update: { isFinal: true },
            create: { attemptId, questionId: item.questionId, value: item.score as never, isFinal: true },
          });
        }
      }
    }

    const examQuestions = await this.prisma.examQuestion.findMany({
      where: { examId: exam.id },
      include: { question: { include: { options: true } } },
      orderBy: { order: 'asc' },
    });
    const answers = await this.prisma.answer.findMany({ where: { attemptId: attempt.id } });
    const negOverride =
      exam.negativeMarkingEnabled && exam.negativeMarkingValue != null
        ? exam.negativeMarkingValue
        : null;
    const gradable: GradableQuestion[] = examQuestions.map((eq) => ({
      id: eq.question.id,
      type: eq.question.type,
      marks: eq.marksOverride ?? eq.question.marks,
      negativeMarks: negOverride ?? eq.question.negativeMarks,
      options: eq.question.options.map((o) => ({ id: o.id, isCorrect: o.isCorrect, text: o.text })),
      metadata: (eq.question.metadata as { tolerance?: number } | null) ?? undefined,
    }));

    const summary = computeScore(
      gradable,
      answers.map((a) => ({ questionId: a.questionId, value: a.value as never })),
      exam.negativeMarkingEnabled,
    );

    const updated = await this.prisma.examAttempt.update({
      where: { id: attempt.id },
      data: {
        score: summary.score,
        scoreGraded: true,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: attempt.organizationId,
        actorUserId: user.userId,
        actorEmail: user.email,
        action: 'attempt.regrade',
        resourceType: 'ExamAttempt',
        resourceId: attempt.id,
        detail: { previousScore: attempt.score, newScore: summary.score },
      },
    });

    return this.toAttemptView(updated, exam.durationMinutes);
  }

  // -------------------------------------------------------------------------
  // Auto-submit sweeper (spec §54) — server-side deadline enforcement
  // -------------------------------------------------------------------------

  @Interval(30_000)
  async autoSubmitSweeper(): Promise<void> {
    if (process.env.APP_ENV === 'test') return;
    const attempts = await this.prisma.examAttempt.findMany({
      where: {
        status: { in: ['ACTIVE', 'DISCONNECTED'] },
        startedAt: { not: null },
      },
      include: { exam: true },
    });
    for (const attempt of attempts) {
      if (this.remainingMs(attempt, attempt.exam.durationMinutes) <= 0) {
        await this.finalizeSubmit(attempt, true, null);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async finalizeSubmit(attempt: AttemptRow, auto: boolean, submittedBy: string | null) {
    const exam = await this.prisma.exam.findUnique({ where: { id: attempt.examId } });
    if (!exam) throw new NotFoundException('Exam not found');

    const examQuestions = await this.prisma.examQuestion.findMany({
      where: { examId: exam.id },
      include: { question: { include: { options: true } } },
      orderBy: { order: 'asc' },
    });
    const answers = await this.prisma.answer.findMany({ where: { attemptId: attempt.id } });

    // Exam-level negativeMarkingValue (fraction) overrides per-question
    // negative marks when the exam enables negative marking.
    const negOverride =
      exam.negativeMarkingEnabled && exam.negativeMarkingValue != null
        ? exam.negativeMarkingValue
        : null;
    const gradable: GradableQuestion[] = examQuestions.map((eq) => ({
      id: eq.question.id,
      type: eq.question.type,
      marks: eq.marksOverride ?? eq.question.marks,
      negativeMarks: negOverride ?? eq.question.negativeMarks,
      options: eq.question.options.map((o) => ({ id: o.id, isCorrect: o.isCorrect })),
      metadata: (eq.question.metadata as { tolerance?: number } | null) ?? undefined,
    }));
    const summary = computeScore(
      gradable,
      answers.map((a) => ({ questionId: a.questionId, value: a.value as never })),
      exam.negativeMarkingEnabled,
    );

    const updated = await this.prisma.examAttempt.update({
      where: { id: attempt.id },
      data: {
        status: auto ? 'AUTO_SUBMITTED' : 'SUBMITTED',
        submittedAt: new Date(),
        pausedAt: null,
        score: summary.graded ? summary.score : null,
        scoreGraded: summary.graded,
        autoSubmitted: auto,
      },
    });

    this.eventBus.emit('student.submitted', { attemptId: attempt.id, auto }, {
      attemptId: attempt.id,
      examId: exam.id,
      organizationId: attempt.organizationId,
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId: attempt.organizationId,
        actorUserId: submittedBy ?? undefined,
        action: auto ? 'attempt.auto-submit' : 'attempt.submit',
        resourceType: 'ExamAttempt',
        resourceId: attempt.id,
        detail: { score: summary.score, auto },
      },
    });
    await this.closeMediaParticipant(attempt.id);
    return updated;
  }

  /** Submission ends the attempt's SFU publisher participation and stops active recording. */
  private async closeMediaParticipant(attemptId: string): Promise<void> {
    const participants = await this.prisma.mediaParticipant.findMany({
      where: { attemptId },
      select: { id: true },
    });
    for (const p of participants) {
      try {
        const sfuUrl = process.env.SFU_URL || 'http://localhost:4010';
        const adminKey = process.env.SFU_ADMIN_KEY || 'examguard-dev-sfu-admin-key';
        await fetch(`${sfuUrl.replace(/^ws/, 'http')}/admin/recording/stop`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-sfu-admin-key': adminKey,
          },
          body: JSON.stringify({ participantId: p.id }),
        });
      } catch {
        // SFU may already be down or missing participant
      }
    }

    await this.prisma.mediaParticipant.updateMany({
      where: { attemptId, status: { in: ['CONNECTING', 'ACTIVE', 'RECONNECTING', 'DISCONNECTED'] } },
      data: { status: 'ENDED', endedAt: new Date() },
    });
  }


  private async toAttemptView(attempt: AttemptRow, durationMinutes: number) {
    const exam = await this.prisma.exam.findUnique({ where: { id: attempt.examId } });
    const deadline = attempt.startedAt
      ? attempt.startedAt.getTime() + durationMinutes * 60_000 + attempt.accumulatedPausedSeconds * 1000
      : null;
    const questionCount = exam
      ? await this.prisma.examQuestion.count({ where: { examId: exam.id } })
      : 0;
    const answeredCount = await this.prisma.answer.count({ where: { attemptId: attempt.id } });
    return {
      id: attempt.id,
      examId: attempt.examId,
      examName: exam?.name ?? '',
      status: attempt.status,
      startedAt: attempt.startedAt?.toISOString() ?? null,
      submittedAt: attempt.submittedAt?.toISOString() ?? null,
      deadline: deadline ? new Date(deadline).toISOString() : null,
      remainingMs: this.remainingMs(attempt, durationMinutes),
      paused: attempt.status === 'PAUSED',
      questionCount,
      answeredCount,
      score: attempt.score,
    };
  }

  private remainingMs(attempt: AttemptRow, durationMinutes: number): number {
    if (!attempt.startedAt) return 0;
    const deadline =
      attempt.startedAt.getTime() +
      durationMinutes * 60_000 +
      attempt.accumulatedPausedSeconds * 1000;
    return Math.max(0, deadline - Date.now());
  }

  private async reload(attemptId: string): Promise<AttemptRow> {
    const attempt = await this.prisma.examAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Attempt not found');
    return attempt;
  }

  private async findVisibleAttempt(user: UserContext, attemptId: string): Promise<AttemptRow> {
    const attempt = await this.prisma.examAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Attempt not found');

    if (user.role === 'STUDENT') {
      const student = await this.prisma.student.findFirst({
        where: { userId: user.userId, organizationId: user.orgId! },
      });
      if (!student || attempt.studentId !== student.id) {
        throw new ForbiddenException('Not your attempt');
      }
      return attempt;
    }
    if (user.role === 'MONITOR') {
      const assigned = await this.prisma.examMonitorAssignment.findFirst({
        where: { examId: attempt.examId, monitor: { userId: user.userId } },
      });
      if (!assigned) throw new ForbiddenException('Not assigned to this exam');
      return attempt;
    }
    if (attempt.organizationId !== user.orgId && !user.isSuperAdmin) {
      throw new ForbiddenException('Not accessible');
    }
    return attempt;
  }

  private assertCanWrite(attempt: AttemptRow) {
    if (attempt.status !== 'ACTIVE') {
      throw new ConflictException(
        attempt.status === 'PAUSED'
          ? 'Exam is paused by the monitor; answering is not allowed'
          : `Cannot write to attempt in status ${attempt.status}`,
      );
    }
  }

  private async loadQuestionsForStudent(examId: string) {
    const examQuestions = await this.prisma.examQuestion.findMany({
      where: { examId },
      include: { question: { include: { options: true } } },
      orderBy: { order: 'asc' },
    });
    return examQuestions.map((eq) => {
      const q = eq.question;
      return {
        id: q.id,
        type: q.type,
        text: q.text,
        marks: eq.marksOverride ?? q.marks,
        difficulty: q.difficulty,
        metadata: q.metadata,
        // isCorrect is NEVER sent to students
        options: q.options
          .sort((a, b) => a.order - b.order)
          .map((o) => ({ id: o.id, text: o.text, order: o.order })),
      };
    });
  }
}