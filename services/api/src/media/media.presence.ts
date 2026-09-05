/**
 * Redis ephemeral media presence + distributed ownership (Phase 4D.2).
 *
 * PostgreSQL (`MediaParticipant`) remains the durable source of truth; Redis
 * is ONLY an ephemeral coordination layer:
 *
 *   examguard:media:presence:{orgId}:{participantId}   HASH  (TTL'd)
 *   examguard:media:owner:{orgId}:{participantId}       STRING = instanceId (TTL'd lease)
 *
 * The prefix includes orgId so a leaked/cross-tenant participantId can never
 * collide or be read across organizations. Keys are built only from
 * server-side UUIDs — never from browser input. No media bytes, SDP, or large
 * payloads ever touch Redis.
 *
 * FAIL-SAFE: when Redis is unavailable every operation degrades to a safe
 * no-op/false and nothing throws into the hot path:
 *   - ownership reports "no owner" (identical to today's single-node behavior),
 *   - presence reads return null (the sweeper falls back to the in-process
 *     gateway registry + durable row timestamps),
 *   - the durable state machine is never mutated from Redis state alone.
 */
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { AppConfig } from '../common/config';

export type PresenceState =
  | 'CONNECTING'
  | 'ACTIVE'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'FAILED'
  | 'ENDED';

export interface PresenceInfo {
  participantId: string;
  mediaSessionId: string;
  attemptId: string;
  organizationId: string;
  connectionState: PresenceState;
  /** instanceId that currently owns / last wrote this presence. */
  instanceId: string;
  connectedAt: number;
  lastSeenAt: number;
}

export interface PresenceSnapshot extends PresenceInfo {
  ownerInstanceId: string | null;
  ttlMs: number | null;
}

export type AcquireResult = 'acquired' | 'already-owner' | 'owned-by-other' | 'unavailable';

/** Presence TTL: ~2× the client heartbeat (15 s) so normal jitter never expires it. */
const DEFAULT_PRESENCE_TTL_MS = 30_000;
/** Ownership lease: > the gateway's 45 s reconnect grace (grace must stay inside the lease). */
const DEFAULT_OWNER_LEASE_MS = 60_000;
/** RECONNECTING presence TTL: must outlive the 45 s grace so another instance's open grace is visible. */
const RECONNECT_TTL_MS = 60_000;
/** DISCONNECTED presence TTL: linger briefly so the sweeper sees the transition, then self-clean. */
const DISCONNECT_TTL_MS = 15_000;

const PRESENCE_SCRIPT = `
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return 0 end
for i = 2, #ARGV - 2, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
redis.call('PEXPIRE', KEYS[1], ARGV[#ARGV - 1])
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[#ARGV])
return 1
`;

