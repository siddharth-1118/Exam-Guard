import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Identity-Aware Throttler Guard (C72.3).
 * Separates authentication abuse (login/register per IP) from legitimate high-volume
 * exam traffic (heartbeat, save answer, proctoring events per authenticated user ID).
 * When multiple students share a single NAT IP / loopback address in load tests,
 * authenticated users are throttled per user ID rather than blocking each other.
 */
@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const user = req.user ?? req.raw?.user;
    if (user?.userId) {
      return `user:${user.userId}`;
    }
    if (user?.sub) {
      return `user:${user.sub}`;
    }
    return req.ip || req.connection?.remoteAddress || '127.0.0.1';
  }
}
