/**
 * MediaPresenceService — Redis presence + ownership tests (Phase 4D.2).
 *
 * Requires a running Redis on REDIS_URL (default redis://localhost:6379).
 * Two logical API instances are simulated with two store instances (distinct
 * instanceIds) sharing one Redis namespace — the deterministic
 * distributed-ownership integration test. A dead-port store proves the
 * fail-safe behaviour when Redis is unavailable.
 */
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../common/config';
import {
  MediaPresenceService,
  resolvePresence,
  type PresenceSnapshot,
} from './media.presence';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const NAMESPACE = `examguard:media:test:${randomUUID().slice(0, 8)}`;
const ORG = 'org-1';
const PARTICIPANT = 'p-1';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(store: MediaPresenceService): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (store.isHealthy) return;
    await sleep(50);
  }
  throw new Error('presence store never became healthy (Redis reachable?)');
}

function makeStore(instanceId: string, url = REDIS_URL): MediaPresenceService {
  const config = { redisUrl: url } as unknown as AppConfig;
  return new MediaPresenceService(config, { namespace: NAMESPACE, instanceId });
}

async function wipeNamespace(): Promise<void> {
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  try {
    const keys = await client.keys(`${NAMESPACE}:*`);
    if (keys.length > 0) await client.del(...keys);
  } finally {
    client.disconnect();
  }
}

