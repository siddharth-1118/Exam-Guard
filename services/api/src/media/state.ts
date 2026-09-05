/**
 * Media-session state machine (Phase 4A control plane). Pure — no I/O — so the
 * transition table is unit-testable.
 *
 * States follow existing project conventions (MediaSessionStatus-style):
 *   CONNECTING  == CREATED + connecting (row created, not yet connected)
 *   ACTIVE      == CONNECTED (gateway joined / presence live)
 *   RECONNECTING == socket lost, reclaim still possible within the grace window
 *   DISCONNECTED == grace expired / presence gone (attempt may still be open)
 *   ENDED       == terminal (student ended, attempt submitted/terminated)
 *   FAILED      == terminal error (auth/join failure)
 */

export type MediaSessionState =
  | 'CONNECTING'
  | 'ACTIVE'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'ENDED'
  | 'FAILED';

export type MediaSessionEvent =
  | 'connected' // gateway join / socket restored
  | 'disconnected' // socket lost → reconnect window opens
  | 'expired' // reconnect window elapsed
  | 'ended' // explicit end / attempt submitted|terminated
  | 'failed';

export const MEDIA_SESSION_STATES: readonly MediaSessionState[] = [
  'CONNECTING',
  'ACTIVE',
  'RECONNECTING',
  'DISCONNECTED',
  'ENDED',
  'FAILED',
];

/** Allowed (state, event) → next state. Anything else is an invalid transition. */
export const TRANSITIONS: Record<MediaSessionState, Partial<Record<MediaSessionEvent, MediaSessionState>>> = {
  CONNECTING: {
    connected: 'ACTIVE',
    ended: 'ENDED',
    failed: 'FAILED',
  },
  ACTIVE: {
    disconnected: 'RECONNECTING',
    ended: 'ENDED',
    failed: 'FAILED',
  },
  RECONNECTING: {
    connected: 'ACTIVE', // reconnect restores the SAME logical participant
    expired: 'DISCONNECTED',
    ended: 'ENDED',
    failed: 'FAILED',
  },
  DISCONNECTED: {
    connected: 'ACTIVE', // student returns while the attempt is still open
    ended: 'ENDED',
    failed: 'FAILED',
  },
  ENDED: {},
  FAILED: {},
};

export function nextState(state: MediaSessionState, event: MediaSessionEvent): MediaSessionState | null {
  return TRANSITIONS[state][event] ?? null;
}

export function canTransition(state: MediaSessionState, event: MediaSessionEvent): boolean {
  return nextState(state, event) !== null;
}

/** A reconnect restores the same participant (vs a brand-new session). */
export function isReconnect(state: MediaSessionState): boolean {
  return state === 'RECONNECTING' || state === 'DISCONNECTED';
}

/** Idempotent end: ending an already-ENDED session is a no-op success. */
export function endTarget(state: MediaSessionState): MediaSessionState {
  return state === 'ENDED' ? 'ENDED' : 'ENDED';
}
