import {
  ALL_RECORDING_EVENTS,
  ALL_RECORDING_STATUSES,
  assertTransition,
  canTransition,
  nextRecordingStatus,
  type RecordingEvent,
  type RecordingStatus,
} from './state';

describe('recording state machine (pure)', () => {
  it('accepts every documented transition', () => {
    expect(nextRecordingStatus('PENDING', 'start')).toBe('RECORDING');
    expect(nextRecordingStatus('RECORDING', 'finalize')).toBe('FINALIZING');
    expect(nextRecordingStatus('FINALIZING', 'markReady')).toBe('READY');
    expect(nextRecordingStatus('PENDING', 'fail')).toBe('FAILED');
    expect(nextRecordingStatus('RECORDING', 'fail')).toBe('FAILED');
    expect(nextRecordingStatus('FINALIZING', 'fail')).toBe('FAILED');
    expect(nextRecordingStatus('PENDING', 'delete')).toBe('DELETED'); // cancel before start
    expect(nextRecordingStatus('READY', 'delete')).toBe('DELETED');
    expect(nextRecordingStatus('FAILED', 'delete')).toBe('DELETED'); // cleanup of junk
  });

  it('rejects every invalid transition (full matrix)', () => {
    const valid: Array<[RecordingStatus, RecordingEvent]> = [
      ['PENDING', 'start'],
      ['PENDING', 'fail'],
      ['PENDING', 'delete'],
      ['RECORDING', 'finalize'],
      ['RECORDING', 'fail'],
      ['FINALIZING', 'markReady'],
      ['FINALIZING', 'fail'],
      ['READY', 'delete'],
      ['FAILED', 'delete'],
    ];
    for (const from of ALL_RECORDING_STATUSES) {
      for (const event of ALL_RECORDING_EVENTS) {
        const expected = valid.some(([f, e]) => f === from && e === event);
        expect(canTransition(from, event)).toBe(expected);
        expect(nextRecordingStatus(from, event) !== null).toBe(expected);
        if (!expected) {
          expect(() => assertTransition(from, event)).toThrow(/Invalid recording transition/);
        }
      }
    }
  });

  it('never transitions out of DELETED', () => {
    for (const event of ALL_RECORDING_EVENTS) {
      expect(canTransition('DELETED', event)).toBe(false);
    }
  });

  it('never marks a recording READY without FINALIZING', () => {
    expect(nextRecordingStatus('PENDING', 'markReady')).toBeNull();
    expect(nextRecordingStatus('RECORDING', 'markReady')).toBeNull();
    expect(nextRecordingStatus('READY', 'markReady')).toBeNull();
  });

  it('does not allow restart after failure or deletion', () => {
    expect(nextRecordingStatus('FAILED', 'start')).toBeNull();
    expect(nextRecordingStatus('DELETED', 'start')).toBeNull();
  });

  it('does not allow finalize from a state other than RECORDING', () => {
    expect(nextRecordingStatus('PENDING', 'finalize')).toBeNull();
    expect(nextRecordingStatus('FINALIZING', 'finalize')).toBeNull();
    expect(nextRecordingStatus('READY', 'finalize')).toBeNull();
  });
});