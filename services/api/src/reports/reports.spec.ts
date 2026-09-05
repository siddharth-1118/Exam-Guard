import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UserContext } from '../common/types';

describe('Checkpoint 13 — Reports & Analytics', () => {
  let service: ReportsService;
  let prisma: {
    student: { count: jest.Mock; findFirst: jest.Mock };
    exam: { count: jest.Mock; findFirst: jest.Mock };
    examAttempt: { count: jest.Mock; aggregate: jest.Mock; findMany: jest.Mock };
    monitor: { count: jest.Mock };
    aiEvent: { count: jest.Mock };
    examQuestion: { findMany: jest.Mock; count: jest.Mock };
    answer: { findMany: jest.Mock };
  };

  const user: UserContext = {
    userId: 'user-1',
    email: 'admin@example.com',
    orgId: 'org-1',
    role: 'ORG_ADMIN',
    firstName: 'Admin',
    lastName: 'User',
    isSuperAdmin: false,
    permissions: ['report:read'],
  };

  beforeEach(async () => {
    prisma = {
      student: { count: jest.fn().mockResolvedValue(10), findFirst: jest.fn() },
      exam: { count: jest.fn().mockResolvedValue(5), findFirst: jest.fn() },
      examAttempt: {
        count: jest.fn().mockResolvedValue(20),
        aggregate: jest.fn().mockResolvedValue({ _avg: { score: 75.5 }, _min: { score: 40 }, _max: { score: 98 }, _count: 15 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      monitor: { count: jest.fn().mockResolvedValue(2) },
      aiEvent: { count: jest.fn().mockResolvedValue(0) },
      examQuestion: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      answer: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
  });

  it('generates admin dashboard report with tenant filter', async () => {
    const result = await service.dashboard(user);
    expect(result.totalStudents).toBe(10);
    expect(result.averageScore).toBe(75.5);
    expect(prisma.student.count).toHaveBeenCalledWith({ where: { organizationId: 'org-1' } });
  });

  it('generates exam report with score metrics and pass count', async () => {
    prisma.exam.findFirst.mockResolvedValue({
      id: 'exam-1',
      name: 'Midterm Math',
      passingScore: 50,
      organizationId: 'org-1',
    });

    const report = await service.examReport(user, 'exam-1');
    expect(report.examId).toBe('exam-1');
    expect(report.passingScore).toBe(50);
    expect(report.totalAttempts).toBe(20);
    expect(report.averageScore).toBe(75.5);
  });

  it('throws NotFoundException if exam is not found or in different organization', async () => {
    prisma.exam.findFirst.mockResolvedValue(null);
    await expect(service.examReport(user, 'exam-other')).rejects.toThrow(NotFoundException);
  });

  it('generates student report with attempt history and average score', async () => {
    prisma.student.findFirst.mockResolvedValue({
      id: 'student-1',
      studentCode: 'STU-001',
      user: { firstName: 'John', lastName: 'Doe', email: 'john@example.com' },
    });
    prisma.examAttempt.findMany.mockResolvedValue([
      {
        id: 'att-1',
        score: 80,
        scoreGraded: true,
        status: 'SUBMITTED',
        startedAt: new Date(),
        submittedAt: new Date(),
        exam: { id: 'exam-1', name: 'Math', passingScore: 50 },
      },
    ]);

    const report = await service.studentReport(user, 'student-1');
    expect(report.studentId).toBe('student-1');
    expect(report.name).toBe('John Doe');
    expect(report.totalExamsTaken).toBe(1);
    expect(report.averageScore).toBe(80);
    expect(report.passRate).toBe(100);
  });
});
