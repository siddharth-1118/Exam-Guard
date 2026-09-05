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
    return this.prisma.$transaction(async (tx) => {
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
  }

  async update(user: UserContext, studentId: string, data: { isActive?: boolean }) {
    const student = await this.prisma.student.findFirst({
      where: { id: studentId, organizationId: user.orgId! },
    });
    if (!student) throw new NotFoundException('Student not found');
    return this.prisma.student.update({
      where: { id: studentId },
      data: { isActive: data.isActive },
    });
  }
}