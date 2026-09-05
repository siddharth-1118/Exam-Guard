import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { hashPassword } from '@examguard/security';
import { PrismaService } from '../prisma/prisma.service';
import type { UserContext } from '../common/types';
import { CreateStudentDto } from './dto';

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: UserContext) {
    const students = await this.prisma.student.findMany({
      where: { organizationId: user.orgId! },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return students.map((s) => ({
      id: s.id,
      studentCode: s.studentCode,
      isActive: s.isActive,
      email: s.user.email,
      firstName: s.user.firstName,
      lastName: s.user.lastName,
    }));
  }

  async create(user: UserContext, dto: CreateStudentDto) {
    const orgId = user.orgId;
    if (!orgId) throw new BadRequestException('Organization required');
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('A user with this email already exists');
    const codeExists = await this.prisma.student.findUnique({
      where: { organizationId_studentCode: { organizationId: orgId, studentCode: dto.studentCode } },
    });
    if (codeExists) throw new ConflictException('Student code already used');

    const passwordHash = await hashPassword(dto.password);
    const result = await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { name: 'STUDENT' } });
      if (!role) throw new Error('STUDENT role missing from seed');
      const createdUser = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
        },
      });
      await tx.organizationMember.create({
        data: { organizationId: orgId, userId: createdUser.id, roleId: role.id },
      });
      const profile = await tx.student.create({
        data: {
          organizationId: orgId,
          userId: createdUser.id,
          studentCode: dto.studentCode,
        },
      });
      return {
        id: profile.id,
        studentCode: profile.studentCode,
        email: createdUser.email,
        firstName: createdUser.firstName,
        lastName: createdUser.lastName,
      };
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: orgId,
        actorUserId: user.userId,
        actorEmail: user.email,
        action: 'student.created',
        resourceType: 'Student',
        resourceId: result.id,
        detail: { email: result.email, studentCode: result.studentCode },
      },
    });

    return result;
  }

  async bulkImport(user: UserContext, dtos: CreateStudentDto[]) {
    const orgId = user.orgId;
    if (!orgId) throw new BadRequestException('Organization required');

    let createdCount = 0;
    const errors: string[] = [];

    for (const dto of dtos) {
      try {
        await this.create(user, dto);
        createdCount++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Student ${dto.studentCode} (${dto.email}): ${msg}`);
      }
    }

    await this.prisma.auditLog.create({
      data: {
        organizationId: orgId,
        actorUserId: user.userId,
        actorEmail: user.email,
        action: 'students.bulk-import',
        resourceType: 'Organization',
        resourceId: orgId,
        detail: { total: dtos.length, createdCount, errorCount: errors.length },
      },
    });

    return { total: dtos.length, createdCount, errors };
  }

  async update(user: UserContext, studentId: string, data: { isActive?: boolean }) {
    const student = await this.prisma.student.findFirst({
      where: { id: studentId, organizationId: user.orgId! },
    });
    if (!student) throw new NotFoundException('Student not found');
    const updated = await this.prisma.student.update({
      where: { id: studentId },
      data: { isActive: data.isActive },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.orgId!,
        actorUserId: user.userId,
        actorEmail: user.email,
        action: 'student.updated',
        resourceType: 'Student',
        resourceId: studentId,
        detail: { isActive: data.isActive },
      },
    });

    return updated;
  }
}