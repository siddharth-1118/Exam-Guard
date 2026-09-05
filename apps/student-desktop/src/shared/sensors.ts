/**
 * Sensor vocabulary (no Electron/Node imports — unit-testable).
 * Mirrors the backend ProctoringEventType enum so the renderer cannot invent
 * event types and the main process validates before enqueueing.
 */
import type { ProctoringEventType, Severity } from '@examguard/types';
import type { QueuedEvent, SensorEventPayload } from './types';

export const SENSOR_EVENT_TYPES: readonly ProctoringEventType[] = [
  'FACE_DETECTED',
  'FACE_MISSING',
  'MULTIPLE_FACES',
  'FACE_PARTIALLY_VISIBLE',
  'CAMERA_BLOCKED',
  'CAMERA_CONNECTED',
  'CAMERA_DISCONNECTED',
  'CAMERA_PERMISSION_GRANTED',
  'CAMERA_PERMISSION_DENIED',
  'CAMERA_PERMISSION_REVOKED',
  'CAMERA_DEVICE_CHANGED',
  'MIC_CONNECTED',
  'MIC_DISCONNECTED',
  'MIC_MUTED',
  'MIC_UNMUTED',
  'MIC_PERMISSION_GRANTED',
  'MIC_PERMISSION_DENIED',
  'MIC_PERMISSION_REVOKED',
  'AUDIO_LEVEL',
  'SCREEN_CAPTURE_STARTED',
  'SCREEN_CAPTURE_STOPPED',
  'SCREEN_PERMISSION_GRANTED',
  'SCREEN_PERMISSION_DENIED',
  'SCREEN_PERMISSION_REVOKED',
  'DISPLAY_CHANGED',
  'MULTIPLE_DISPLAY_DETECTED',
  'EXAM_WINDOW_LOST_FOCUS',
  'EXAM_WINDOW_FOCUS_RESTORED',
  'NETWORK_LOST',
  'NETWORK_RESTORED',
  'MEDIA_SESSION_CREATED',
  'MEDIA_CONNECTED',
  'MEDIA_DISCONNECTED',
  'MEDIA_RECONNECTING',
  'MEDIA_RECONNECTED',
  'MEDIA_FAILED',
  'MEDIA_PUBLISHER_CONNECTING',
  'MEDIA_PUBLISHER_CONNECTED',
  'MEDIA_PUBLISHER_RECONNECTING',
  'MEDIA_PUBLISHER_RECONNECTED',
  'MEDIA_PUBLISHER_DISCONNECTED',
  'MEDIA_PUBLISHER_FAILED',
  'TRACK_PUBLISHED',
  'TRACK_UNPUBLISHED',
] as const;

const SEVERITIES: readonly Severity[] = ['INFO', 'WARNING', 'CRITICAL'];

export type ValidateResult =
  | { ok: true; payload: SensorEventPayload }
  | { ok: false; error: string };

export function validateSensorPayload(input: unknown): ValidateResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'payload must be an object' };
  }
  const raw = input as Record<string, unknown>;
  const type = raw.type;
  if (typeof type !== 'string' || !(SENSOR_EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `unknown sensor event type: ${String(type)}` };
  }
  const severity = raw.severity === undefined ? 'INFO' : raw.severity;
  if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) {
    return { ok: false, error: `invalid severity: ${String(severity)}` };
  }
  const detail =
    raw.detail === undefined
      ? {}
      : typeof raw.detail === 'object' && raw.detail !== null && !Array.isArray(raw.detail)
        ? (raw.detail as Record<string, unknown>)
        : null;
  if (detail === null) return { ok: false, error: 'detail must be an object' };
  return { ok: true, payload: { type: type as ProctoringEventType, severity: severity as Severity, detail } };
}

/** Default severity for an event type when the caller does not supply one. */
export function defaultSeverity(type: ProctoringEventType): Severity {
  if (type === 'EXAM_WINDOW_LOST_FOCUS') return 'WARNING';
  return 'INFO';
}

/** Builds the idempotent queue record for an event. */
export function toQueuedEvent(payload: SensorEventPayload, now = Date.now()): QueuedEvent {
  const id = nextId(now);
  return {
    type: payload.type,
    severity: payload.severity ?? defaultSeverity(payload.type),
    detail: payload.detail ?? {},
    clientEventId: id,
    createdAt: new Date(now).toISOString(),
  };
}

/** Throttles noisy high-frequency events (e.g. AUDIO_LEVEL) to one per window. */
export function throttled(
  key: string,
  windowMs: number,
  now = Date.now(),
): boolean {
  const state = throttledState();
  const last = state.get(key);
  if (last !== undefined && now - last < windowMs) return false;
  state.set(key, now);
  return true;
}

function nextId(now: number): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `evt-${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// module-level dedupe map (fine for a single-process main; not needed in renderer)
let throttleMap: Map<string, number> | null = null;
function throttledState(): Map<string, number> {
  if (!throttleMap) throttleMap = new Map<string, number>();
  return throttleMap;
}
