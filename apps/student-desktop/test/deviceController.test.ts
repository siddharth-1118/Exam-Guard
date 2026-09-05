/**
 * ExamDeviceController unit tests — camera/microphone (Phase 3B) and screen
 * capture (Phase 3C) lifecycle against a mocked device environment: grant,
 * deny, unavailable, disconnect/stop, reconnect on device/display change,
 * stop/release and session mirrors.
 */
import {
  createExamDeviceController,
  type AcquireOutcome,
  type DeviceKind,
  type ExamDeviceController,
  type ExamDeviceEnv,
} from '../src/shared/deviceController';
import type { SensorEventPayload } from '../src/shared/types';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function makeHarness(enabled: DeviceKind[] = ['camera', 'microphone']) {
  const report = jest.fn();
  const updateSession = jest.fn();
  const deviceChanges: Array<() => void> = [];
  const displayChanges: Array<() => void> = [];
  const endedCbs = new Map<DeviceKind, () => void>();
  const released: DeviceKind[] = [];

  const outcomes: Record<DeviceKind, () => Promise<AcquireOutcome>> = {
    camera: async () => ({ ok: true, deviceId: 'cam-1' }),
    microphone: async () => ({ ok: true, deviceId: 'mic-1' }),
    screen: async () => ({ ok: true, deviceId: 'screen:0:0' }),
  };
  const acquireSpy: Record<DeviceKind, jest.Mock> = {
    camera: jest.fn(() => outcomes.camera()),
    microphone: jest.fn(() => outcomes.microphone()),
    screen: jest.fn(() => outcomes.screen()),
  };

  const env: ExamDeviceEnv = {
    acquire: (kind) => acquireSpy[kind](),
    release: (kind) => {
      released.push(kind);
      endedCbs.delete(kind);
    },
    onEnded: (kind, cb) => {
      endedCbs.set(kind, cb);
    },
    subscribeDeviceChange: (cb) => {
      deviceChanges.push(cb);
      return () => {
        const i = deviceChanges.indexOf(cb);
        if (i >= 0) deviceChanges.splice(i, 1);
      };
    },
    subscribeDisplayChange: (cb) => {
      displayChanges.push(cb);
      return () => {
        const i = displayChanges.indexOf(cb);
        if (i >= 0) displayChanges.splice(i, 1);
      };
    },
    report: (payload) => report(payload),
    updateSession: (kind, status) => updateSession(kind, status),
  };

  let controller: ExamDeviceController = null as never;
  controller = createExamDeviceController({ env, enabled, reconnectDelayMs: 0, reconnectMinGapMs: 0 });

  const types = (): string[] => report.mock.calls.map((c) => (c[0] as SensorEventPayload).type);

  return {
    controller,
    report,
    types,
    updateSession,
    deviceChanges,
    displayChanges,
    endedCbs,
    outcomes,
    acquireSpy,
    released,
    env,
  };
}

