import { Injectable } from '@nestjs/common';
import { permissionsForRole } from '@examguard/security';
import { PrismaService } from '../prisma/prisma.service';
import type { UserContext } from './types';

/**
 * Resolves a userId into a full authorization context (role, org, permissions).
 * Results are cached in-process for CACHE_TTL_MS; role/permission changes take
 * effect after the TTL or on restart (documented in docs/SECURITY.md).
 */
@Injectable()
export class IdentityService {
  private static readonly CACHE_TTL_MS = 30_000;
  private readonly cache = new Map<string, { at: number; ctx: UserContext }>();

  constructor(private readonly prisma: PrismaService) {}

  async resolve(userId: string): Promise<UserContext | null> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.at < IdentityService.CACHE_TTL_MS) {
      return cached.ctx;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: { include: { role: true } },
        memberships: {
          where: { isActive: true },
          include: { role: true, organization: true },
          take: 1,
        },
      },
    });
    if (!user || !user.isActive) {
      this.cache.delete(userId);
      return null;
    }

    const isSuperAdmin = user.roles.some((ur) => ur.role.name === 'SUPER_ADMIN');
    const membership = user.memberships[0] ?? null;

    const ctx: UserContext = {
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: isSuperAdmin ? 'SUPER_ADMIN' : (membership?.role.name ?? 'STUDENT'),
      orgId: membership?.organizationId ?? null,
      permissions: await this.loadPermissions(isSuperAdmin ? 'SUPER_ADMIN' : membership?.role.name ?? 'STUDENT'),
      isSuperAdmin,
    };
    this.cache.set(userId, { at: Date.now(), ctx });
    return ctx;
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  private async loadPermissions(roleName: string): Promise<string[]> {
    // DB-backed role→permission resolution (roles are seeded; cache forever in-process).
    try {
      const role = await this.prisma.role.findUnique({
        where: { name: roleName as never },
        include: { permissions: { include: { permission: true } } },
      });
      if (role) {
        return role.permissions.map((rp) => rp.permission.name);
      }
    } catch {
      // fall through to compile-time map if DB is unavailable
    }
    return permissionsForRole(roleName as never);
  }
}