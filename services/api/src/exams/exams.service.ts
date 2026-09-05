import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ExamStatus } from '@examguard/types';
import { PrismaService } from '../prisma/prisma.service';
import type { UserContext } from '../common/types';
import {
  AssignMonitorsDto,
  AssignStudentsDto,
  CreateExamDto,
  LinkQuestionsDto,
  UpdateExamDto,
} from './dto';

const EXAM_INCLUDE = {
  _count: { select: { questions: true, assignments: true } },
} as const;

@Injectable()
export class ExamsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertOrg(user: UserContext): string {
    if (!user.orgId) throw new BadRequestException('Organization required');
    return user.orgId;
  }

  async create(user: UserContext, dto: CreateExamDto) {
    const orgId = this.assertOrg(user);
    const exam = await this.prisma.$transaction(async (tx) => {
      const created = await tx.exam.create({
        data: {
          organizationId: orgId,
          name: dto.name,
          description: dto.description ?? null,
          instructions: dto.instructions ?? null,
          startAt: dto.startAt ? new Date(dto.startAt) : null,
          endAt: dto.endAt ? new Date(dto.endAt) : null,
          durationMinutes: dto.durationMinutes ?? 60,
          maxAttempts: dto.maxAttempts ?? 1,
          shuffleQuestions: dto.shuffleQuestions ?? false,
          shuffleOptions: dto.shuffleOptions ?? false,
          negativeMarkingEnabled: dto.negativeMarkingEnabled ?? false,
          negativeMarkingValue: dto.negativeMarkingValue ?? 0.25,
          passingScore: dto.passingScore ?? 40,
          autoSubmit: dto.autoSubmit ?? true,
          status: dto.status ?? 'DRAFT',
          createdBy: user.userId,
        },
      });
      await tx.examSettings.create({
        data: {
          examId: created.id,
          cameraRequired: dto.settings?.cameraRequired ?? true,
          microphoneRequired: dto.settings?.microphoneRequired ?? true,
          screenMonitoringRequired: dto.settings?.screenMonitoringRequired ?? true,
          identityVerificationRequired: dto.settings?.identityVerificationRequired ?? true,
          aiProctoringEnabled: dto.settings?.aiProctoringEnabled ?? true,
          clipboardPolicy: (dto.settings?.clipboardPolicy as never) ?? 'BLOCK',
          fullScreenPolicy: (dto.settings?.fullScreenPolicy as never) ?? 'REQUIRED',
          appSwitchPolicy: (dto.settings?.appSwitchPolicy as never) ?? 'BLOCK',
          multipleFacePolicy: (dto.settings?.multipleFacePolicy as never) ?? 'ALERT',
          phoneObjectDetection: dto.settings?.phoneObjectDetection ?? true,
          allowOfflineMode: dto.settings?.allowOfflineMode ?? true,
          evidencePolicy: (dto.settings?.evidencePolicy as never) ?? 'EVENT_ONLY',
          retentionDays: dto.settings?.retentionDays ?? 90,
        },
      });
      return created;
    });
    return this.findOne(user, exam.id);
  }

  async list(user: UserContext) {
    const orgId = this.assertOrg(user);
    if (user.role === 'MONITOR') {
      const exams = await this.prisma.exam.findMany({
        where: { organizationId: orgId, monitorAssignments: { some: { monitor: { userId: user.userId } } } },
        include: { ...EXAM_INCLUDE, monitorAssignments: true },
        orderBy: { createdAt: 'desc' },
      });
      return exams.map((e) => ({ ...e, monitorAssignments: undefined }));
    }
    if (user.role === 'STUDENT') {
      const exams = await this.prisma.exam.findMany({
        where: { organizationId: orgId, assignments: { some: { student: { userId: user.userId } } } },
        include: { ...EXAM_INCLUDE, assignments: { where: { student: { userId: user.userId } } } },
        orderBy: { createdAt: 'desc' },
      });
      return exams.map((e) => ({
        ...e,
        assignmentId: e.assignments[0]?.id ?? null,
        assignments: undefined,
      }));
    }
    const exams = await this.prisma.exam.findMany({
      where: { organizationId: orgId },
      include: EXAM_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return exams;
  }

  async findOne(user: UserContext, examId: string) {
    const orgId = this.assertOrg(user);
    const exam = await this.prisma.exam.findFirst({
      where: {
        id: examId,
        organizationId: orgId,
        ...(user.role === 'MONITOR' || user.role === 'STUDENT'
          ? {
              OR: [
                { monitorAssignments: { some: { monitor: { userId: user.userId } } } },
                { assignments: { some: { student: { userId: user.userId } } } },
              ],
            }
          : {}),
      },
      include: {
        settings: true,
        _count: { select: { questions: true, assignments: true } },
      },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    return exam;
  }

  async update(user: UserContext, examId: string, dto: UpdateExamDto) {
    await this.requireOwned(user, examId);
    const data: Record<string, unknown> = {};
    for (const key of [
      'name', 'description', 'instructions', 'startAt', 'endAt', 'durationMinutes',
      'maxAttempts', 'shuffleQuestions', 'shuffleOptions', 'negativeMarkingEnabled',
      'negativeMarkingValue', 'passingScore', 'autoSubmit', 'status',
    ] as const) {
      const value = dto[key];
      if (value !== undefined) {
        data[key] = key === 'startAt' || key === 'endAt' ? new Date(value as string) : value;
      }
    }
    const exam = await this.prisma.exam.update({ where: { id: examId }, data });
    if (dto.settings) {
      await this.prisma.examSettings.update({
        where: { examId },
        data: {
          ...(dto.settings.cameraRequired !== undefined && { cameraRequired: dto.settings.cameraRequired }),
          ...(dto.settings.microphoneRequired !== undefined && { microphoneRequired: dto.settings.microphoneRequired }),
          ...(dto.settings.screenMonitoringRequired !== undefined && { screenMonitoringRequired: dto.settings.screenMonitoringRequired }),
          ...(dto.settings.identityVerificationRequired !== undefined && { identityVerificationRequired: dto.settings.identityVerificationRequired }),
          ...(dto.settings.aiProctoringEnabled !== undefined && { aiProctoringEnabled: dto.settings.aiProctoringEnabled }),
          ...(dto.settings.clipboardPolicy !== undefined && { clipboardPolicy: dto.settings.clipboardPolicy as never }),
          ...(dto.settings.fullScreenPolicy !== undefined && { fullScreenPolicy: dto.settings.fullScreenPolicy as never }),
          ...(dto.settings.appSwitchPolicy !== undefined && { appSwitchPolicy: dto.settings.appSwitchPolicy as never }),
          ...(dto.settings.multipleFacePolicy !== undefined && { multipleFacePolicy: dto.settings.multipleFacePolicy as never }),
          ...(dto.settings.phoneObjectDetection !== undefined && { phoneObjectDetection: dto.settings.phoneObjectDetection }),
          ...(dto.settings.allowOfflineMode !== undefined && { allowOfflineMode: dto.settings.allowOfflineMode }),
          ...(dto.settings.evidencePolicy !== undefined && { evidencePolicy: dto.settings.evidencePolicy as never }),
          ...(dto.settings.retentionDays !== undefined && { retentionDays: dto.settings.retentionDays }),
        },
      });
    }
    return exam;
  }

  async remove(user: UserContext, examId: string) {
    await this.requireOwned(user, examId);
    const attemptCount = await this.prisma.examAttempt.count({ where: { examId } });
    if (attemptCount > 0) {
      throw new BadRequestException('Cannot delete an exam with existing attempts');
    }
    await this.prisma.exam.delete({ where: { id: examId } });
    return { deleted: true };
  }

  async linkQuestions(user: UserContext, examId: string, dto: LinkQuestionsDto) {
    await this.requireOwned(user, examId);
    const orgId = this.assertOrg(user);
    const questions = await this.prisma.question.findMany({
      where: { id: { in: dto.questionIds }, organizationId: orgId },
    });
    if (questions.length !== new Set(dto.questionIds).size) {
      throw new BadRequestException('Some questions do not exist in this organization');
    }
    const maxOrder = await this.prisma.examQuestion.aggregate({
      where: { examId },
      _max: { order: true },
    });
    let order = (maxOrder._max.order ?? 0) + 1;
    for (const qid of dto.questionIds) {
      await this.prisma.examQuestion.upsert({
        where: { examId_questionId: { examId, questionId: qid } },
        update: {},
        create: { examId, questionId: qid, order: order++ },
      });
    }
    return this.findOne(user, examId);
  }

  async assignStudents(user: UserContext, examId: string, dto: AssignStudentsDto) {
    await this.requireOwned(user, examId);
    const orgId = this.assertOrg(user);
    const students = await this.prisma.student.findMany({
      where: { id: { in: dto.studentIds }, organizationId: orgId },
    });
    if (students.length !== new Set(dto.studentIds).size) {
      throw new BadRequestException('Some students do not exist in this organization');
    }
    for (const sid of dto.studentIds) {
      await this.prisma.examAssignment.upsert({
        where: { examId_studentId: { examId, studentId: sid } },
        update: {},
        create: { examId, studentId: sid, assignedById: user.userId },
      });
    }
    return this.findOne(user, examId);
  }

  async assignMonitors(user: UserContext, examId: string, dto: AssignMonitorsDto) {
    await this.requireOwned(user, examId);
    const orgId = this.assertOrg(user);
    const monitors = await this.prisma.monitor.findMany({
      where: { id: { in: dto.monitorIds }, organizationId: orgId },
    });
    if (monitors.length !== new Set(dto.monitorIds).size) {
      throw new BadRequestException('Some monitors do not exist in this organization');
    }
    for (const mid of dto.monitorIds) {
      await this.prisma.examMonitorAssignment.upsert({
        where: { examId_monitorId: { examId, monitorId: mid } },
        update: {},
        create: { examId, monitorId: mid },
      });
    }
    return this.findOne(user, examId);
  }

  async results(user: UserContext, examId: string) {
    await this.requireVisible(user, examId);
    const attempts = await this.prisma.examAttempt.findMany({
      where: { examId },
      include: {
        student: { include: { user: true } },
        riskScores: { orderBy: { computedAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });
    return attempts.map((a) => ({
      attemptId: a.id,
      studentName: `${a.student.user.firstName} ${a.student.user.lastName}`,
      studentCode: a.student.studentCode,
      status: a.status,
      score: a.score,
      scoreGraded: a.scoreGraded,
      startedAt: a.startedAt,
      submittedAt: a.submittedAt,
      riskScore: a.riskScores[0]?.score ?? null,
      riskLevel: a.riskScores[0]?.level ?? null,
    }));
  }

  async proctoringSummary(user: UserContext, examId: string) {
    await this.requireVisible(user, examId);
    const orgId = this.assertOrg(user);
    const [eventCount, aiPending, criticalAttempts, activeCount] = await Promise.all([
      this.prisma.proctoringEvent.count({ where: { examId, organizationId: orgId } }),
      this.prisma.aiEvent.count({ where: { attempt: { examId }, status: 'PENDING' } }),
      this.prisma.examAttempt.count({
        where: { examId, riskScores: { some: { level: { in: ['SUSPICIOUS', 'CRITICAL'] } } } },
      }),
      this.prisma.examAttempt.count({ where: { examId, status: 'ACTIVE' } }),
    ]);
    const topRisk = await this.prisma.examAttempt.findMany({
      where: { examId, riskScores: { some: {} } },
      include: {
        student: { include: { user: true } },
        riskScores: { orderBy: { computedAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
    return {
      examId,
      eventCount,
      aiPendingCount: aiPending,
      criticalAttemptCount: criticalAttempts,
      activeCount,
      topRisk: topRisk.map((a) => ({
        attemptId: a.id,
        studentName: `${a.student.user.firstName} ${a.student.user.lastName}`,
        riskScore: a.riskScores[0]?.score ?? 0,
        riskLevel: a.riskScores[0]?.level ?? 'NORMAL',
        status: a.status,
      })),
    };
  }

  async changeStatus(user: UserContext, examId: string, status: ExamStatus) {
    await this.requireOwned(user, examId);
    return this.prisma.exam.update({ where: { id: examId }, data: { status } });
  }

  private async requireOwned(user: UserContext, examId: string) {
    const orgId = this.assertOrg(user);
    const exam = await this.prisma.exam.findFirst({ where: { id: examId, organizationId: orgId } });
    if (!exam) throw new NotFoundException('Exam not found');
  }

  private async requireVisible(user: UserContext, examId: string) {
    const orgId = this.assertOrg(user);
    const exam = await this.prisma.exam.findFirst({
      where: {
        id: examId,
        organizationId: orgId,
        ...(user.role === 'MONITOR'
          ? { monitorAssignments: { some: { monitor: { userId: user.userId } } } }
          : {}),
      },
    });
    // 404 (not 403) so cross-org existence probing leaks nothing.
    if (!exam) throw new NotFoundException('Exam not found');
  }
}