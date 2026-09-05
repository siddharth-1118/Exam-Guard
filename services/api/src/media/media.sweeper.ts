/**
 * Media-participant stale-session sweeper (Phase 4D hardening).
 *
 * Server-side safety net that guarantees a crashed client (or an API restart
 * that lost in-memory gateway state) can never leave a CONNECTING/ACTIVE/
 * RECONNECTING MediaParticipant row behind:
 *
 *  - attempt reached a terminal state → participant ENDED (works even when the
 *    desktop app is gone and never sent a leave);
 *  - no live gateway presence for longer than the lease → walk the existing
 *    state machine (ACTIVE → RECONNECTING → DISCONNECTED; CONNECTING → FAILED).
 *
 * Every transition is a guarded `updateMany` (idempotent, concurrency-safe) and
 * produces an audit row. Presence comes from the gateway's in-process registry
 * — no PostgreSQL writes per heartbeat, no polling of connections per message.
 *
 * Single-node: one process runs the timer. A multi-node deployment needs a
 * distributed lock/leader election (documented in REALTIME_SCALABILITY_FINDINGS).
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { MediaParticipantStatus, Prisma } from '@examguard/database';
import { PrismaService } from '../prisma/prisma.service';
import { MediaGateway } from './media.gateway';
import { MediaPresenceService, resolvePresence } from './media.presence';
import { decideSweep, type SweepTargetState } from './sweep.decide';

const SWEEP_ACTIVE_STATES: MediaParticipantStatus[] = ['CONNECTING', 'ACTIVE', 'RECONNECTING'];
const TERMINAL_ATTEMPT_STATES = ['SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED'];
const DEFAULT_INTERVAL_MS = 20_000;
/** Lease: 2× the gateway's 45 s reconnect grace. */
const DEFAULT_LEASE_MS = 90_000;

interface SweeperStats {
  lastRunAt: number | null;
  scanned: number;
  ended: number;
  reconnecting: number;
  disconnected: number;
  failed: number;
  errors: number;
}

