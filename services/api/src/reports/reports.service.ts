import { Injectable } from '@nestjs/common';
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
}