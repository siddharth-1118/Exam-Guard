import { canTransition, isReconnect, nextState, TRANSITIONS, type MediaSessionEvent, type MediaSessionState } from './state';

const STATES: MediaSessionState[] = ['CONNECTING', 'ACTIVE', 'RECONNECTING', 'DISCONNECTED', 'ENDED', 'FAILED'];
const EVENTS: MediaSessionEvent[] = ['connected', 'disconnected', 'expired', 'ended', 'failed'];

describe('media session state machine', () => {
  it('follows the documented happy path CONNECTING → ACTIVE → RECONNECTING → ACTIVE → ENDED', () => {
    expect(nextState('CONNECTING', 'connected')).toBe('ACTIVE');
    expect(nextState('ACTIVE', 'disconnected')).toBe('RECONNECTING');
    expect(nextState('RECONNECTING', 'connected')).toBe('ACTIVE');
    expect(nextState('ACTIVE', 'ended')).toBe('ENDED');
  });

  it('allows reconnect from DISCONNECTED (student returns while attempt open)', () => {
    expect(nextState('DISCONNECTED', 'connected')).toBe('ACTIVE');
  });

  it('expires a reconnect window into DISCONNECTED', () => {
    expect(nextState('RECONNECTING', 'expired')).toBe('DISCONNECTED');
  });

  it('treats ENDED and FAILED as terminal', () => {
    for (const event of EVENTS) {
      expect(nextState('ENDED', event)).toBeNull();
      expect(canTransition('ENDED', event)).toBe(false);
    }
    expect(nextState('FAILED', 'ended')).toBeNull(); // reopen handled at service level
    expect(canTransition('FAILED', 'connected')).toBe(false);
  });

  it('does not connect straight from a live state without a disconnect', () => {
    // ACTIVE → 'connected' is a no-op duplicate join, not a transition.
    expect(nextState('ACTIVE', 'connected')).toBeNull();
  });

  it('rejects disconnected while merely CONNECTING (never joined)', () => {
    expect(nextState('CONNECTING', 'disconnected')).toBeNull();
  });

  it('exposes only the transitions declared in the table', () => {
    for (const state of STATES) {
      for (const event of EVENTS) {
        const expected = TRANSITIONS[state][event] ?? null;
        expect(nextState(state, event)).toBe(expected);
      }
    }
  });

  it('flags reconnect sources', () => {
    expect(isReconnect('RECONNECTING')).toBe(true);
    expect(isReconnect('DISCONNECTED')).toBe(true);
    expect(isReconnect('ACTIVE')).toBe(false);
    expect(isReconnect('CONNECTING')).toBe(false);
    expect(isReconnect('ENDED')).toBe(false);
  });
});
