import { decideSweep } from './sweep.decide';

const LEASE = 90_000;
const NOW = 1_000_000_000_000;

function base(over: Partial<Parameters<typeof decideSweep>[0]> = {}): Parameters<typeof decideSweep>[0] {
  return {
    state: 'ACTIVE',
    attemptTerminal: false,
    live: false,
    lastSeenAt: NOW - 1_000,
    now: NOW,
    leaseMs: LEASE,
    ...over,
  };
}

describe('decideSweep — attempt-terminal cleanup', () => {
  it('ends CONNECTING/ACTIVE/RECONNECTING rows when the attempt is terminal, even with live presence', () => {
    for (const state of ['CONNECTING', 'ACTIVE', 'RECONNECTING'] as const) {
      const d = decideSweep(base({ state, attemptTerminal: true, live: true, lastSeenAt: NOW }));
      expect(d).toEqual({ action: 'end', reason: 'attempt-terminal' });
    }
  });
});

describe('decideSweep — live presence wins', () => {
  it('never sweeps a row with a live gateway connection, however old the record', () => {
    const d = decideSweep(base({ live: true, lastSeenAt: NOW - 3_600_000 }));
    expect(d.action).toBe('none');
  });
});

describe('decideSweep — stale lease walk', () => {
  it('leaves a fresh ACTIVE row alone (within lease)', () => {
    expect(decideSweep(base({ lastSeenAt: NOW - 1_000 })).action).toBe('none');
  });

  it('moves a stale ACTIVE row to RECONNECTING (never straight to dead)', () => {
    const d = decideSweep(base({ lastSeenAt: NOW - LEASE - 1 }));
    expect(d).toEqual({ action: 'reconnecting', reason: 'stale-no-presence' });
  });

  it('moves a stale RECONNECTING row to DISCONNECTED', () => {
    const d = decideSweep(base({ state: 'RECONNECTING', lastSeenAt: NOW - LEASE - 1 }));
    expect(d).toEqual({ action: 'disconnected', reason: 'stale-no-presence' });
  });

  it('keeps a RECONNECTING row inside its grace window', () => {
    expect(decideSweep(base({ state: 'RECONNECTING', lastSeenAt: NOW - 10_000 })).action).toBe('none');
  });

  it('fails a CONNECTING row that never joined within the lease', () => {
    const d = decideSweep(base({ state: 'CONNECTING', lastSeenAt: NOW - LEASE - 1 }));
    expect(d).toEqual({ action: 'failed', reason: 'join-timeout' });
  });

  it('treats unknown lastSeenAt as stale (crash before any activity was recorded)', () => {
    expect(decideSweep(base({ state: 'ACTIVE', lastSeenAt: null })).action).toBe('reconnecting');
  });
});
