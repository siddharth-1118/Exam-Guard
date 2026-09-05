/**
 * Exam device lifecycle controller (Phase 3B camera+microphone, Phase 3C
 * screen capture). Pure logic, no DOM/Electron imports, so it runs under both
 * the renderer tsconfig and the node-based jest suite. All real media
 * acquisition is injected through `ExamDeviceEnv`.
 *
 * Behaviour:
 *  - after an attempt goes ACTIVE, start() acquires each consented/required
 *    device, reports the existing camera/mic/screen proctoring event types and
 *    mirrors status into the media-session upsert;
 *  - a lost source (track 'ended') raises the DISCONNECTED/STOPPED event (a
 *    security EVENT, not an accusation); a device-list or display-topology
 *    change triggers a bounded auto-reconnect that reports the recovery;
 *  - stop() (submit / terminate / unmount) releases every stream, marks the
 *    media sessions ENDED, and suppresses late 'ended' noise.
 */
import type { MediaSessionUpdate, SensorEventPayload } from './types';

export type DeviceKind = 'camera' | 'microphone' | 'screen';
export type SessionKind = 'CAMERA' | 'MICROPHONE' | 'SCREEN';
export type DeviceStatus = 'idle' | 'starting' | 'on' | 'off' | 'error';

export type AcquireOutcome =
  | { ok: true; deviceId?: string }
  | { ok: false; reason: 'denied' | 'unavailable' | 'error' };

export interface ExamDeviceEnv {
  /** Real acquisition — resolves ok only when a live stream exists. */
  acquire(kind: DeviceKind): Promise<AcquireOutcome>;
  /** Stops the live stream for a kind (idempotent). */
  release(kind: DeviceKind): void;
  /** Fired when the OS-level device goes away mid-stream. */
  onEnded(kind: DeviceKind, cb: () => void): void;
  /** Fired when the system device list changes (plug/unplug). Returns unsubscribe. */
  subscribeDeviceChange(cb: () => void): () => void;
  /** Fired when the display topology changes (screen reconnect/re-select). Returns unsubscribe. */
  subscribeDisplayChange(cb: () => void): () => void;
  /** Route an event into the existing proctoring pipeline (ReliableOutbox). */
  report(payload: SensorEventPayload): void;
  /** Mirror real device state into the media-session upsert. */
  updateSession(kind: SessionKind, status: MediaSessionUpdate['status']): void;
}

export interface ExamDeviceSnapshot {
  camera: DeviceStatus;
  microphone: DeviceStatus;
  screen: DeviceStatus;
  reason: Partial<Record<DeviceKind, string>>;
}

export interface ExamDeviceController {
  start(): void;
  stop(): void;
  enabled(kind: DeviceKind): boolean;
  snapshot(): ExamDeviceSnapshot;
  onStatus(cb: (snapshot: ExamDeviceSnapshot) => void): () => void;
}

interface KindMeta {
  event: {
    connected: string;
    disconnected: string;
    granted: string;
    denied: string;
  };
  sessionKind: SessionKind;
}

const META: Record<DeviceKind, KindMeta> = {
  camera: {
    event: {
      connected: 'CAMERA_CONNECTED',
      disconnected: 'CAMERA_DISCONNECTED',
      granted: 'CAMERA_PERMISSION_GRANTED',
      denied: 'CAMERA_PERMISSION_DENIED',
    },
    sessionKind: 'CAMERA',
  },
  microphone: {
    event: {
      connected: 'MIC_CONNECTED',
      disconnected: 'MIC_DISCONNECTED',
      granted: 'MIC_PERMISSION_GRANTED',
      denied: 'MIC_PERMISSION_DENIED',
    },
    sessionKind: 'MICROPHONE',
  },
  screen: {
    event: {
      connected: 'SCREEN_CAPTURE_STARTED',
      disconnected: 'SCREEN_CAPTURE_STOPPED',
      granted: 'SCREEN_PERMISSION_GRANTED',
      denied: 'SCREEN_PERMISSION_DENIED',
    },
    sessionKind: 'SCREEN',
  },
};

export interface CreateExamDeviceControllerOptions {
  env: ExamDeviceEnv;
  /** Devices to run — caller decides from exam settings + consent. */
  enabled: DeviceKind[];
  reconnectDelayMs?: number;
  reconnectMinGapMs?: number;
}

