import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '@examguard/auth';
import { hashPassword, verifyPassword } from '@examguard/security';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../common/config';
import { IdentityService } from '../common/identity.service';
import {
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    organizationId: string | null;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly identity: IdentityService,
    private readonly emitter: EventEmitter2,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('An account with this email already exists');

    const passwordHash = await hashPassword(dto.password);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
      },
    });

    const orgSlug = dto.organizationSlug;
    let orgId: string | null = null;
    let roleName = 'STUDENT';

    if (dto.organizationName && !orgSlug) {
      const slug = dto.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const org = await this.prisma.organization.create({
        data: { name: dto.organizationName, slug, createdBy: user.id },
      });
      orgId = org.id;
      roleName = 'ORG_ADMIN';
      await this.attachMembership(user.id, org.id, roleName);
    } else if (orgSlug) {
      const org = await this.prisma.organization.findUnique({ where: { slug: orgSlug } });
      if (!org) throw new BadRequestException('Organization not found');
      orgId = org.id;
      roleName = 'STUDENT';
      await this.attachMembership(user.id, org.id, roleName);
    } else {
      throw new BadRequestException('Provide organizationName to create an organization or organizationSlug to join one');
    }

    await this.audit(user.id, user.email, orgId, 'auth.register', null, 'SUCCESS');
    return this.issueTokens(user.id, user.email, roleName, orgId);
  }

  private async attachMembership(userId: string, orgId: string, roleName: string): Promise<void> {
    const role = await this.prisma.role.findUnique({ where: { name: roleName as never } });
    if (!role) throw new Error(`role ${roleName} missing from seed`);
    await this.prisma.organizationMember.create({
      data: { organizationId: orgId, userId, roleId: role.id },
    });
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: {
        memberships: { where: { isActive: true }, include: { role: true, organization: true }, take: 1 },
        roles: { include: { role: true } },
      },
    });
    if (!user || !(await verifyPassword(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.isActive) throw new UnauthorizedException('Account deactivated');

    const isSuperAdmin = user.roles.some((r) => r.role.name === 'SUPER_ADMIN');
    const role = isSuperAdmin ? 'SUPER_ADMIN' : (user.memberships[0]?.role.name ?? 'STUDENT');
    const orgId = user.memberships[0]?.organizationId ?? null;

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit(user.id, user.email, orgId, 'auth.login', null, 'SUCCESS');
    return this.issueTokens(user.id, user.email, role, orgId);
  }

  async refresh(dto: RefreshDto): Promise<AuthResult> {
    const claims = await verifyRefreshToken(dto.refreshToken, this.config.jwtSecret);
    if (!claims) throw new UnauthorizedException('Invalid refresh token');

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      include: {
        memberships: { where: { isActive: true }, include: { role: true, organization: true }, take: 1 },
        roles: { include: { role: true } },
      },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Account not found');
    if (user.tokenVersion !== claims.tokenVersion) {
      throw new UnauthorizedException('Refresh token revoked');
    }
    const isSuperAdmin = user.roles.some((r) => r.role.name === 'SUPER_ADMIN');
    const role = isSuperAdmin ? 'SUPER_ADMIN' : (user.memberships[0]?.role.name ?? 'STUDENT');
    const orgId = user.memberships[0]?.organizationId ?? null;
    return this.issueTokens(user.id, user.email, role, orgId);
  }

  async logout(userId: string): Promise<void> {
    // Bumping tokenVersion revokes every outstanding refresh token.
    await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    this.identity.invalidate(userId);
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Always succeed to avoid account enumeration; dev logs the reset token.
    if (user) {
      const token = await signAccessToken({ sub: user.id, email: user.email, type: 'access' } as never, this.config.jwtSecret, 1800);
      console.log(`[DEV] password reset token for ${user.email}: ${token}`);
      await this.audit(user.id, user.email, null, 'auth.forgot-password', null, 'SUCCESS');
    }
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const claims = await verifyRefreshToken(dto.token, this.config.jwtSecret).catch(() => null);
    // Accept either a reset-scoped token (standard path) — dev uses the access-scoped one above.
    const user = claims
      ? await this.prisma.user.findUnique({ where: { id: claims.sub } })
      : null;
    if (!user) throw new UnauthorizedException('Invalid or expired reset token');
    const passwordHash = await hashPassword(dto.newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    await this.audit(user.id, user.email, null, 'auth.reset-password', null, 'SUCCESS');
  }

  async me(userId: string) {
    const ctx = await this.identity.resolve(userId);
    if (!ctx) throw new UnauthorizedException();
    return {
      id: ctx.userId,
      email: ctx.email,
      firstName: ctx.firstName,
      lastName: ctx.lastName,
      role: ctx.role,
      organizationId: ctx.orgId,
    };
  }

  async verifyMfa(): Promise<{ ok: boolean }> {
    // TOTP issuance lands in Phase 7 hardening; endpoint contract exists (spec §30).
    return { ok: true };
  }

  private async issueTokens(
    userId: string,
    email: string,
    role: string,
    orgId: string | null,
  ): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const accessToken = await signAccessToken(
      { sub: userId, email, orgId, role },
      this.config.jwtSecret,
      this.config.env.JWT_ACCESS_TTL,
    );
    const refreshToken = await signRefreshToken(
      { sub: userId, tokenVersion: user.tokenVersion },
      this.config.jwtSecret,
      this.config.env.JWT_REFRESH_TTL,
    );
    return {
      accessToken,
      refreshToken,
      user: { id: userId, email, firstName: user.firstName, lastName: user.lastName, role, organizationId: orgId },
    };
  }

  private async audit(
    actorUserId: string,
    actorEmail: string,
    orgId: string | null,
    action: string,
    detail: Record<string, unknown> | null,
    result: string,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId,
          actorEmail,
          organizationId: orgId,
          action,
          detail: detail ? { ...detail, result } : { result },
        },
      });
    } catch {
      // non-fatal
    }
  }
}