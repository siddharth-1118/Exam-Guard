import { Injectable, NotFoundException } from '@nestjs/common';
import { gradeAnswer } from '@examguard/security';
import { PrismaService } from '../prisma/prisma.service';
import type { UserContext } from '../common/types';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Admin dashboard stats (spec §5). */
  async dashboard(user: UserContext) {
    const orgId = user.orgId;
    if (!orgId && !user.isSuperAdmin) {
      return { error: 'organization required' };
    }
    const orgFilter = orgId ? { organizationId: orgId } : {};
    const [totalStudents, activeExams, liveExams, activeMonitors, suspiciousEvents, criticalAlerts, completedExams] =
      await Promise.all([
        this.prisma.student.count({ where: orgFilter }),
        this.prisma.exam.count({ where: { ...orgFilter, status: { in: ['SCHEDULED', 'OPEN'] } } }),
        this.prisma.examAttempt.count({ where: { ...orgFilter, status: 'ACTIVE' } }),
        this.prisma.monitor.count({ where: orgFilter }),
        this.prisma.aiEvent.count({ where: { attempt: orgFilter as never, status: 'PENDING' } }),
        this.prisma.examAttempt.count({
          where: {
            ...orgFilter,
            riskScores: { some: { level: { in: ['SUSPICIOUS', 'CRITICAL'] } } },
          },
        }),
        this.prisma.examAttempt.count({
          where: { ...orgFilter, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
        }),
      ]);
    const scored = await this.prisma.examAttempt.aggregate({
      where: { ...orgFilter, scoreGraded: true },
      _avg: { score: true },
      _count: true,
    });
    const pendingReview = await this.prisma.examAttempt.count({
      where: { ...orgFilter, status: 'UNDER_REVIEW' },
    });
    return {
      totalStudents,
      activeExams,
      liveExams,
      activeMonitors,
      suspiciousEvents,
      criticalAlerts,
      completedExams,
      averageScore: scored._avg.score ?? null,
      scoredCount: scored._count,
      pendingReview,
    };
  }

  async examReport(user: UserContext, examId: string) {
    const orgId = user.orgId;
    const exam = await this.prisma.exam.findFirst({
      where: { id: examId, ...(orgId && !user.isSuperAdmin ? { organizationId: orgId } : {}) },
    });
    if (!exam) throw new NotFoundException('Exam not found');

    const [totalAttempts, submittedCount, autoSubmittedCount, terminatedCount] = await Promise.all([
      this.prisma.examAttempt.count({ where: { examId } }),
      this.prisma.examAttempt.count({ where: { examId, status: 'SUBMITTED' } }),
      this.prisma.examAttempt.count({ where: { examId, status: 'AUTO_SUBMITTED' } }),
      this.prisma.examAttempt.count({ where: { examId, status: 'TERMINATED' } }),
    ]);

    const scoredAgg = await this.prisma.examAttempt.aggregate({
      where: { examId, scoreGraded: true },
      _avg: { score: true },
      _min: { score: true },
      _max: { score: true },
      _count: true,
    });

    const passedCount = await this.prisma.examAttempt.count({
      where: {
        examId,
        scoreGraded: true,
        score: { gte: exam.passingScore },
      },
    });

    const failedCount = (scoredAgg._count ?? 0) - passedCount;

    return {
      examId: exam.id,
      examName: exam.name,
      passingScore: exam.passingScore,
      totalAttempts,
      submittedCount,
      autoSubmittedCount,
      terminatedCount,
      scoredCount: scoredAgg._count,
      averageScore: scoredAgg._avg.score ?? null,
      minScore: scoredAgg._min.score ?? null,
      maxScore: scoredAgg._max.score ?? null,
      passedCount,
      failedCount,
      passPercentage: scoredAgg._count > 0 ? Math.round((passedCount / scoredAgg._count) * 100) : 0,
    };
  }

  async questionReport(user: UserContext, examId: string, page = 1, limit = 50) {
    const orgId = user.orgId;
    const exam = await this.prisma.exam.findFirst({
      where: { id: examId, ...(orgId && !user.isSuperAdmin ? { organizationId: orgId } : {}) },
    });
    if (!exam) throw new NotFoundException('Exam not found');

    const p = Math.max(1, page);
    const take = Math.min(100, Math.max(1, limit));

    const examQuestions = await this.prisma.examQuestion.findMany({
      where: { examId },
      include: { question: { include: { options: true } } },
      orderBy: { order: 'asc' },
      skip: (p - 1) * take,
      take,
    });

    const totalQuestions = await this.prisma.examQuestion.count({ where: { examId } });

    const attempts = await this.prisma.examAttempt.findMany({
      where: { examId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);

    const answers = attemptIds.length > 0
      ? await this.prisma.answer.findMany({
          where: { attemptId: { in: attemptIds } },
        })
      : [];

    const answerMapByQuestion = new Map<string, Array<unknown>>();
    for (const a of answers) {
      if (!answerMapByQuestion.has(a.questionId)) {
        answerMapByQuestion.set(a.questionId, []);
      }
      answerMapByQuestion.get(a.questionId)!.push(a.value);
    }

    const items = examQuestions.map((eq) => {
      const q = eq.question;
      const qAnswers = answerMapByQuestion.get(q.id) ?? [];
      let correct = 0;
      let incorrect = 0;

      const gradable = {
        id: q.id,
        type: q.type,
        marks: eq.marksOverride ?? q.marks,
        negativeMarks: q.negativeMarks,
        options: q.options.map((o) => ({ id: o.id, isCorrect: o.isCorrect, text: o.text })),
        metadata: (q.metadata as { tolerance?: number } | null) ?? undefined,
      };

      for (const val of qAnswers) {
        const res = gradeAnswer(gradable, val as never);
        if (res.correct) correct++;
        else incorrect++;
      }

      const totalResponses = qAnswers.length;
      const accuracy = totalResponses > 0 ? Math.round((correct / totalResponses) * 100) : 0;
      const unanswered = Math.max(0, attemptIds.length - totalResponses);

      return {
        questionId: q.id,
        text: q.text,
        type: q.type,
        marks: eq.marksOverride ?? q.marks,
        totalResponses,
        correctCount: correct,
        incorrectCount: incorrect,
        unansweredCount: unanswered,
        accuracyPercentage: accuracy,
      };
    });

    return {
      examId,
      questions: items,
      total: totalQuestions,
      page: p,
      limit: take,
    };
  }

  async studentReport(user: UserContext, studentId: string) {
    const orgId = user.orgId;
    const student = await this.prisma.student.findFirst({
      where: { id: studentId, ...(orgId && !user.isSuperAdmin ? { organizationId: orgId } : {}) },
      include: { user: true },
    });
    if (!student) throw new NotFoundException('Student not found');

    const attempts = await this.prisma.examAttempt.findMany({
      where: { studentId },
      include: { exam: { select: { id: true, name: true, passingScore: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const totalExamsTaken = attempts.length;
    const completedAttempts = attempts.filter((a) => a.scoreGraded && a.score !== null);
    const avgScore = completedAttempts.length > 0
      ? Math.round((completedAttempts.reduce((acc, a) => acc + (a.score ?? 0), 0) / completedAttempts.length) * 100) / 100
      : null;

    const passedExams = completedAttempts.filter((a) => (a.score ?? 0) >= a.exam.passingScore).length;

    return {
      studentId: student.id,
      studentCode: student.studentCode,
      name: `${student.user.firstName} ${student.user.lastName}`,
      email: student.user.email,
      totalExamsTaken,
      completedExams: completedAttempts.length,
      averageScore: avgScore,
      passedExams,
      passRate: completedAttempts.length > 0 ? Math.round((passedExams / completedAttempts.length) * 100) : 0,
      attempts: attempts.map((a) => ({
        attemptId: a.id,
        examId: a.exam.id,
        examName: a.exam.name,
        status: a.status,
        score: a.score,
        startedAt: a.startedAt?.toISOString() ?? null,
        submittedAt: a.submittedAt?.toISOString() ?? null,
      })),
    };
  }
}