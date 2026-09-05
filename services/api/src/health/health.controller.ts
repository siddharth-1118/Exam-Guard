import { Controller, Get, Optional, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators';
import type { MediaPresenceService } from '../media/media.presence';

/**
 * Health endpoints (C23 Observability).
 *
 * GET /health — liveness probe (process alive). Always 200 if the process
 * is running, regardless of dependency state.
 *
 * GET /ready — readiness probe. Checks:
 *  - PostgreSQL (required: process fails if DB is down)
 *  - Redis (optional: degraded if Redis is down, but not a hard failure)
 *
 * GET /ready/detailed — full dependency status for operators.
 * Never exposes secrets, connection strings, or student data.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly presence?: MediaPresenceService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  async ready() {
    const checks: Record<string, string> = {};

    // PostgreSQL — required for the API to function.
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }

    // Redis — uses cached health status (updated by connection events).
    // This is intentional: /ready must be fast for load balancers (<100ms).
    // Active Redis probing happens only in /ready/detailed for operators.
    if (this.presence) {
      checks.redis = this.presence.isHealthy ? 'up' : 'degraded';
    } else {
      checks.redis = 'unconfigured';
    }

    // Database is the only hard requirement. Redis degradation is acceptable.
    if (checks.database !== 'up') {
      throw new ServiceUnavailableException({ status: 'degraded', checks });
    }
    return { status: 'ok', checks };
  }

  /**
   * Detailed dependency status for operators. Returns the full picture
   * without exposing secrets. Content-type: application/json.
   */
  @Public()
  @Get('ready/detailed')
  async readyDetailed() {
    const checks: Record<string, { status: string; latencyMs?: number }> = {};

    // PostgreSQL latency.
    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'up', latencyMs: Date.now() - dbStart };
    } catch {
      checks.database = { status: 'down', latencyMs: Date.now() - dbStart };
    }

    // Redis — active probe with latency measurement.
    if (this.presence) {
      const probe = await Promise.race([
        this.presence.ping(),
        new Promise<null>((r) => setTimeout(() => r(null), 2_000)),
      ]);
      if (probe) {
        checks.redis = { status: 'up', latencyMs: probe.latencyMs };
      } else {
        // Probe timed out or failed — fall back to cached health status.
        const status = this.presence.status();
        checks.redis = {
          status: status.healthy ? 'up' : 'degraded',
        };
      }
    } else {
      checks.redis = { status: 'unconfigured' };
    }

    const dbDown = checks.database.status !== 'up';
    return {
      status: dbDown ? 'degraded' : 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}