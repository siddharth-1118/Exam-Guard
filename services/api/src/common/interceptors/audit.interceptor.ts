import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import type { UserContext } from '../types';

/**
 * Records every mutating API call into audit_logs (append-only).
 * Sensitive flows (login, pause, terminate, submit…) write additional
 * structured rows with reasons in their services.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { user?: UserContext }>();
    const method: string = request.method ?? 'GET';
    if (['GET', 'OPTIONS', 'HEAD'].includes(method)) {
      return next.handle();
    }

    const user = request.user;
    const action = `${method} ${request.route?.path ?? request.url}`;
    const detail = this.safeDetail(request.body);

    return next.handle().pipe(
      tap({
        next: () => this.write(user, action, request, detail, 'SUCCESS'),
        error: () => this.write(user, action, request, detail, 'FAILED'),
      }),
    );
  }

  private safeDetail(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object') return {};
    try {
      const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
      for (const key of Object.keys(clone)) {
        if (/password|token|secret/i.test(key)) clone[key] = '[REDACTED]';
      }
      return clone;
    } catch {
      return {};
    }
  }

  private async write(
    user: UserContext | undefined,
    action: string,
    request: Request,
    detail: Record<string, unknown>,
    result: 'SUCCESS' | 'FAILED',
  ): Promise<void> {
    try {
      const params = request.params as Record<string, string> | undefined;
      await this.prisma.auditLog.create({
        data: {
          organizationId: user?.orgId ?? null,
          actorUserId: user?.userId ?? null,
          actorEmail: user?.email ?? null,
          action,
          resourceType: String(params?.['resourceType'] ?? request.route?.path ?? null),
          detail: { ...detail, result },
          ip: String(request.ip ?? null),
          userAgent: String(request.headers?.['user-agent'] ?? null),
        },
      });
    } catch (err) {
      // Audit must never break the request; log and continue.
      console.error('audit write failed', err);
    }
  }
}