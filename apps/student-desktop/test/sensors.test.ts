/** Sensor vocabulary tests: validation, idempotency keys, throttling. */
import {
  defaultSeverity,
  throttled,
  toQueuedEvent,
  validateSensorPayload,
} from '../src/shared/sensors';

describe('sensor vocabulary', () => {
  it('accepts known event types and fills defaults', () => {
    const res = validateSensorPayload({ type: 'CAMERA_CONNECTED' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.severity).toBe('INFO');
      expect(res.payload.detail).toEqual({});
    }
  });

  it('rejects unknown types, bad severities and non-object details', () => {
    expect(validateSensorPayload({ type: 'PHONE_DETECTED' }).ok).toBe(false); // AI vocabulary is not client-reportable
    expect(validateSensorPayload({ type: 'EXAM_WINDOW_LOST_FOCUS', severity: 'FATAL' }).ok).toBe(false);
    expect(validateSensorPayload({ type: 'EXAM_WINDOW_LOST_FOCUS', detail: [1, 2] }).ok).toBe(false);
    expect(validateSensorPayload('nope').ok).toBe(false);
  });

  it('assigns WARNING default severity to focus loss', () => {
    expect(defaultSeverity('EXAM_WINDOW_LOST_FOCUS')).toBe('WARNING');
    expect(defaultSeverity('NETWORK_RESTORED')).toBe('INFO');
  });

  it('toQueuedEvent attaches a stable clientEventId and timestamp', () => {
    const event = toQueuedEvent({ type: 'DISPLAY_CHANGED', detail: { count: 1 } }, 1_700_000_000_000);
    expect(event.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(event.type).toBe('DISPLAY_CHANGED');
  });

  it('throttles repeated high-frequency reports within a window', () => {
    let now = 0;
    expect(throttled('audio', 2_000, now)).toBe(true);
    expect(throttled('audio', 2_000, now + 500)).toBe(false);
    expect(throttled('audio', 2_000, now + 1_999)).toBe(false);
    expect(throttled('audio', 2_000, now + 2_000)).toBe(true);
    // Different keys are independent
    expect(throttled('focus', 2_000, now + 500)).toBe(true);
  });
});