describe('ExamDeviceController — camera/microphone (Phase 3B)', () => {
  it('starts both devices, reports grant+connected and mirrors ACTIVE sessions', async () => {
    const h = makeHarness();
    h.controller.onStatus(() => undefined);
    h.controller.start();
    await flush();

    expect(h.types()).toEqual([
      'CAMERA_PERMISSION_GRANTED',
      'CAMERA_CONNECTED',
      'MIC_PERMISSION_GRANTED',
      'MIC_CONNECTED',
    ]);
    expect(h.updateSession).toHaveBeenCalledWith('CAMERA', 'ACTIVE');
    expect(h.updateSession).toHaveBeenCalledWith('MICROPHONE', 'ACTIVE');
    expect(h.controller.snapshot()).toMatchObject({ camera: 'on', microphone: 'on' });
  });

  it('reports denial, marks the device error and does not emit connected', async () => {
    const h = makeHarness(['camera']);
    h.outcomes.camera = async () => ({ ok: false, reason: 'denied' });

    h.controller.start();
    await flush();

    expect(h.types()).toEqual(['CAMERA_PERMISSION_DENIED']);
    expect(h.updateSession).toHaveBeenCalledWith('CAMERA', 'FAILED');
    expect(h.controller.snapshot()).toMatchObject({ camera: 'error', reason: { camera: 'denied' } });
  });

  it('treats an unavailable device as error without a permission event', async () => {
    const h = makeHarness(['microphone']);
    h.outcomes.microphone = async () => ({ ok: false, reason: 'unavailable' });

    h.controller.start();
    await flush();

    expect(h.types()).toEqual([]);
    expect(h.controller.snapshot()).toMatchObject({ microphone: 'error', reason: { microphone: 'unavailable' } });
  });

  it('treats a thrown acquire as a generic error and still fails the session', async () => {
    const h = makeHarness(['camera']);
    h.outcomes.camera = async () => {
      throw new Error('boom');
    };

    h.controller.start();
    await flush();

    expect(h.types()).toEqual([]);
    expect(h.controller.snapshot().camera).toBe('error');
    expect(h.updateSession).toHaveBeenCalledWith('CAMERA', 'FAILED');
  });

  it('raises DISCONNECTED when the live device ends and reconnects on device change', async () => {
    const h = makeHarness(['camera']);
    h.controller.start();
    await flush();
    expect(h.controller.snapshot().camera).toBe('on');

    h.endedCbs.get('camera')!();
    expect(h.types().slice(-1)[0]).toBe('CAMERA_DISCONNECTED');
    expect(h.updateSession).toHaveBeenLastCalledWith('CAMERA', 'FAILED');
    expect(h.controller.snapshot().camera).toBe('off');

    h.deviceChanges.forEach((cb) => cb());
    await flush();
    expect(h.controller.snapshot().camera).toBe('on');
    const types = h.types();
    expect(types.filter((t) => t === 'CAMERA_CONNECTED')).toHaveLength(2);
    expect(types.filter((t) => t === 'CAMERA_PERMISSION_GRANTED')).toHaveLength(1);
    expect(h.updateSession).toHaveBeenLastCalledWith('CAMERA', 'ACTIVE');
  });

  it('suppresses duplicate disconnects while already off', async () => {
    const h = makeHarness(['camera']);
    h.controller.start();
    await flush();
    h.endedCbs.get('camera')!();
    h.endedCbs.get('camera')!();
    expect(h.types().filter((t) => t === 'CAMERA_DISCONNECTED')).toHaveLength(1);
  });

  it('stop() releases every device, marks sessions ENDED and ignores later changes', async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();

    h.controller.stop();
    expect(new Set(h.released)).toEqual(new Set(['camera', 'microphone']));
    expect(h.updateSession).toHaveBeenCalledWith('CAMERA', 'ENDED');
    expect(h.updateSession).toHaveBeenCalledWith('MICROPHONE', 'ENDED');

    const before = h.acquireSpy.camera.mock.calls.length;
    h.deviceChanges.forEach((cb) => cb());
    h.displayChanges.forEach((cb) => cb());
    await flush();
    expect(h.acquireSpy.camera.mock.calls.length).toBe(before);
  });

  it('only starts the kinds the exam enabled', async () => {
    const h = makeHarness(['camera']);
    h.controller.start();
    await flush();
    expect(h.controller.snapshot().camera).toBe('on');
    expect(h.controller.snapshot().microphone).toBe('idle');
    expect(h.controller.snapshot().screen).toBe('idle');
    expect(h.acquireSpy.microphone).not.toHaveBeenCalled();
    expect(h.acquireSpy.screen).not.toHaveBeenCalled();
  });
});

