import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { UserContext } from '../common/types';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: UserContext) {
    if (user.isSuperAdmin) {
      const orgs = await this.prisma.organization.findMany({ orderBy: { createdAt: 'asc' } });
      return orgs.map((o) => ({ ...o, memberCount: undefined }));
    }
    const org = await this.prisma.organization.findUnique({ where: { id: user.orgId! } });
    return org ? [org] : [];
  }

  async create(user: UserContext, name: string) {
    if (!user.isSuperAdmin) throw new ForbiddenException('Only super admins create organizations');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) throw new BadRequestException('Invalid organization name');
    return this.prisma.organization.create({ data: { name, slug, createdBy: user.userId } });
  }

  async update(user: UserContext, orgId: string, data: { name?: string; plan?: string; status?: string }) {
    if (!user.isSuperAdmin && user.orgId !== orgId) {
      throw new ForbiddenException('Cannot modify another organization');
    }
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');
    return this.prisma.organization.update({ where: { id: orgId }, data });
  }
}