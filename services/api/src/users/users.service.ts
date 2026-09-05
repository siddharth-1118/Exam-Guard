import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { hashPassword } from '@examguard/security';
import { PrismaService } from '../prisma/prisma.service';
import type { UserContext } from '../common/types';
import { CreateUserDto, UpdateUserDto } from './dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: UserContext) {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId: user.orgId! },
      include: { user: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    return members.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      isActive: m.user.isActive,
      role: m.role.name,
      lastLoginAt: m.user.lastLoginAt,
    }));
  }

  async create(user: UserContext, dto: CreateUserDto) {
    const orgId = user.orgId;
    if (!orgId) throw new BadRequestException('Organization required');
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('User already exists');

    const passwordHash = await hashPassword(dto.password);
    const created = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
        },
      });
      const role = await tx.role.findUnique({ where: { name: dto.role } });
      if (!role) throw new BadRequestException(`Unknown role: ${dto.role}`);
      await tx.organizationMember.create({
        data: { organizationId: orgId, userId: newUser.id, roleId: role.id },
      });
      return newUser;
    });
    return { id: created.id, email: created.email, role: dto.role };
  }

  async update(user: UserContext, userId: string, dto: UpdateUserDto) {
    const membership = await this.prisma.organizationMember.findFirst({
      where: { organizationId: user.orgId!, userId },
      include: { user: true },
    });
    if (!membership) throw new NotFoundException('User not found in this organization');

    const data: Record<string, unknown> = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    let roleChanged = false;
    if (dto.role !== undefined && dto.role !== membership.roleId) {
      const role = await this.prisma.role.findUnique({ where: { name: dto.role } });
      if (!role) throw new BadRequestException(`Unknown role: ${dto.role}`);
      data.roleId = role.id;
      roleChanged = true;
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.user.update({ where: { id: userId }, data });
      }
      if (roleChanged) {
        await tx.organizationMember.update({
          where: { organizationId_userId: { organizationId: user.orgId!, userId } },
          data: { roleId: data.roleId as string },
        });
      }
    });
    return { id: userId, updated: true };
  }
}