const HEARTBEAT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return 2 end
redis.call('HSET', KEYS[1], 'lastSeenAt', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return 1
`;

const ACQUIRE_SCRIPT = `
local owner = redis.call('GET', KEYS[1])
if owner then
  if owner == ARGV[1] then return 2 end
  return 3
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

export interface ResolvePresenceInput {
  local: { live: boolean; lastSeenAt: number | null };
  remote: PresenceSnapshot | null;
  /** Fallback timestamps from the durable row (ms epoch). */
  rowLastSeenAt: number | null;
  rowUpdatedAt: number;
  /** This process's instanceId (remote ownership is only "other" when different). */
  instanceId: string;
}

export interface ResolvedPresence {
  live: boolean;
  lastSeenAt: number;
  /** Another API instance owns this participant's lease → this instance must not mutate it. */
  ownerIsOther: boolean;
}

/**
 * Pure presence composition for the stale-session sweeper: merges the local
 * in-process gateway registry with the Redis mirror. Rules:
 *  - a live local socket wins (local is authoritative for THIS instance);
 *  - a fresh remote ACTIVE presence (any instance) means the participant is
 *    live somewhere → never sweep;
 *  - a remote owner on another instance → leave the row alone entirely;
 *  - expired/absent/Redis-down presence is ignored (durable timestamps rule).
 */
export function resolvePresence(input: ResolvePresenceInput): ResolvedPresence {
  const remoteLive = input.remote !== null && input.remote.connectionState === 'ACTIVE';
  const ownerIsOther =
    input.remote !== null &&
    input.remote.ownerInstanceId !== null &&
    input.remote.ownerInstanceId !== input.instanceId;
  const lastSeenAt = Math.max(
    input.local.lastSeenAt ?? 0,
    input.remote?.lastSeenAt ?? 0,
    input.rowLastSeenAt ?? 0,
    input.rowUpdatedAt,
  );
  return {
    live: input.local.live || remoteLive,
    lastSeenAt,
    ownerIsOther,
  };
}

@Injectable()
export class MediaPresenceService implements OnModuleDestroy {
  readonly instanceId: string;
  private readonly logger = new Logger(MediaPresenceService.name);
  private readonly redis: Redis | null;
  private healthy = false;
  private lastWarnedAt = 0;
  private readonly presenceTtlMs: number;
  private readonly ownerLeaseMs: number;

  constructor(
    config: AppConfig,
    /** Injectable for tests: unique key namespace + explicit instanceId. */
    @Optional()
    options?: { namespace?: string; instanceId?: string; retryStrategy?: (times: number) => number | null },
  ) {
    this.instanceId = options?.instanceId ?? process.env.MEDIA_INSTANCE_ID ?? randomUUID();
    this.presenceTtlMs =
      Number(process.env.MEDIA_PRESENCE_TTL_MS ?? DEFAULT_PRESENCE_TTL_MS) || DEFAULT_PRESENCE_TTL_MS;
    this.ownerLeaseMs =
      Number(process.env.MEDIA_OWNER_LEASE_MS ?? DEFAULT_OWNER_LEASE_MS) || DEFAULT_OWNER_LEASE_MS;
    this.namespace = options?.namespace ?? 'examguard:media';
    try {
      this.redis = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false, // commands during an outage fail fast (fail-safe), never queue
        connectTimeout: 2_000,
        lazyConnect: false,
        // Reconnect with backoff so a Redis restart is recovered automatically;
        // individual commands still fail fast while disconnected.
        retryStrategy: options?.retryStrategy ?? ((times) => Math.min(times * 200, 2_000)),
      });
      this.redis.on('error', (err) => {
        this.healthy = false;
        const now = Date.now();
        if (now - this.lastWarnedAt > 30_000) {
          this.lastWarnedAt = now;
          this.logger.warn(`redis presence unavailable: ${err?.message ?? err}`);
        }
      });
      this.redis.on('connect', () => {
        this.healthy = true;
        this.logger.log(`redis presence connected (instance=${this.instanceId.slice(0, 8)})`);
      });
      this.redis.on('ready', () => {
        this.healthy = true;
      });
      this.redis.on('close', () => {
        this.healthy = false;
      });
    } catch (err) {
      this.redis = null;
      this.healthy = false;
      this.logger.warn(
        `redis presence disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private readonly namespace: string;

  private presenceKey(orgId: string, participantId: string): string {
    return `${this.namespace}:presence:${orgId}:${participantId}`;
  }

  private ownerKey(orgId: string, participantId: string): string {
    return `${this.namespace}:owner:${orgId}:${participantId}`;
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  status(): { enabled: boolean; healthy: boolean; instanceId: string; url: string; presenceTtlMs: number; ownerLeaseMs: number } {
    return {
      enabled: this.redis !== null,
      healthy: this.healthy,
      instanceId: this.instanceId,
      url: this.redis ? String(this.redis.options.host) + ':' + String(this.redis.options.port) : 'disabled',
      presenceTtlMs: this.presenceTtlMs,
      ownerLeaseMs: this.ownerLeaseMs,
    };
  }

  /**
   * Active Redis probe: issues a real PING and measures round-trip latency.
   * Returns the latency in ms, or null if Redis is unreachable. This is
   * intentionally NOT wrapped in `guarded()` — the caller needs to distinguish
   * "probe failed" from "probe succeeded with 0ms".
   */
  async ping(): Promise<{ ok: boolean; latencyMs: number } | null> {
    if (!this.redis) return null;
    try {
      const start = Date.now();
      await this.redis.ping();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      this.healthy = false;
      return null;
    }
  }

  /** Fail-safe wrapper: Redis errors never throw into the caller. */
  private async guarded<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
    if (!this.redis) return fallback;
    try {
      return await fn();
    } catch {
      this.healthy = false;
      return fallback;
    }
  }

  /**
   * Write presence + guarantee the owner lease (atomic). Returns false when
   * another instance currently owns the participant (the caller must not
   * proceed as owner).
   */
  async setPresence(
    info: Omit<PresenceInfo, 'instanceId'>,
    ttlMs?: number,
    leaseMs?: number,
  ): Promise<boolean> {
    const ttl = ttlMs ?? this.presenceTtlMs;
    const lease = leaseMs ?? this.ownerLeaseMs;
    return this.guarded(false, async () => {
      const res = (await this.redis!.eval(
        PRESENCE_SCRIPT,
        2,
        this.presenceKey(info.organizationId, info.participantId),
        this.ownerKey(info.organizationId, info.participantId),
        this.instanceId,
        'instanceId',
        this.instanceId,
        'participantId',
        info.participantId,
        'mediaSessionId',
        info.mediaSessionId,
        'attemptId',
        info.attemptId,
        'organizationId',
        info.organizationId,
        'connectionState',
        info.connectionState,
        'connectedAt',
        String(info.connectedAt),
        'lastSeenAt',
        String(info.lastSeenAt),
        String(ttl),
        String(lease),
      )) as number;
      return res === 1;
    });
  }

  /** Throttled liveness touch (gateway ping). Refreshes TTL + lease when ours. */
  async heartbeat(participantId: string, organizationId: string): Promise<boolean> {
    return this.guarded(false, async () => {
      const res = (await this.redis!.eval(
        HEARTBEAT_SCRIPT,
        2,
        this.presenceKey(organizationId, participantId),
        this.ownerKey(organizationId, participantId),
        this.instanceId,
        String(Date.now()),
        String(this.presenceTtlMs),
        String(this.ownerLeaseMs),
      )) as number;
      return res === 1;
    });
  }

  /** Reflect a gateway state change (RECONNECTING / DISCONNECTED / ENDED / FAILED). */
  async markState(
    participantId: string,
    organizationId: string,
    connectionState: PresenceState,
  ): Promise<boolean> {
    const ttl = connectionState === 'RECONNECTING' ? RECONNECT_TTL_MS : connectionState === 'DISCONNECTED' ? DISCONNECT_TTL_MS : this.presenceTtlMs;
    return this.guarded(false, async () => {
      const res = (await this.redis!.eval(
        PRESENCE_SCRIPT,
        2,
        this.presenceKey(organizationId, participantId),
        this.ownerKey(organizationId, participantId),
        this.instanceId,
        'connectionState',
        connectionState,
        'lastSeenAt',
        String(Date.now()),
        String(ttl),
        connectionState === 'DISCONNECTED' || connectionState === 'ENDED' || connectionState === 'FAILED'
          ? '1' // lease becomes irrelevant — released separately below
          : String(this.ownerLeaseMs),
      )) as number;
      if (res === 1 && (connectionState === 'DISCONNECTED' || connectionState === 'ENDED' || connectionState === 'FAILED')) {
        await this.releaseOwnership(participantId, organizationId);
      }
      return res === 1;
    });
  }

  async getPresence(participantId: string, organizationId: string): Promise<PresenceSnapshot | null> {
    return this.guarded(null, async () => {
      const key = this.presenceKey(organizationId, participantId);
      const ownerKey = this.ownerKey(organizationId, participantId);
      const [hash, owner, pttl] = (await Promise.all([
        this.redis!.hgetall(key),
        this.redis!.get(ownerKey),
        this.redis!.pttl(key),
      ])) as [Record<string, string>, string | null, number];
      if (Object.keys(hash).length === 0) return null;
      const connectedAt = Number(hash.connectedAt ?? 0);
      const lastSeenAt = Number(hash.lastSeenAt ?? 0);
      if (!hash.participantId) return null;
      return {
        participantId: hash.participantId,
        mediaSessionId: hash.mediaSessionId ?? hash.participantId,
        attemptId: hash.attemptId ?? '',
        organizationId: hash.organizationId ?? organizationId,
        connectionState: (hash.connectionState as PresenceState) ?? 'ACTIVE',
        instanceId: hash.instanceId ?? '',
        connectedAt: Number.isFinite(connectedAt) ? connectedAt : 0,
        lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : 0,
        ownerInstanceId: owner,
        ttlMs: pttl > 0 ? pttl : null,
      };
    });
  }

  /** Delete presence + ownership-aware release (atomic). */
  async removePresence(participantId: string, organizationId: string): Promise<boolean> {
    return this.guarded(false, async () => {
      await this.redis!.multi()
        .del(this.presenceKey(organizationId, participantId))
        .eval(RELEASE_SCRIPT, 1, this.ownerKey(organizationId, participantId), this.instanceId)
        .exec();
      return true;
    });
  }

  /**
   * Atomic ownership acquisition. 'owned-by-other' means another API instance
   * currently owns this participant's lease → the caller must NOT join as a
   * publisher (prevents two instances from both owning the same participant).
   */
  async acquireOwnership(participantId: string, organizationId: string, leaseMs?: number): Promise<AcquireResult> {
    return this.guarded('unavailable', async () => {
      const res = (await this.redis!.eval(
        ACQUIRE_SCRIPT,
        1,
        this.ownerKey(organizationId, participantId),
        this.instanceId,
        String(leaseMs ?? this.ownerLeaseMs),
      )) as number;
      return res === 1 ? 'acquired' : res === 2 ? 'already-owner' : 'owned-by-other';
    });
  }

  /** Ownership-aware release: only the current owner can clear the lease. */
  async releaseOwnership(participantId: string, organizationId: string): Promise<boolean> {
    return this.guarded(false, async () => {
      const res = (await this.redis!.eval(
        RELEASE_SCRIPT,
        1,
        this.ownerKey(organizationId, participantId),
        this.instanceId,
      )) as number;
      return res === 1;
    });
  }

  async ownerOf(participantId: string, organizationId: string): Promise<string | null> {
    return this.guarded(null, async () => this.redis!.get(this.ownerKey(organizationId, participantId)));
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }
}