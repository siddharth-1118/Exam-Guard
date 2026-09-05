# Phase 4D.1 — Realtime Media Session Cleanup (Status)

Date: 2026-09-04 · Scope: media lifecycle cleanup only — no load testing, no Redis
presence, no AI/recording/UI. This phase hardens the realtime media lifecycle so a
crashed or uncooperative Student Desktop can never leave live publisher resources
behind, and attempts that end always clean their media server-side.

## Verified starting point

Phase 4A (authenticated control plane), 4B (real SFU + student publisher), and the
3A/3B/3C desktop/media foundations were re-verified on this run before/after the
changes (see Tests). The monitor subscriber (Phase 4C) is **not implemented** — no
consumers exist in the SFU and there is no `media-monitor-e2e.mjs`, so that phase
cannot regress or be run yet.

## What was changed

| File | Change |
| --- | --- |
| `services/api/src/media/media.cleanup.ts` | **new** — subscribes to `student.submitted` / `student.terminated` and tears media down server-side (see Lifecycle rules). |
| `services/api/src/media/media.gateway.ts` | `forceClosePublishersForAttempt()` — closes the live publisher control socket (code 4002) **without** arming the reconnect grace window; new `serverCloses` metric. |
| `services/api/src/media/media.service.ts` | `evictSfuRoom()` (idempotent HTTP eviction of the SFU room), `findParticipantsByAttempt()`, `auditSystem()` (actor-less audit rows). |
| `services/api/src/media/media.controller.ts` | `GET /api/v1/media/sessions/diagnostics` (org admin / super admin only) exposing gateway stats + sweeper state. |
| `services/api/src/common/config.ts` | `sfuAdminKey` getter (env `SFU_ADMIN_KEY`, dev default mirrors the SFU). |
| `services/media/src/sfu.ts` | `evictParticipant()` — server-initiated room teardown (transport → producers → router) + publisher WS close 4002. |
| `services/media/src/server.ts` | `POST /admin/evict` internal endpoint, guarded by `x-sfu-admin-key` (401 otherwise); idempotent 404 when no room. |
| `services/media/src/config.ts` | `adminKey` config. |
| `apps/student-desktop/src/media/publisher.ts` | SFU close codes **4001** (replaced) and **4002** (attempt ended / evicted) are now terminal for the publisher — it stops instead of fighting the server with reconnect attempts. |
| `scripts/media-cleanup-e2e.mjs` | **new** — automated cleanup E2E (all legs pass, see Tests). |
| `.env.example` | documents `SFU_ADMIN_KEY`, `MEDIA_SWEEP_INTERVAL_MS`, `MEDIA_SWEEP_LEASE_MS`. |
| `docs/PHASE_4D_1_STATUS.md` | this document. |

Pre-existing 4D hardening that this phase builds on (already on disk, re-verified):

- `media.sweeper.ts` — server-side lease sweeper over MediaParticipant rows.
- `sweep.decide.ts` (+ spec) — pure decision logic: attempt terminal → end;
  live presence wins; stale ACTIVE → RECONNECTING; stale RECONNECTING →
  DISCONNECTED; CONNECTING that never joined → FAILED. DISCONNECTED rows are
  intentionally left alone so a returning student can still restore the same
  participant while the attempt is open.
- SFU protocol-level ping sweep — a hard-crashed client that never sends a close
  frame is detected and terminated; the socket close tears the room down.
- Duplicate-connection protection (API gateway: second live publisher socket for
  an attempt is rejected 409; SFU: a second join evicts the old connection —
  never two live rooms/producers for one participant).

## Lifecycle rules (as implemented + verified)

```
Attempt → SUBMITTED / AUTO_SUBMITTED / TERMINATED
   │  (attempt services already end the MediaParticipant row)
   ├─ MediaGateway closes the live publisher control socket  (close 4002, no grace rearm)
   ├─ API POST /admin/evict → SFU tears down room           (transport, producers, router)
   ├─ publisher WS at the SFU receives close 4002 → desktop stops (no reconnect fight)
   └─ audit `media.session.ended` { cause, connectionsClosed, sfuRoomsEvicted } — only when
      something was actually closed (no audit noise on already-empty attempts)
```

Stale sessions (crash / network partition / API restart that lost in-memory presence):

```
CONNECTING ──(lease)──► FAILED (join-timeout)
ACTIVE     ──(lease, no presence)──► RECONNECTING ──(lease)──► DISCONNECTED
DISCONNECTED is NOT terminal: while the attempt stays ACTIVE a later join restores
the SAME participantId (reconnected=true). After the attempt ends, the terminate
hook ends the row regardless of state.
```

Guarantees:

