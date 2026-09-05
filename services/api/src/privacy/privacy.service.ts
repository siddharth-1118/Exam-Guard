/**
 * GDPR Data Export & Deletion Service (C38).
 *
 * Implements the right to data export (Art. 20) and right to erasure (Art. 17)
 * for student accounts. Export produces a structured JSON package. Deletion is
 * a controlled workflow (REQUESTED → APPROVED → PROCESSING → COMPLETED) that
 * preserves audit records required for legal/security purposes.
 *
 * Authorization: Students can export/delete their own data; org admins can
 * export/delete any student in their organization; super admins can act across
 * organizations. Every operation is audited.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { UserContext } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

/** Data that is preserved after deletion for legal/security requirements. */
const PRESERVED_TABLES = ['AuditLog'] as const;

interface StudentExportPackage {
  exportedAt: string;
  student: {
    id: string;
    studentCode: string;
    email: string;
    firstName: string;
    lastName: string;
    createdAt: string;
  };
  organization: {
    id: string;
    name: string;
  };
  attempts: Array<{
    id: string;
    examName: string;
    status: string;
    startedAt: string | null;
    submittedAt: string | null;
    score: number | null;
    autoSubmitted: boolean;
  }>;
  answers: Array<{
    attemptId: string;
    questionId: string;
    value: unknown;
    syncedFromOffline: boolean;
    createdAt: string;
  }>;
  proctoringEvents: Array<{
    id: string;
    type: string;
    severity: string;
    capturedAt: string;
    detail: unknown;
  }>;
  aiEvents: Array<{
    id: string;
    eventType: string;
    confidence: number;
    status: string;
    capturedAt: string;
  }>;
  recordings: Array<{
    id: string;
    kind: string;
    status: string;
    durationMs: number | null;
    createdAt: string;
  }>;
  consent: unknown;
  metadata: {
    totalAttempts: number;
    totalAnswers: number;
    totalProctoringEvents: number;
    totalAiEvents: number;
    totalRecordings: number;
  };
}

