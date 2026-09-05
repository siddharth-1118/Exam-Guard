# ExamGuard — Phase 4D.2 Status: Redis Presence & Distributed Coordination

## What was built

Redis-backed **ephemeral presence** + **distributed ownership** for the media
realtime plane, integrated with the existing gateway, sweeper, and
attempt-terminal cleanup. PostgreSQL remains the durable source of truth; the
existing `MediaSessionState` machine is untouched.

- `services/api/src/media/media.presence.ts` — `MediaPresenceService`
  (ioredis) + pure `resolvePresence` sweeper helper.
- Keys: `examguard:media:presence:{orgId}:{participantId}` (HASH, TTL 30 s,
  refreshed by gateway ping) and `examguard:media:owner:{orgId}:{participantId}`
  (STRING lease, TTL 60 s). State mirrored: ACTIVE / RECONNECTING /
  DISCONNECTED; ENDED/FAILED remove the key.
- Atomic Lua scripts: presence write + lease, heartbeat, acquire
  (`NX` + owner-compare), ownership-aware release (`GET == instanceId →
  DEL`).
- Gateway: ownership gate **before** `gatewayJoin` (another instance owning
  the participant → 409, no DB write), presence set on join, heartbeat on
  ping, RECONNECTING on socket loss (lease kept through the 45 s grace),
  DISCONNECTED + lease release on grace expiry, removal on leave/force-close.
- Sweeper: merges local registry + Redis mirror (`resolvePresence`); a fresh
  ACTIVE presence on ANY instance counts as live; a lease owned by another
  instance skips the row entirely; Redis absence/expiry alone can never
  transition a row (durable row + attempt state always re-checked).
- Attempt-terminal cleanup (`media.cleanup.ts`) and REST `endById` also remove
  presence keys/leases.
- Diagnostics: `/api/v1/media/sessions/diagnostics` now reports presence
  status (instanceId, healthy, TTLs).
- Fail-safe: Redis down → ownership "no owner", presence reads null, no
  throws, no duplicate publishers, no state corruption (unit-tested with a
  dead port).

## Tests run

| Suite | Result |
|---|---|
| New presence spec (`media.presence.spec.ts`, real Redis + two logical instances + dead port) | 16/16 PASS |
| API unit (all) | 32/32 PASS |
| API e2e-specs | 25/25 PASS |
| Desktop unit | 45/45 PASS |
| Phase 4C infrastructure E2E (publisher→SFU→monitor, real media) | PASS |
| Phase 4B publish E2E (real camera/mic/screen → SFU) | PASS |
| Phase 4D.1 cleanup E2E (short-lease API; sweeper + attempt-end) | PASS |
| Monitor live-view UI E2E (real portal + real media) | PASS |
| Typecheck: api, monitor-web, student-desktop | clean |
| Build: API (`nest build`), monitor-web Next build (from 4C.2) | clean |

Final environment state after all E2Es: 0 stray `examguard:media:*` Redis
keys, SFU at 0 rooms/producers/consumers, API healthy with presence connected
(`redis presence connected` in the boot log).

## Security results

- Browser bundles never touch Redis (no ioredis, no credentials, no URLs).
- Key components are server-side UUIDs only; org id is part of every key.
- Ownership release is ownership-aware; takeover requires lease expiry.
- Cross-tenant behavior unchanged (all media authorization remains
  server-side in `MediaService`); Redis adds no authorization surface.

## Multi-instance result

Two logical API instances (distinct instanceIds over one Redis namespace) in
`media.presence.spec.ts`: A acquires → B sees owned (409-equivalent
`owned-by-other`, `setPresence` refused) → A disappears → lease expires → B
acquires and writes fresh presence. Ownership-aware release verified (B cannot
release A's lease). Two complete API processes on separate ports were not
started in this dev box (single SFU/API); that deployment wiring is documented
as a limitation.

## Files changed

- `services/api/src/media/media.presence.ts` (new)
- `services/api/src/media/media.presence.spec.ts` (new)
- `services/api/src/media/media.gateway.ts` (ownership gate + presence hooks)
- `services/api/src/media/media.sweeper.ts` (presence merge + owner guard)
- `services/api/src/media/media.cleanup.ts` (presence removal)
- `services/api/src/media/media.service.ts` (presence removal on REST end)
- `services/api/src/media/media.controller.ts` (presence diagnostics)
- `services/api/src/media/media.module.ts` (provider registration)
- `services/api/src/common/config.ts` (`redisUrl`)
- `docs/PHASE_4D_2_STATUS.md`, `docs/REALTIME_PRESENCE_ARCHITECTURE.md`

## Known limitations

- Single API instance + single SFU in this environment; two full instances
  not booted (ownership layer tested with two logical instances instead).
- Sweeper timer still runs per instance; it is safe under dual runs (guarded
  transitions + ownership skip) but not leader-elected.
- No Redis pub/sub for cross-instance monitor push yet (in-process fan-out
  remains).
- Redis is a single local server; no replication/HA (deployment concern, not
  code).
- No load/scalability claims — Redis presence is coordination, not scaling.