- **Server-initiated**: cleanup never depends on the Electron client sending
  `leave` or a final request — proven by the E2E sockets, which never leave.
- **Idempotent**: row transitions are guarded `updateMany`s; a second SFU eviction
  of an already-gone room is a 404, never an error or double audit.
- **Concurrency-safe**: the sweeper re-checks state in its WHERE clause, so two
  sweepers (or a sweep racing a live join) cannot double-transition.
- **Tenant-safe**: everything is keyed by attempt/participant rows scoped to their
  organization.
- **Grace-respecting**: temporary disconnects keep their reconnect window; the
  sweeper only acts after the lease (default 90 s = 2× the 45 s gateway grace) and
  only when there is no live presence.

## Duplicate connection policy (documented + verified)

One live publisher per attempt.

- API gateway: a second publisher socket joining the same attempt while the first
  is OPEN is rejected with `409`; the first connection keeps the slot (verified —
  it still answers pings afterwards).
- SFU: if a duplicate ever reaches the media plane (e.g. after an API restart), a
  second join **evicts** the older connection and its room — deterministic, never
  two rooms or duplicate producers for one participantId.

## Reconnect behavior (verified)

`drop → join` repeated 3× keeps the identical participantId and every rejoin is
flagged `reconnected=true` (row walked ACTIVE→RECONNECTING between joins). Dropping
and waiting past the lease sweeps the row to DISCONNECTED (never destroyed) and a
later join while the attempt is ACTIVE still restores ACTIVE with
`reconnected=true`. Reconnects re-create producers only from a clean slate (the
SFU tears the old room on socket close), so no duplicate producers can accumulate.

## Tests executed (all on the live API + SFU + dev Postgres)

| Suite | Result |
| --- | --- |
| API unit (media state + sweep decision) | 16/16 pass |
| API e2e-specs (auth, exams, security) | 25/25 pass |
| Student desktop unit | 45/45 pass |
| Typecheck (api, media, desktop ×2) + builds | clean |
| Phase 4A E2E `media-signaling-e2e.mjs` | PASS |
| Phase 4B E2E `media-publish-e2e.mjs` (real camera+mic+screen → SFU) | PASS |
| Phase 4C E2E | N/A — monitor subscriber not implemented (no script exists) |
| **New cleanup E2E `media-cleanup-e2e.mjs`** | **PASS** |

`media-cleanup-e2e.mjs` legs (clients never send `leave`):

1. **Submit** while gateway + SFU sockets are live → gateway close 4002, SFU close
   4002, SFU room gone, row ENDED (DB + API agree), `media.session.ended` audit
   with `cause: attempt.submit`, second eviction → 404 (idempotent).
2. **Monitor terminate** while sockets are live → same guarantees with
   `cause: attempt.terminate` and attempt status TERMINATED.
3. **Duplicate publisher** → second gateway join rejected 409; first connection
   healthy (pong).
4. **Reconnect** ×3 → identical participantId each time, all `reconnected=true`;
   after grace/lease the row is DISCONNECTED and a late join restores ACTIVE.
5. **Stale CONNECTING** (created, never joined) → swept to FAILED
   (`join-timeout`) with a sweeper audit row.
6. **Baseline** → SFU `/status` shows zero rooms for the fixture attempt set;
   zero participant rows remain in CONNECTING/ACTIVE/RECONNECTING/DISCONNECTED.

Diagnostics observed at the end of the run (dev counters):

```json
{ "gateway": { "connections":0, "publisherConnections":0, "joins":7, "reconnects":4,
  "duplicateRejections":2, "serverCloses":4, "messages":15 },
  "sweeper": { "scanned":1, "ended":1, "disconnected":2, "failed":1, "errors":0,
  "config": { "intervalMs":3000, "leaseMs":7000 } } }
```

(The sweep E2E ran with a shortened lease, 7 s, to keep the test fast; production
defaults are interval 20 s / lease 90 s. The API was restarted with defaults
afterwards and all other suites re-ran green.)

## Known limitations

- Client-side handling of close codes 4001/4002 was implemented in the desktop
  publisher and typechecked, but not exercised by an Electron E2E in this phase
  (server-side enforcement is what the E2E proves; the desktop behavior is a
  defense-in-depth stop, not the mechanism of record).
- Presence remains single-node in-process memory (the sweeper consults the local
  gateway registry). A multi-node API deployment needs a distributed presence/
  leader election — out of scope here (documented, not claimed).
- The SFU eviction endpoint is guarded by a shared admin key and bound to
  `127.0.0.1` in dev; a production SFU must place `/admin/*` behind its own
  network/ingress policy.
- No scalability claims are made by this phase — it validates cleanup correctness
  for the single-publisher-per-attempt topology already in place.