export function createExamDeviceController(opts: CreateExamDeviceControllerOptions): ExamDeviceController {
  const { env } = opts;
  const enabledKinds = new Set<DeviceKind>(opts.enabled);
  const reconnectDelayMs = opts.reconnectDelayMs ?? 500;
  const reconnectMinGapMs = opts.reconnectMinGapMs ?? 2_500;

  const IDLE_KINDS: Record<DeviceKind, 'idle'> = { camera: 'idle', microphone: 'idle', screen: 'idle' };
  const states: Record<DeviceKind, DeviceStatus> = { ...IDLE_KINDS };
  const reason: Partial<Record<DeviceKind, string>> = {};
  const grantedReported: Record<DeviceKind, boolean> = { camera: false, microphone: false, screen: false };
  const busy: Record<DeviceKind, boolean> = { camera: false, microphone: false, screen: false };
  const live: Record<DeviceKind, boolean> = { camera: false, microphone: false, screen: false };
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDeviceChange = 0;
  const statusCbs = new Set<(s: ExamDeviceSnapshot) => void>();
  const unsubs: Array<() => void> = [];

  function emitStatus(): void {
    const snapshot: ExamDeviceSnapshot = {
      camera: states.camera,
      microphone: states.microphone,
      screen: states.screen,
      reason: { ...reason },
    };
    for (const cb of statusCbs) cb(snapshot);
  }

  function setState(kind: DeviceKind, state: DeviceStatus): void {
    if (states[kind] === state) return;
    states[kind] = state;
    emitStatus();
  }

  async function startKind(kind: DeviceKind): Promise<void> {
    if (stopped || busy[kind] || states[kind] === 'starting' || states[kind] === 'on') return;
    busy[kind] = true;
    setState(kind, 'starting');
    env.updateSession(META[kind].sessionKind, 'CONNECTING');
    let outcome: AcquireOutcome;
    try {
      outcome = await env.acquire(kind);
    } catch {
      outcome = { ok: false, reason: 'error' };
    }
    if (stopped) {
      // Exam ended while the device was still opening — release whatever arrived.
      env.release(kind);
      busy[kind] = false;
      return;
    }
    busy[kind] = false;
    if (outcome.ok) {
      live[kind] = true;
      if (!grantedReported[kind]) {
        grantedReported[kind] = true;
        env.report({ type: META[kind].event.granted as SensorEventPayload['type'], severity: 'INFO', detail: {} });
      }
      env.report({
        type: META[kind].event.connected as SensorEventPayload['type'],
        severity: 'INFO',
        detail: outcome.deviceId ? { deviceId: outcome.deviceId } : {},
      });
      env.updateSession(META[kind].sessionKind, 'ACTIVE');
      setState(kind, 'on');
      delete reason[kind];
      env.onEnded(kind, () => handleEnded(kind));
    } else {
      env.updateSession(META[kind].sessionKind, 'FAILED');
      setState(kind, 'error');
      if (outcome.reason === 'denied') {
        reason[kind] = 'denied';
        env.report({ type: META[kind].event.denied as SensorEventPayload['type'], severity: 'WARNING', detail: {} });
      } else if (outcome.reason === 'unavailable') {
        reason[kind] = 'unavailable';
      } else {
        reason[kind] = 'error';
      }
    }
  }

  function handleEnded(kind: DeviceKind): void {
    if (stopped || !live[kind]) return;
    live[kind] = false;
    // The OS permission stays granted after an unplug; a reconnect only needs
    // the CONNECTED event, so grantedReported stays true.
    reason[kind] = 'disconnected';
    env.report({ type: META[kind].event.disconnected as SensorEventPayload['type'], severity: 'WARNING', detail: {} });
    env.updateSession(META[kind].sessionKind, 'FAILED');
    setState(kind, 'off');
  }

  /** Shared by device-list and display-topology changes: reacquire lost kinds. */
  function onAvailabilityChange(): void {
    if (stopped) return;
    const nowMs = Date.now();
    if (nowMs - lastDeviceChange < reconnectMinGapMs) return;
    lastDeviceChange = nowMs;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      for (const kind of enabledKinds) {
        if (states[kind] === 'off' || states[kind] === 'error') {
          void startKind(kind);
        }
      }
    }, reconnectDelayMs);
  }

  const controller: ExamDeviceController = {
    start(): void {
      stopped = false;
      unsubs.push(env.subscribeDeviceChange(onAvailabilityChange));
      unsubs.push(env.subscribeDisplayChange(onAvailabilityChange));
      emitStatus();
      for (const kind of enabledKinds) void startKind(kind);
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      while (unsubs.length) unsubs.pop()?.();
      for (const kind of enabledKinds) {
        if (live[kind] || states[kind] === 'starting' || states[kind] === 'on') {
          env.release(kind);
          env.updateSession(META[kind].sessionKind, 'ENDED');
        }
        live[kind] = false;
        busy[kind] = false;
        setState(kind, 'off');
      }
    },

    enabled(kind: DeviceKind): boolean {
      return enabledKinds.has(kind);
    },

    snapshot(): ExamDeviceSnapshot {
      return {
        camera: states.camera,
        microphone: states.microphone,
        screen: states.screen,
        reason: { ...reason },
      };
    },

    onStatus(cb: (s: ExamDeviceSnapshot) => void): () => void {
      statusCbs.add(cb);
      cb(controller.snapshot());
      return () => statusCbs.delete(cb);
    },
  };
  return controller;
}
