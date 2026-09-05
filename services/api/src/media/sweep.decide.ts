/**
 * Media-participant stale-session decision logic (Phase 4D hardening).
 *
 * Pure — no I/O — so the lease/transition rules are unit-testable. The sweeper
 * service feeds real rows/presence into `decideSweep` and applies the result.
 *
 * Policy (deterministic, tenant-safe, idempotent):
 *  - attempt reached a terminal state  → END the participant row (server-side
 *    cleanup that works even when the student app is gone);
 *  - a LIVE gateway connection        → never touch (presence wins);
 *  - otherwise a row whose last known activity is older than the lease moves
 *    through the existing state machine (ACTIVE → RECONNECTING →
 *    DISCONNECTED; CONNECTING → FAILED) so a crashed client can never leave a
 *    CONNECTING/ACTIVE row forever.
 *
 * DISCONNECTED rows are left alone: they are no longer "active" and a later
 * reconnect restores the same participant while the attempt is still open.
 */

export type SweepTargetState = 'CONNECTING' | 'ACTIVE' | 'RECONNECTING';

export type SweepDecision =
  | { action: 'end'; reason: 'attempt-terminal' }
  | { action: 'reconnecting'; reason: 'stale-no-presence' }
  | { action: 'disconnected'; reason: 'stale-no-presence' }
  | { action: 'failed'; reason: 'join-timeout' }
  | { action: 'none' };

export interface SweepContext {
  state: SweepTargetState;
  /** Attempt is in a terminal state (SUBMITTED/AUTO_SUBMITTED/TERMINATED). */
  attemptTerminal: boolean;
  /** True while an authenticated gateway socket is live for the participant. */
  live: boolean;
  /** Last known activity (gateway presence or DB row), ms epoch; null unknown. */
  lastSeenAt: number | null;
  /** Wall clock, ms epoch. */
  now: number;
  /** Row is stale once its last activity is older than this (ms). */
  leaseMs: number;
}

export function decideSweep(ctx: SweepContext): SweepDecision {
  // 1. Attempt ended: always close the publisher row (idempotent end).
  if (ctx.attemptTerminal) return { action: 'end', reason: 'attempt-terminal' };

  // 2. Live publisher connection: healthy — never sweep.
  if (ctx.live) return { action: 'none' };

  const age = ctx.now - (ctx.lastSeenAt ?? 0);
  const stale = age > ctx.leaseMs;

  // 3. No live presence and beyond the lease: walk the state machine so a
  //    crashed client converges to a dead state instead of lingering active.
  switch (ctx.state) {
    case 'ACTIVE':
      return stale ? { action: 'reconnecting', reason: 'stale-no-presence' } : { action: 'none' };
    case 'RECONNECTING':
      return stale ? { action: 'disconnected', reason: 'stale-no-presence' } : { action: 'none' };
    case 'CONNECTING':
      // Created (REST) but never joined within the lease.
      return stale ? { action: 'failed', reason: 'join-timeout' } : { action: 'none' };
    default:
      return { action: 'none' };
  }
}