describe('ExamDeviceController — screen capture (Phase 3C)', () => {
  it('starts screen capture, reports grant + SCREEN_CAPTURE_STARTED and ACTIVE session', async () => {
    const h = makeHarness(['screen']);
    h.controller.start();
    await flush();

    expect(h.types()).toEqual(['SCREEN_PERMISSION_GRANTED', 'SCREEN_CAPTURE_STARTED']);
    expect(h.updateSession).toHaveBeenCalledWith('SCREEN', 'ACTIVE');
    expect(h.controller.snapshot().screen).toBe('on');
    expect(h.controller.snapshot().camera).toBe('idle');
  });

  it('reports SCREEN_PERMISSION_DENIED and FAILED session on denial', async () => {
    const h = makeHarness(['screen']);
    h.outcomes.screen = async () => ({ ok: false, reason: 'denied' });

    h.controller.start();
    await flush();

    expect(h.types()).toEqual(['SCREEN_PERMISSION_DENIED']);
    expect(h.updateSession).toHaveBeenCalledWith('SCREEN', 'FAILED');
    expect(h.controller.snapshot()).toMatchObject({ screen: 'error', reason: { screen: 'denied' } });
  });

  it('treats missing screen sources as unavailable without a fake event', async () => {
    const h = makeHarness(['screen']);
    h.outcomes.screen = async () => ({ ok: false, reason: 'unavailable' });

    h.controller.start();
    await flush();

    expect(h.types()).toEqual([]);
    expect(h.controller.snapshot()).toMatchObject({ screen: 'error', reason: { screen: 'unavailable' } });
  });

  it('raises SCREEN_CAPTURE_STOPPED on unexpected track end and reacquires on display change', async () => {
    const h = makeHarness(['screen']);
    h.controller.start();
    await flush();
    expect(h.controller.snapshot().screen).toBe('on');

    // User/system stops sharing — capture track ends.
    h.endedCbs.get('screen')!();
    expect(h.types().slice(-1)[0]).toBe('SCREEN_CAPTURE_STOPPED');
    expect(h.updateSession).toHaveBeenLastCalledWith('SCREEN', 'FAILED');
    expect(h.controller.snapshot().screen).toBe('off');

    // Display topology changed (monitor unplugged/replugged) — reacquire.
    h.displayChanges.forEach((cb) => cb());
    await flush();
    expect(h.controller.snapshot().screen).toBe('on');
    const types = h.types();
    expect(types.filter((t) => t === 'SCREEN_CAPTURE_STARTED')).toHaveLength(2);
    expect(types.filter((t) => t === 'SCREEN_PERMISSION_GRANTED')).toHaveLength(1); // permission persists
    expect(h.updateSession).toHaveBeenLastCalledWith('SCREEN', 'ACTIVE');
  });

  it('release on stop(): screen session ENDED, source released, no reconnect work', async () => {
    const h = makeHarness(['screen']);
    h.controller.start();
    await flush();

    h.controller.stop();
    expect(h.released).toContain('screen');
    expect(h.updateSession).toHaveBeenCalledWith('SCREEN', 'ENDED');
    expect(h.controller.snapshot().screen).toBe('off');

    const before = h.acquireSpy.screen.mock.calls.length;
    h.displayChanges.forEach((cb) => cb());
    await flush();
    expect(h.acquireSpy.screen.mock.calls.length).toBe(before);
  });
});

describe('ExamDeviceController — mixed devices', () => {
  it('runs camera, microphone AND screen together with independent states', async () => {
    const h = makeHarness(['camera', 'microphone', 'screen']);
    h.controller.onStatus(() => undefined);
    h.controller.start();
    await flush();

    expect(h.types()).toEqual([
      'CAMERA_PERMISSION_GRANTED',
      'CAMERA_CONNECTED',
      'MIC_PERMISSION_GRANTED',
      'MIC_CONNECTED',
      'SCREEN_PERMISSION_GRANTED',
      'SCREEN_CAPTURE_STARTED',
    ]);
    const snap = h.controller.snapshot();
    expect(snap.camera).toBe('on');
    expect(snap.microphone).toBe('on');
    expect(snap.screen).toBe('on');

    // Screen dies but camera/mic keep running independently.
    h.endedCbs.get('screen')!();
    expect(h.controller.snapshot()).toMatchObject({ camera: 'on', microphone: 'on', screen: 'off' });
    expect(h.types().slice(-1)[0]).toBe('SCREEN_CAPTURE_STOPPED');

    h.controller.stop();
    // Screen already ended (no live stream left to release); camera/mic released.
    expect(new Set(h.released)).toEqual(new Set(['camera', 'microphone']));
    expect(h.controller.snapshot().screen).toBe('off');
  });
});