@Injectable()
export class MediaSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaSweeperService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly stats: SweeperStats = {
    lastRunAt: null,
    scanned: 0,
    ended: 0,
    reconnecting: 0,
    disconnected: 0,
    failed: 0,
    errors: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: MediaGateway,
    private readonly presence: MediaPresenceService,
  ) {
    this.intervalMs = Number(process.env.MEDIA_SWEEP_INTERVAL_MS ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
    this.leaseMs = Number(process.env.MEDIA_SWEEP_LEASE_MS ?? DEFAULT_LEASE_MS) || DEFAULT_LEASE_MS;
  }

  get config(): { intervalMs: number; leaseMs: number; enabled: boolean } {
    return {
      intervalMs: this.intervalMs,
      leaseMs: this.leaseMs,
      enabled: this.timer !== null,
    };
  }

  getStatus(): SweeperStats & { config: { intervalMs: number; leaseMs: number } } {
    return { ...this.stats, config: { intervalMs: this.intervalMs, leaseMs: this.leaseMs } };
  }

  onModuleInit(): void {
    if (process.env.MEDIA_SWEEPER_DISABLED === '1') return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.logger.log(
      `media sweeper enabled (interval=${this.intervalMs}ms lease=${this.leaseMs}ms)`,
    );
    // First pass shortly after boot so API restarts reconcile quickly.
    setTimeout(() => void this.sweep(), 2_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run one full sweep. Idempotent + guarded — safe to run on a timer. */
  async sweep(): Promise<SweeperStats> {
    if (this.running) return this.stats;
    this.running = true;
    const started = Date.now();
    try {
      const rows = await this.prisma.mediaParticipant.findMany({
        where: { status: { in: SWEEP_ACTIVE_STATES } },
        select: {
          id: true,
          attemptId: true,
          organizationId: true,
          status: true,
          lastSeenAt: true,
          updatedAt: true,
          createdAt: true,
          student: { select: { userId: true } },
        },
        take: 500,
      });
      this.stats.scanned = rows.length;

      // Preload attempt statuses (one query, no per-row polling).
      const attemptIds = Array.from(new Set(rows.map((r) => r.attemptId)));
      const attempts = await this.prisma.examAttempt.findMany({
        where: { id: { in: attemptIds } },
        select: { id: true, status: true },
      });
      const attemptBy = new Map(attempts.map((a) => [a.id, a.status]));

      for (const row of rows) {
        try {
          await this.evaluateRow(row, attemptBy.get(row.attemptId) ?? null);
        } catch (err) {
          this.stats.errors += 1;
          this.logger.warn(
            `media sweep row ${row.id.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      this.stats.lastRunAt = started;
      this.running = false;
    }
    return this.stats;
  }

  private async evaluateRow(
    row: {
      id: string;
      attemptId: string;
      organizationId: string;
      status: MediaParticipantStatus;
      lastSeenAt: Date | null;
      updatedAt: Date;
      createdAt: Date;
      student: { userId: string } | null;
    },
    attemptStatus: string | null,
  ): Promise<void> {
    if (attemptStatus === null || attemptStatus === 'CREATED' || attemptStatus === 'READY') {
      // Attempt row vanished or was never activatable — close the participant.
      await this.transition(
        row,
        { id: row.id, status: { in: SWEEP_ACTIVE_STATES } },
        { status: 'ENDED', endedAt: new Date() },
        'media.session.ended',
        { reason: 'attempt-unavailable', attemptStatus: attemptStatus ?? null },
      );
      await this.presence.removePresence(row.id, row.organizationId).catch(() => undefined);
      return;
    }
    // Local in-process registry + the Redis mirror (Phase 4D.2). Redis adds
    // cross-instance liveness: a fresh ACTIVE presence on ANY instance means
    // the participant is live somewhere, and an owner on another instance
    // means that instance owns the lifecycle — both prevent this instance
    // from sweeping the row. Redis-down → remote presence ignored entirely
    // (single-node behaviour, fail-safe).
    const local = this.gateway.presenceOf(row.id);
    const remote = await this.presence.getPresence(row.id, row.organizationId).catch(() => null);
    const merged = resolvePresence({
      local,
      remote,
      rowLastSeenAt: row.lastSeenAt?.getTime() ?? null,
      rowUpdatedAt: row.updatedAt.getTime(),
      instanceId: this.presence.instanceId,
    });
    if (merged.ownerIsOther) return; // another instance owns this participant
    const lastSeen = merged.lastSeenAt;
    const decision = decideSweep({
      state: row.status as SweepTargetState,
      attemptTerminal: TERMINAL_ATTEMPT_STATES.includes(attemptStatus),
      live: merged.live,
      lastSeenAt: lastSeen,
      now: Date.now(),
      leaseMs: this.leaseMs,
    });
    switch (decision.action) {
      case 'end':
        await this.transition(
          row,
          { id: row.id, status: { in: SWEEP_ACTIVE_STATES } },
          { status: 'ENDED', endedAt: new Date() },
          'media.session.ended',
          { reason: decision.reason, sweeper: true },
        );
        await this.presence.removePresence(row.id, row.organizationId).catch(() => undefined);
        break;
      case 'reconnecting':
        await this.transition(
          row,
          { id: row.id, status: 'ACTIVE' },
          { status: 'RECONNECTING', lastSeenAt: new Date() },
          'media.session.reconnecting',
          { reason: decision.reason, sweeper: true },
        );
        break;
      case 'disconnected':
        await this.transition(
          row,
          { id: row.id, status: 'RECONNECTING' },
          { status: 'DISCONNECTED', lastSeenAt: new Date() },
          'media.session.disconnected',
          { reason: decision.reason, sweeper: true },
        );
        break;
      case 'failed':
        await this.transition(
          row,
          { id: row.id, status: 'CONNECTING' },
          { status: 'FAILED', lastSeenAt: new Date(), endedAt: new Date() },
          'media.session.failed',
          { reason: decision.reason, sweeper: true },
        );
        await this.presence.removePresence(row.id, row.organizationId).catch(() => undefined);
        break;
      default:
        break;
    }
  }

  /** Guarded transition — the WHERE re-checks state so two sweepers cannot race. */
  private async transition(
    row: { id: string; attemptId: string; organizationId: string; status: MediaParticipantStatus },
    where: Prisma.MediaParticipantWhereInput,
    data: Prisma.MediaParticipantUpdateManyMutationInput,
    action: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.prisma.mediaParticipant.updateMany({ where, data });
    if (result.count === 0) return; // a concurrent path already transitioned — no double audit
    if (action === 'media.session.ended') this.stats.ended += 1;
    else if (action === 'media.session.reconnecting') this.stats.reconnecting += 1;
    else if (action === 'media.session.disconnected') this.stats.disconnected += 1;
    else if (action === 'media.session.failed') this.stats.failed += 1;
    await this.prisma.auditLog.create({
      data: {
        organizationId: row.organizationId,
        action,
        resourceType: 'ExamAttempt',
        resourceId: row.attemptId,
        detail: { ...detail, participantId: row.id, state: row.status },
      },
    });
    this.logger.log(
      `media sweeper ${action} participant=${row.id.slice(0, 8)} attempt=${row.attemptId.slice(0, 8)}`,
    );
  }
}