describe('media presence store', () => {
  let A: MediaPresenceService;
  let B: MediaPresenceService;

  beforeAll(async () => {
    // Sanity: Redis must be reachable or every test in this file is moot.
    const probe = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1_000 });
    await probe.ping().catch(() => {
      throw new Error(`Redis not reachable at ${REDIS_URL} — start redis-server before running`);
    });
    probe.disconnect();
  }, 10_000);

  beforeEach(async () => {
    A = makeStore('instance-a');
    B = makeStore('instance-b');
    // Commands issued before the first connect fail fast by design — wait for
    // both clients to be connected before exercising them.
    await waitHealthy(A);
    await waitHealthy(B);
  });

  afterEach(async () => {
    await wipeNamespace();
    A.onModuleDestroy();
    B.onModuleDestroy();
  });

  const info = (state: 'ACTIVE' | 'RECONNECTING' | 'DISCONNECTED' = 'ACTIVE') => ({
    participantId: PARTICIPANT,
    mediaSessionId: PARTICIPANT,
    attemptId: 'a-1',
    organizationId: ORG,
    connectionState: state,
    connectedAt: 1_000,
    lastSeenAt: 1_000,
  });

  it('writes and reads a full presence snapshot with ownership', async () => {
    expect(await A.setPresence(info())).toBe(true);
    const snap = await A.getPresence(PARTICIPANT, ORG);
    expect(snap).toMatchObject({
      participantId: PARTICIPANT,
      mediaSessionId: PARTICIPANT,
      attemptId: 'a-1',
      organizationId: ORG,
      connectionState: 'ACTIVE',
      instanceId: 'instance-a',
      ownerInstanceId: 'instance-a',
    });
    expect(snap?.ttlMs).toBeGreaterThan(0);
  });

  it('expires automatically without heartbeat', async () => {
    await A.setPresence(info(), 400);
    await sleep(800);
    expect(await A.getPresence(PARTICIPANT, ORG)).toBeNull();
  });

  it('ownership lease expires independently of presence TTL (crashed instance releases)', async () => {
    // Presence TTL outlives the lease here: the key is still present after the
    // lease dies — proving presence expiry and lease expiry are separate.
    await A.setPresence(info(), 2_000, 300);
    await sleep(700);
    expect(await A.getPresence(PARTICIPANT, ORG)).not.toBeNull();
    expect(await A.ownerOf(PARTICIPANT, ORG)).toBeNull();
    expect(await B.acquireOwnership(PARTICIPANT, ORG)).toBe('acquired');
  }, 10_000);

  it('heartbeat keeps a presence alive past its base TTL', async () => {
    await A.setPresence(info(), 600);
    await sleep(300);
    expect(await A.heartbeat(PARTICIPANT, ORG)).toBe(true);
    await sleep(500); // 800ms > 600ms base TTL — still alive thanks to the heartbeat
    const snap = await A.getPresence(PARTICIPANT, ORG);
    expect(snap).not.toBeNull();
    expect(snap?.lastSeenAt).toBeGreaterThan(0);
  }, 10_000);

  it('rejects a second instance while the lease is held (duplicate ownership)', async () => {
    expect(await A.setPresence(info())).toBe(true);
    // B cannot write presence or acquire while A owns.
    expect(await B.setPresence(info())).toBe(false);
    expect(await B.acquireOwnership(PARTICIPANT, ORG)).toBe('owned-by-other');
    // A still owns.
    expect(await A.acquireOwnership(PARTICIPANT, ORG)).toBe('already-owner');
    expect(await A.ownerOf(PARTICIPANT, ORG)).toBe('instance-a');
  });

  it('ownership release is ownership-aware (B cannot release A’s lease)', async () => {
    await A.setPresence(info());
    expect(await B.releaseOwnership(PARTICIPANT, ORG)).toBe(false);
    expect(await A.ownerOf(PARTICIPANT, ORG)).toBe('instance-a');
    expect(await A.releaseOwnership(PARTICIPANT, ORG)).toBe(true);
    expect(await A.ownerOf(PARTICIPANT, ORG)).toBeNull();
  });

  it('takeover after lease expiration (instance A disappears → B acquires)', async () => {
    expect(await A.setPresence(info(), 500, 400)).toBe(true);
    await sleep(900); // A's presence + lease expired (A "crashed")
    expect(await A.getPresence(PARTICIPANT, ORG)).toBeNull();
    expect(await B.acquireOwnership(PARTICIPANT, ORG)).toBe('acquired');
    // B can now write a fresh presence for the same participant.
    expect(await B.setPresence(info())).toBe(true);
    const snap = await B.getPresence(PARTICIPANT, ORG);
    expect(snap?.ownerInstanceId).toBe('instance-b');
  }, 10_000);

  it('removePresence clears the key and the lease atomically', async () => {
    await A.setPresence(info());
    await A.removePresence(PARTICIPANT, ORG);
    expect(await A.getPresence(PARTICIPANT, ORG)).toBeNull();
    expect(await A.ownerOf(PARTICIPANT, ORG)).toBeNull();
  });

  // --- C19 Redis behavior tests ---

  it('duplicate heartbeats do not produce duplicate state', async () => {
    await A.setPresence(info(), 5_000);
    const before = await A.getPresence(PARTICIPANT, ORG);
    expect(before?.connectionState).toBe('ACTIVE');
    // Fire 5 rapid heartbeats
    for (let i = 0; i < 5; i++) await A.heartbeat(PARTICIPANT, ORG);
    const after = await A.getPresence(PARTICIPANT, ORG);
    // Same single key, same participant — no duplicates
    expect(after?.participantId).toBe(PARTICIPANT);
    expect(after?.instanceId).toBe('instance-a');
    expect(after?.ownerInstanceId).toBe('instance-a');
  });

  it('heartbeat on missing key returns false (fail-safe, no crash)', async () => {
    expect(await A.heartbeat('nonexistent', ORG)).toBe(false);
  });

  it('expired ownership is reclaimed by a new instance', async () => {
    await A.setPresence(info(), 2_000, 300); // 300ms lease
    expect(await A.acquireOwnership(PARTICIPANT, ORG)).toBe('already-owner');
    await sleep(500); // lease expired
    expect(await B.acquireOwnership(PARTICIPANT, ORG)).toBe('acquired');
    expect(await B.setPresence(info())).toBe(true);
    expect((await B.getPresence(PARTICIPANT, ORG))?.ownerInstanceId).toBe('instance-b');
  }, 10_000);

  it('ping returns latency when Redis is reachable', async () => {
    const result = await A.ping();
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('ping returns null when Redis is unreachable', async () => {
    const config = { redisUrl: 'redis://127.0.0.1:6399' } as unknown as AppConfig;
    const dead = new MediaPresenceService(config, {
      namespace: NAMESPACE,
      instanceId: 'ping-dead',
      retryStrategy: () => null,
    });
    const result = await dead.ping();
    expect(result).toBeNull();
    dead.onModuleDestroy();
  });

  it('markState mirrors RECONNECTING and DISCONNECTED, releasing the lease on disconnect', async () => {
    await A.setPresence(info());
    await A.markState(PARTICIPANT, ORG, 'RECONNECTING');
    let snap = await A.getPresence(PARTICIPANT, ORG);
    expect(snap?.connectionState).toBe('RECONNECTING');
    expect(snap?.ownerInstanceId).toBe('instance-a'); // lease kept through grace
    await A.markState(PARTICIPANT, ORG, 'DISCONNECTED');
    snap = await A.getPresence(PARTICIPANT, ORG);
    expect(snap?.connectionState).toBe('DISCONNECTED');
    expect(snap?.ownerInstanceId).toBeNull(); // lease released
  });

  it('fails safe when Redis is unreachable', async () => {
    const config = { redisUrl: 'redis://127.0.0.1:6399' } as unknown as AppConfig;
    // No reconnect loop: the dead port must fail fast and never hang the suite.
    const dead = new MediaPresenceService(config, {
      namespace: NAMESPACE,
      instanceId: 'dead',
      retryStrategy: () => null,
    });
    expect(await dead.setPresence(info())).toBe(false);
    expect(await dead.getPresence(PARTICIPANT, ORG)).toBeNull();
    expect(await dead.acquireOwnership(PARTICIPANT, ORG)).toBe('unavailable');
    expect(await dead.heartbeat(PARTICIPANT, ORG)).toBe(false);
    expect(await dead.ownerOf(PARTICIPANT, ORG)).toBeNull();
    expect(await dead.removePresence(PARTICIPANT, ORG)).toBe(false);
    expect(dead.isHealthy).toBe(false);
    dead.onModuleDestroy();
  }, 15_000);
});

