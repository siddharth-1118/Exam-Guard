import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { hashPassword } from '@examguard/security';
import { PrismaService } from '../prisma/prisma.service';
import type { UserContext } from '../common/types';
import { CreateMonitorDto } from './dto';

@Injectable()
export class MonitorsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: UserContext) {
    const monitors = await this.prisma.monitor.findMany({
      where: { organizationId: user.orgId! },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return monitors.map((m) => ({
      id: m.id,
      isActive: m.isActive,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
    }));
  }

  async create(user: UserContext, dto: CreateMonitorDto) {
    const orgId = user.orgId;
    if (!orgId) throw new BadRequestException('Organization required');
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('A user with this email already exists');

    const passwordHash = await hashPassword(dto.password);
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { name: 'MONITOR' } });
      if (!role) throw new Error('MONITOR role missing from seed');
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
      const profile = await tx.monitor.create({
        data: { organizationId: orgId, userId: createdUser.id },
      });
      return { id: profile.id, email: createdUser.email, firstName: createdUser.firstName, lastName: createdUser.lastName };
    });
  }
}