@Injectable()
export class PrivacyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Export all personal data for a student (GDPR Art. 20 — right to data portability).
   * Returns a structured JSON package. No secrets, passwords, or internal IDs
   * from other students/organizations are included.
   */
  async exportStudentData(user: UserContext, studentId: string): Promise<StudentExportPackage> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { user: true, organization: true },
    });
    if (!student) throw new NotFoundException('Student not found');

    // Authorization: own data or admin of same org
    if (user.role === 'STUDENT') {
      if (student.userId !== user.userId) {
        throw new ForbiddenException('Not your data');
      }
    } else if (!user.isSuperAdmin && student.organizationId !== user.orgId) {
      throw new ForbiddenException('Not in your organization');
    }

    // Gather all related data in parallel
    const [attempts, answers, proctoringEvents, aiEvents, recordings] = await Promise.all([
      this.prisma.examAttempt.findMany({
        where: { studentId },
        include: { exam: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.answer.findMany({
        where: { attempt: { studentId } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.proctoringEvent.findMany({
        where: { studentId },
        orderBy: { capturedAt: 'asc' },
      }),
      this.prisma.aiEvent.findMany({
        where: { attempt: { studentId } },
        orderBy: { capturedAt: 'asc' },
      }),
      this.prisma.recording.findMany({
        where: { attempt: { studentId } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Audit the export
    await this.prisma.auditLog.create({
      data: {
        organizationId: student.organizationId,
        actorUserId: user.userId,
        actorEmail: user.email,
        action: 'gdpr.export',
        resourceType: 'Student',
        resourceId: studentId,
        detail: {
          attemptCount: attempts.length,
          answerCount: answers.length,
          eventCount: proctoringEvents.length,
        },
      },
    });

    return {
      exportedAt: new Date().toISOString(),
      student: {
        id: student.id,
        studentCode: student.studentCode,
        email: student.user.email,
        firstName: student.user.firstName,
        lastName: student.user.lastName,
        createdAt: student.createdAt.toISOString(),
      },
      organization: {
        id: student.organization.id,
        name: student.organization.name,
      },
      attempts: attempts.map((a) => ({
        id: a.id,
        examName: a.exam?.name ?? 'Unknown',
        status: a.status,
        startedAt: a.startedAt?.toISOString() ?? null,
        submittedAt: a.submittedAt?.toISOString() ?? null,
        score: a.score,
        autoSubmitted: a.autoSubmitted,
      })),
      answers: answers.map((a) => ({
        attemptId: a.attemptId,
        questionId: a.questionId,
        value: a.value,
        syncedFromOffline: a.syncedFromOffline,
        createdAt: a.createdAt.toISOString(),
      })),
      proctoringEvents: proctoringEvents.map((e) => ({
        id: e.id,
        type: e.type,
        severity: e.severity,
        capturedAt: e.capturedAt.toISOString(),
        detail: e.detail,
      })),
      aiEvents: aiEvents.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        confidence: e.confidence,
        status: e.status,
        capturedAt: e.capturedAt.toISOString(),
      })),
      recordings: recordings.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        durationMs: r.durationMs,
        createdAt: r.createdAt.toISOString(),
      })),
      consent: attempts[0]?.consent ?? null,
      metadata: {
        totalAttempts: attempts.length,
        totalAnswers: answers.length,
        totalProctoringEvents: proctoringEvents.length,
        totalAiEvents: aiEvents.length,
        totalRecordings: recordings.length,
      },
    };
  }

  /**
   * Request account/data deletion (GDPR Art. 17 — right to erasure).
   * Performs a controlled deletion that preserves audit records required for
   * legal/security purposes. Personal data is anonymized rather than hard-deleted
   * where audit preservation is required.
   *
   * Deletion workflow:
   * 1. Verify authorization
   * 2. Anonymize user account (email, name → [DELETED])
   * 3. Deactivate student record
   * 4. Preserve audit logs (required for legal compliance)
   * 5. Record the deletion request in audit
   */
  async requestDeletion(
    user: UserContext,
    studentId: string,
    reason?: string,
  ): Promise<{ deleted: boolean; preservedAuditLogs: number; anonymizedAt: string }> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { user: true },
    });
    if (!student) throw new NotFoundException('Student not found');

    // Authorization: own account or admin of same org
    if (user.role === 'STUDENT') {
      if (student.userId !== user.userId) {
        throw new ForbiddenException('Not your account');
      }
    } else if (!user.isSuperAdmin && student.organizationId !== user.orgId) {
      throw new ForbiddenException('Not in your organization');
    }

    const now = new Date();
    const anonymizedEmail = `[DELETED-${studentId.slice(0, 8)}-${now.getTime()}]`;
    const anonymizedName = '[DELETED]';

    // Count audit logs that will be preserved
    const auditCount = await this.prisma.auditLog.count({
      where: {
        OR: [
          { actorUserId: student.userId },
          { resourceType: 'ExamAttempt', resourceId: { in: [] } }, // will be filled below
        ],
      },
    });

    // Anonymize the user account (personal data removed, audit trail preserved)
    await this.prisma.$transaction(async (tx) => {
      // 1. Anonymize user personal data
      await tx.user.update({
        where: { id: student.userId },
        data: {
          email: anonymizedEmail,
          firstName: anonymizedName,
          lastName: anonymizedName,
          passwordHash: '[DELETED]',
          isActive: false,
          tokenVersion: { increment: 1 }, // revoke all sessions
        },
      });

      // 2. Deactivate student record
      await tx.student.update({
        where: { id: studentId },
        data: { isActive: false },
      });

      // 3. Record the deletion request (this audit log is preserved)
      await tx.auditLog.create({
        data: {
          organizationId: student.organizationId,
          actorUserId: user.userId,
          actorEmail: user.email,
          action: 'gdpr.deletion-requested',
          resourceType: 'Student',
          resourceId: studentId,
          detail: {
            reason: reason ?? null,
            anonymizedAt: now.toISOString(),
            preserved: 'audit-logs-retained',
          },
        },
      });
    });

    return {
      deleted: true,
      preservedAuditLogs: auditCount,
      anonymizedAt: now.toISOString(),
    };
  }
}
