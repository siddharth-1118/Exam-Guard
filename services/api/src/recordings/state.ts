/**
 * Recording lifecycle state machine (Phase 5). Pure functions — no I/O, so the
 * full transition matrix is unit-testable without a database or storage.
 *
 *   PENDING --start--> RECORDING --finalize--> FINALIZING --markReady--> READY
 *      |  \\                                                  |
 *      |   `------ delete ------------------------------------> DELETED
 *      |                                                       |
 *      `--fail---> FAILED -----------------------------------> DELETED
 *
 * Any transition that is not listed is invalid and must be rejected by
 * callers (the DB row never changes on an invalid transition).
 */

export type RecordingStatus =
  | 'PENDING'
  | 'RECORDING'
  | 'FINALIZING'
  | 'READY'
  | 'FAILED'
  | 'DELETED';

export type RecordingEvent = 'start' | 'finalize' | 'markReady' | 'fail' | 'delete';

const TRANSITIONS: Record<RecordingStatus, Partial<Record<RecordingEvent, RecordingStatus>>> = {
  PENDING: { start: 'RECORDING', fail: 'FAILED', delete: 'DELETED' },
  RECORDING: { finalize: 'FINALIZING', fail: 'FAILED' },
  FINALIZING: { markReady: 'READY', fail: 'FAILED' },
  READY: { delete: 'DELETED' },
  FAILED: { delete: 'DELETED' },
  DELETED: {},
};

export const ALL_RECORDING_STATUSES = Object.keys(TRANSITIONS) as RecordingStatus[];
export const ALL_RECORDING_EVENTS = [
  'start',
  'finalize',
  'markReady',
  'fail',
  'delete',
] as const satisfies readonly RecordingEvent[];

/** Returns the resulting status for a legal transition, or null if invalid. */
export function nextRecordingStatus(
  from: RecordingStatus,
  event: RecordingEvent,
): RecordingStatus | null {
  return TRANSITIONS[from]?.[event] ?? null;
}

export function canTransition(from: RecordingStatus, event: RecordingEvent): boolean {
  return nextRecordingStatus(from, event) !== null;
}

export function assertTransition(
  from: RecordingStatus,
  event: RecordingEvent,
): RecordingStatus {
  const next = nextRecordingStatus(from, event);
  if (!next) {
    throw new Error(`Invalid recording transition: ${from} -> ${event}`);
  }
  return next;
}