describe('resolvePresence (sweeper composition)', () => {
  const base = { rowLastSeenAt: 100, rowUpdatedAt: 150, instanceId: 'me' };

  const remote = (over: Partial<PresenceSnapshot>): PresenceSnapshot => ({
    participantId: PARTICIPANT,
    mediaSessionId: PARTICIPANT,
    attemptId: 'a-1',
    organizationId: ORG,
    connectionState: 'ACTIVE',
    instanceId: 'other',
    connectedAt: 100,
    lastSeenAt: 200,
    ownerInstanceId: 'other',
    ttlMs: 5_000,
    ...over,
  });

  it('local live socket wins', () => {
    const r = resolvePresence({
      ...base,
      local: { live: true, lastSeenAt: 500 },
      remote: null,
    });
    expect(r.live).toBe(true);
    expect(r.ownerIsOther).toBe(false);
    expect(r.lastSeenAt).toBe(500);
  });

  it('a fresh ACTIVE presence on another instance counts as live and blocks sweeping', () => {
    const r = resolvePresence({
      ...base,
      local: { live: false, lastSeenAt: null },
      remote: remote({}),
    });
    expect(r.live).toBe(true);
    expect(r.ownerIsOther).toBe(true);
  });

  it('an open reconnect window on another instance blocks sweeping (owner kept)', () => {
    const r = resolvePresence({
      ...base,
      local: { live: false, lastSeenAt: null },
      remote: remote({ connectionState: 'RECONNECTING' }),
    });
    expect(r.live).toBe(false); // not ACTIVE → not live
    expect(r.ownerIsOther).toBe(true); // but another instance owns → never sweep
  });

  it('our own presence is not "other"', () => {
    const r = resolvePresence({
      ...base,
      local: { live: true, lastSeenAt: 300 },
      remote: remote({ connectionState: 'ACTIVE', instanceId: 'me', ownerInstanceId: 'me' }),
    });
    expect(r.live).toBe(true);
    expect(r.ownerIsOther).toBe(false);
  });

  it('missing/expired presence falls back to durable row timestamps', () => {
    const r = resolvePresence({ ...base, local: { live: false, lastSeenAt: null }, remote: null });
    expect(r.live).toBe(false);
    expect(r.ownerIsOther).toBe(false);
    expect(r.lastSeenAt).toBe(150); // max(rowLastSeenAt=100, rowUpdatedAt=150)
  });

  it('takes the max of every liveness timestamp', () => {
    const r = resolvePresence({
      ...base,
      local: { live: false, lastSeenAt: 300 },
      remote: remote({ lastSeenAt: 250, ownerInstanceId: 'me' }),
    });
    expect(r.lastSeenAt).toBe(300);
  });

  // --- C19 stale presence sweeper behavior ---

  it('stale remote presence (expired) does not prevent sweeping', () => {
    // Remote has DISCONNECTED state → not live, no owner → sweeper proceeds
    const r = resolvePresence({
      ...base,
      local: { live: false, lastSeenAt: null },
      remote: remote({ connectionState: 'DISCONNECTED', ownerInstanceId: null }),
    });
    expect(r.live).toBe(false);
    expect(r.ownerIsOther).toBe(false);
  });

  it('null remote + old row timestamps → sweeper uses row timestamps', () => {
    const r = resolvePresence({
      ...base,
      rowLastSeenAt: 500,
      rowUpdatedAt: 600,
      local: { live: false, lastSeenAt: null },
      remote: null,
    });
    expect(r.live).toBe(false);
    expect(r.lastSeenAt).toBe(600); // max(0, 0, 500, 600)
  });

  it('FAILED remote state is not live and has no owner', () => {
    const r = resolvePresence({
      ...base,
      local: { live: false, lastSeenAt: null },
      remote: remote({ connectionState: 'FAILED', ownerInstanceId: null }),
    });
    expect(r.live).toBe(false);
    expect(r.ownerIsOther).toBe(false);
  });
});