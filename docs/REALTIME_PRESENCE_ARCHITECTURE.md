# ExamGuard — Realtime Presence Architecture

Phase 4D.2 adds Redis as an **ephemeral** presence + coordination layer for the
media realtime plane. PostgreSQL (`MediaParticipant`) remains the durable
source of truth; Redis never stores media, SDP, or long-lived state, and its
expiration can never by itself mutate the database.

## Purpose

Before 4D.2 all realtime state lived in one API process:

- the gateway's in-process connection registry (`conns`,
  `publisherByAttempt`, `monitorsByExam`),
- per-participant last-seen (`lastSeenByParticipant`),
- reconnect grace timers,
- the sweeper's presence readout (`gateway.presenceOf`).

That is fine for a single instance. Redis presence makes the same information
visible across API instances so that:

1. **A monitor/sweeper on instance B sees that a publisher is live on
   instance A** (no premature DISCONNECT/END), and
2. **two API instances can never both believe they own the same publisher
   connection** (distributed duplicate-publisher prevention).

It does NOT make Redis a state machine — the existing `MediaSessionState`
machine (`media/state.ts`) and the `MediaParticipant` row remain authoritative.

## Key structure (deterministic, tenant-safe)

```
examguard:media:presence:{orgId}:{participantId}     HASH    (TTL'd)
examguard:media:owner:{orgId}:{participantId}         STRING = instanceId  (TTL'd lease)
```

- `orgId` is in the key prefix, so a leaked participantId can never collide or
  read across organizations.
- Keys are built only from server-side validated UUIDs (participant row id +
  its org), never from browser input; the browser has no Redis access.
- Prefix is `examguard:media:` (overridable via the `namespace` option for
  tests / multi-tenant Redis deployments).

Presence hash fields: `participantId`, `mediaSessionId`, `attemptId`,
`organizationId`, `connectionState`, `instanceId`, `connectedAt`,
`lastSeenAt` (ms epoch). Owner key value: the owning API instance's id.

## TTL / heartbeat

| Key | Default TTL | Refreshed by |
|---|---|---|
| presence | 30 s | publisher `ping` over the gateway WS (client heartbeat 15 s → 2× margin) |
| owner lease | 60 s | join + ping + reconnect (must outlive the 45 s reconnect grace) |
| presence in RECONNECTING | 60 s | set once on socket loss (outlives the grace so any instance sees it) |
| presence in DISCONNECTED | 15 s | set once on grace expiry, then self-expires |

- A crashed process's keys expire on their own; no permanent presence.
- The lease is **independent** of the presence TTL (verified by test): a
  crashed instance's ownership is released by lease expiry even if its
  presence key would linger.
- Redis presence expiration is never a reason to touch the DB — see
  Stale-session interaction.

## Ownership (distributed duplicate prevention)

Atomic Lua `SET key instanceId NX PX lease` (or `GET`-compare for the
reconnect case):

- **acquired** — first owner takes the lease.
- **already-owner** — our own reconnect re-acquires idempotently.
- **owned-by-other** — another API instance holds the lease → the joining
  gateway rejects the publisher with **409** *before* any DB write.
- **unavailable** — Redis is down → the join falls back to the existing
  in-process `publisherByAttempt` check (single-node behavior, fail-safe).

Release is ownership-aware (`Lua GET == instanceId → DEL`): instance B can
never release instance A's lease.

**Takeover**: when the owning instance disappears, its lease expires (≤ 60 s)
and any instance can acquire the participant (proven by the deterministic
two-instance integration test).

## Where presence is written

`MediaPresenceService` (`services/api/src/media/media.presence.ts`) is invoked
from:

- **gateway join** (`handlePublisherJoin`) — ownership gate before
  `gatewayJoin`; presence ACTIVE after it succeeds (rollback of the advisory
  lease if join fails);
- **gateway ping** — presence TTL + lease refresh (throttled, fail-safe);
- **socket loss** (`onClose`) — presence → RECONNECTING (lease kept through
  the grace window);
