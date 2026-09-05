import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UserContext } from '../common/types';

describe('Checkpoint 15 & 16 — Audit Trail & Multi-Tenancy Scoping', () => {
  let auditService: AuditService;
  let prisma: {
    auditLog: { findMany: jest.Mock; count: jest.Mock };
  };

  const userOrgA: UserContext = {
    userId: 'user-a',
    email: 'admin@org-a.com',
    orgId: 'org-a',
    role: 'ORG_ADMIN',
    firstName: 'Alice',
    lastName: 'Admin',
    isSuperAdmin: false,
    permissions: ['audit:read'],
  };

  beforeEach(async () => {
    prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    auditService = module.get<AuditService>(AuditService);
  });

  it('enforces organizationId filter when querying audit logs', async () => {
    await auditService.list(userOrgA, { page: 1, pageSize: 20 });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
        }),
      }),
    );
  });
});
