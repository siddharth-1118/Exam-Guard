import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExamsService } from '../exams/exams.service';
import { AttemptsService } from '../attempts/attempts.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventBus } from '../common/event-bus';
import { RecordingsService } from '../recordings/recordings.service';
import type { UserContext } from '../common/types';

describe('Checkpoint 69.1 — IDOR & Multi-Tenant Cross-Access Prevention', () => {
  let examsService: ExamsService;
  let attemptsService: AttemptsService;
  let monitoringService: MonitoringService;

  let prisma: {
    exam: { findFirst: jest.Mock; findUnique: jest.Mock };
    student: { findFirst: jest.Mock; findUnique: jest.Mock };
    examAssignment: { findUnique: jest.Mock };
    examAttempt: { findFirst: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
    examMonitorAssignment: { findFirst: jest.Mock };
  };

  const userOrgA: UserContext = {
    userId: 'user-org-a',
    email: 'admin@orga.com',
    orgId: 'org-a',
    role: 'ORG_ADMIN',
    firstName: 'Alice',
    lastName: 'Admin',
    isSuperAdmin: false,
    permissions: ['exam:read', 'exam:update', 'proctor:intervene'],
  };

  const studentA: UserContext = {
    userId: 'user-student-a',
    email: 'studentA@orga.com',
    orgId: 'org-a',
    role: 'STUDENT',
    firstName: 'Student',
    lastName: 'A',
    isSuperAdmin: false,
    permissions: ['attempt:read', 'attempt:submit'],
  };

  const monitorUnassigned: UserContext = {
    userId: 'user-monitor-other',
    email: 'monitor@orgb.com',
    orgId: 'org-b',
    role: 'MONITOR',
    firstName: 'Monitor',
    lastName: 'Other',
    isSuperAdmin: false,
    permissions: ['proctor:monitor', 'proctor:intervene'],
  };

  beforeEach(async () => {
    prisma = {
      exam: { findFirst: jest.fn(), findUnique: jest.fn() },
      student: { findFirst: jest.fn(), findUnique: jest.fn() },
      examAssignment: { findUnique: jest.fn() },
      examAttempt: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
      examMonitorAssignment: { findFirst: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExamsService,
        AttemptsService,
        MonitoringService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventBus, useValue: { emit: jest.fn(), emitStudentPaused: jest.fn() } },
        { provide: RecordingsService, useValue: { startRecording: jest.fn() } },
      ],
    }).compile();

    examsService = module.get<ExamsService>(ExamsService);
    attemptsService = module.get<AttemptsService>(AttemptsService);
    monitoringService = module.get<MonitoringService>(MonitoringService);
  });

  it('rejects cross-organization exam access (Org A accessing Org B exam)', async () => {
    prisma.exam.findFirst.mockResolvedValue(null);
    await expect(examsService.findOne(userOrgA, 'exam-org-b')).rejects.toThrow(NotFoundException);
  });

  it('rejects student A attempting to read student B attempt', async () => {
    prisma.examAttempt.findUnique.mockResolvedValue({
      id: 'attempt-b',
      studentId: 'student-b-id',
      organizationId: 'org-a',
    });
    prisma.student.findFirst.mockResolvedValue({
      id: 'student-a-id',
      userId: 'user-student-a',
      organizationId: 'org-a',
    });

    await expect(attemptsService.getAttempt(studentA, 'attempt-b')).rejects.toThrow(ForbiddenException);
  });

  it('rejects unassigned monitor from intervening or pausing an attempt', async () => {
    prisma.student.findFirst.mockResolvedValue({ id: 'student-a-id', organizationId: 'org-b' });
    prisma.examAttempt.findFirst.mockResolvedValue({ id: 'att-1', examId: 'exam-1', organizationId: 'org-a' });
    prisma.examMonitorAssignment.findFirst.mockResolvedValue(null);

    await expect(monitoringService.pause(monitorUnassigned, 'student-a-id', { durationSeconds: 30, reason: 'test' }))
      .rejects.toThrow(ForbiddenException);
  });
});