- **grace expiry** — presence → DISCONNECTED (brief TTL), lease released;
- **leave / end / force-close / attempt-terminal cleanup / sweeper end** —
  presence removed (key + lease atomically).

## Stale-session sweeper interaction

`MediaSweeperService.evaluateRow` now merges three signals:

```
local = gateway.presenceOf(participantId)      // in-process (this instance)
remote = presenceStore.getPresence(...)        // Redis mirror (all instances)
row    = durable MediaParticipant row          // Postgres
merged = resolvePresence(local, remote, row)   // pure, unit-tested
```

- `live` = local live **or** remote ACTIVE (any instance).
- `ownerIsOther` = a fresh remote lease owned by a different instance → the
  row is left alone entirely (that instance owns the lifecycle).
- `lastSeenAt` = max(local, remote, row.lastSeenAt, row.updatedAt).

The sweeper still only transitions a row when the **existing** lease policy
says so (attempt terminal / no live presence + older than
`MEDIA_SWEEP_LEASE_MS`), and every transition is the same guarded
`updateMany`. Redis absence or expiry alone can never end a participant —
the durable row and attempt state are always re-checked first.

## Reconnect with Redis

- Same instance: join → `already-owner` → gatewayJoin marks ACTIVE → presence
  ACTIVE. No duplicate publisher (in-process map also still enforces).
- Other instance while lease alive: 409 (client retries; typically the LB
  routes back to the owner, and the lease covers the 45 s grace).
- Owner instance crashed: lease expires ≤ 60 s → any instance acquires and
  the reconnect proceeds (takeover).

## Redis failure behavior (fail-safe)

All `MediaPresenceService` methods are wrapped: when Redis is unreachable they
return safe values (`false` / `null` / `'unavailable'`) and never throw into
the hot path; the store logs a throttled warning and keeps trying to reconnect
(backoff). Consequences, by design:

- ownership checks report "no owner" → join behavior equals today's
  single-node in-process duplicate check;
- presence reads return null → the sweeper falls back to local registry +
  durable row timestamps (identical to pre-4D.2);
- durable `MediaParticipant` state is never mutated from Redis state;
- no duplicate publishers, no bypassed authorization (authorization never
  involves Redis), no cross-tenant exposure.

## Security

- Browser bundles contain no Redis code, credentials, or URLs (`ioredis` is an
  API-only dependency; monitor/student apps never touch it).
- Keys embed the org id; lookups are always scoped by server-side org id.
- No client-supplied strings are used as key components.
- Diagnostics expose only metadata: instance id, healthy flag, key TTLs — no
  media, no credentials.

## Multi-instance test

A deterministic integration test (`media.presence.spec.ts`) simulates two
logical API instances (two `MediaPresenceService` instances with distinct
instanceIds over one Redis namespace):

```
A acquires P (presence ACTIVE, lease held)
B sees P owned by A → setPresence false, acquire → 'owned-by-other'
A disappears (leases expire — short TTLs in the test)
B acquires P → 'acquired' → fresh presence → owner = B
```

plus ownership-aware release (B cannot release A's lease), TTL/heartbeat
liveness, state mirroring (RECONNECTING keeps the lease, DISCONNECTED
releases it), and the dead-Redis fail-safe (dead port → all operations return
safe values, no hang).

Limitation: two **complete** API instances on separate ports were not started
in this dev box (single SFU/API; the media E2Es run the real gateway path on
one instance). The ownership layer itself is tested with two logical
instances as described; wiring a second full instance is deployment work.

## Implemented vs future

**Implemented:** Redis presence + TTL + heartbeat, ownership lease with
atomic acquire/release/takeover, gateway integration, sweeper merge,
attempt-terminal cleanup, diagnostics, fail-safe degradation, deterministic
two-instance ownership test, all media E2Es green with Redis live.

**Explicitly future / out of scope for 4D.2:** distributed SFU rooms (media
bytes still flow through the single SFU), Redis pub/sub for cross-instance
monitor push, multi-instance leader election for the sweeper timer (the
sweeper currently runs per instance but is guarded by presence/ownership so
dual sweeps are safe), horizontal scaling/load testing.