/**
 * Real media acquisition (Chromium getUserMedia + Electron desktopCapturer).
 * Device streams live only in the renderer; the main process receives status
 * events over the secure bridge. Every track is stopped on release.
 *
 * Phase 3B wires CAMERA + MICROPHONE through createBrowserExamEnv(); screen
 * capture stays available here for Phase 3C and is not enabled in the exam
 * session yet.
 */
import type { AcquireOutcome, DeviceKind, ExamDeviceEnv, SessionKind } from '../shared/deviceController';
import type { MediaSessionUpdate, ScreenSourceInfo, SensorEventPayload } from '../shared/types';
import { selectScreenSource } from '../shared/screenSource';

// Re-exported for convenience so consumers do not import two layers.
export type { DeviceKind } from '../shared/deviceController';

declare global {
  interface Window {
    examguard?: import('../shared/types').DesktopBridge;
  }
}

export type PermissionState = 'unknown' | 'granted' | 'denied' | 'unavailable';
export type CameraClassification = 'physical-integrated' | 'physical-external' | 'virtual' | 'unknown';

/** Known indicators for virtual camera software (case-insensitive regex). */
const VIRTUAL_CAMERA_REGEX =
  /(phone link|link to windows|windows phone|virtual camera|virtual|droidcam|obs|manycam|snap camera|xsplit|iriun|vcam|epoccam|camo|ivcam)/i;

/** Known indicators for built-in/integrated laptop webcams (case-insensitive regex). */
const BUILTIN_CAMERA_REGEX =
  /(integrated|built-in|builtin|internal|laptop|facetime|front|user facing)/i;

export function isVirtualCamera(label: string): boolean {
  if (!label) return false;
  return VIRTUAL_CAMERA_REGEX.test(label);
}

export function isBuiltInCamera(label: string): boolean {
  if (!label) return false;
  return BUILTIN_CAMERA_REGEX.test(label);
}

/**
 * Classifies a videoinput device using label heuristics.
 *
 * NOTE: Chromium and Windows do not expose a universal, guaranteed physical-vs-virtual
 * hardware flag on MediaDeviceInfo. Therefore, label heuristics serve as a deterministic
 * preference mechanism rather than an absolute hardware assertion.
 */
export function classifyCameraDevice(device: { kind?: string; label?: string }): CameraClassification {
  if (!device || (device.kind && device.kind !== 'videoinput')) {
    return 'unknown';
  }
  const label = device.label || '';
  if (!label) return 'unknown';

  if (VIRTUAL_CAMERA_REGEX.test(label)) {
    return 'virtual';
  }
  if (BUILTIN_CAMERA_REGEX.test(label)) {
    return 'physical-integrated';
  }
  if (/(hd camera|hd webcam|fhd camera|usb camera|webcam|c920|brio|logitech|usb video|video device|camera)/i.test(label)) {
    return 'physical-external';
  }
  return 'unknown';
}

/**
 * Deterministic camera selection strategy:
 *  1. FIRST: If userSelectedDeviceId is provided and exists in videoinputs, return that exact device.
 *  2. Priority 1: physical-integrated
 *  3. Priority 2: physical-external
 *  4. Priority 3: unknown
 *  5. Virtual cameras: DO NOT automatically select them (return null -> unavailable state).
 */
export function selectPreferredCamera(
  devices: MediaDeviceInfo[] | Array<{ deviceId: string; kind: string; label: string }>,
  userSelectedDeviceId?: string,
): MediaDeviceInfo | null {
  const videoInputs = devices.filter((d) => d.kind === 'videoinput') as MediaDeviceInfo[];
  if (videoInputs.length === 0) return null;

  // 1. Explicit user override
  if (userSelectedDeviceId) {
    const matched = videoInputs.find((d) => d.deviceId === userSelectedDeviceId);
    if (matched) return matched;
  }

  // Classify devices
  const classified = videoInputs.map((device) => ({
    device,
    classification: classifyCameraDevice(device),
  }));

  // Priority 1: physical-integrated
  const integrated = classified.find((c) => c.classification === 'physical-integrated');
  if (integrated) return integrated.device;

  // Priority 2: physical-external
  const external = classified.find((c) => c.classification === 'physical-external');
  if (external) return external.device;

  // Priority 3: unknown (unclassified, but not virtual)
  const unknownPhysical = classified.find((c) => c.classification === 'unknown');
  if (unknownPhysical) return unknownPhysical.device;

  // Virtual cameras are NOT selected automatically
  return null;
}

/** A live device stream owned by the renderer. */
export interface LiveMedia {
  kind: DeviceKind;
  /** The underlying stream — used by the Phase 4B publisher (never leaves the device). */
  stream: MediaStream;
  stop(): void;
  onEnded(cb: () => void): void;
}

export type DeviceAcquireResult =
  | { ok: true; handle: LiveMedia; deviceId?: string; label?: string }
  | { ok: false; reason: 'denied' | 'unavailable' | 'error' };

const MIC_CONSTRAINTS: MediaStreamConstraints = { audio: true, video: false };

function reasonFromError(err: unknown): 'denied' | 'unavailable' | 'error' {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'unavailable';
  return 'error';
}

function makeHandle(kind: DeviceKind, stream: MediaStream): LiveMedia {
  let endedCb: (() => void) | null = null;
  const track = (kind === 'microphone' ? stream.getAudioTracks() : stream.getVideoTracks())[0];
  const onTrackEnded = (): void => endedCb?.();
  if (track) track.addEventListener('ended', onTrackEnded);
  return {
    kind,
    stream,
    stop: () => {
      endedCb = null; // suppress 'ended' callbacks for intentional stops
      stream.getTracks().forEach((t) => t.stop());
      if (track) track.removeEventListener('ended', onTrackEnded);
    },
    onEnded: (cb: () => void) => {
      endedCb = cb;
    },
  };
}

export async function acquireDevice(
  kind: DeviceKind,
  selectedDeviceId?: string,
): Promise<DeviceAcquireResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: 'unavailable' };
  }
  if (kind === 'microphone') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      const handle = makeHandle(kind, stream);
      const deviceId = stream.getAudioTracks()[0]?.getSettings().deviceId;
      return { ok: true, handle, deviceId };
    } catch (err) {
      return { ok: false, reason: reasonFromError(err) };
    }
  }

  // Camera acquisition with physical webcam preference
  try {
    let devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    let videoInputs = devices.filter((d) => d.kind === 'videoinput');

    // Handle unpopulated device labels (pre-permission in Chromium)
    if (videoInputs.length === 0 || videoInputs.every((d) => !d.label)) {
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tempStream.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        videoInputs = devices.filter((d) => d.kind === 'videoinput');
      } catch (err) {
        return { ok: false, reason: reasonFromError(err) };
      }
    }

    const selectedCamera = selectPreferredCamera(videoInputs, selectedDeviceId);
    if (!selectedCamera) {
      return { ok: false, reason: 'unavailable' };
    }

    const cameraConstraints: MediaStreamConstraints = {
      audio: false,
      video: {
        deviceId: { exact: selectedCamera.deviceId },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(cameraConstraints);
    } catch (err) {
      // Fallback: If exact device failed and no user override was set, try another physical camera
      if (!selectedDeviceId && videoInputs.length > 1) {
        const remaining = videoInputs.filter((d) => d.deviceId !== selectedCamera.deviceId);
        const fallback = selectPreferredCamera(remaining);
        if (fallback) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              deviceId: { exact: fallback.deviceId },
              width: { ideal: 640 },
              height: { ideal: 480 },
            },
          });
        } else {
          return { ok: false, reason: reasonFromError(err) };
        }
      } else {
        return { ok: false, reason: reasonFromError(err) };
      }
    }

    const handle = makeHandle('camera', stream);
    const actualTrack = stream.getVideoTracks()[0];
    const actualDeviceId = actualTrack?.getSettings().deviceId ?? selectedCamera.deviceId;
    const actualLabel = selectedCamera.label || actualTrack?.label || 'Camera';
    const classification = classifyCameraDevice(selectedCamera);
    const selectionReason = selectedDeviceId
      ? 'user_selected'
      : classification === 'physical-integrated'
      ? 'preferred_integrated'
      : classification === 'physical-external'
      ? 'preferred_external'
      : 'unknown_fallback';

    console.log('[camera] CAMERA_DEVICE_SELECTED', {
      deviceId: actualDeviceId ? actualDeviceId.slice(0, 8) + '...' : 'unknown',
      label: actualLabel,
      classification,
      selectionReason,
    });

    return { ok: true, handle, deviceId: actualDeviceId, label: actualLabel };
  } catch (err) {
    return { ok: false, reason: reasonFromError(err) };
  }
}

/** Enumerate available camera devices with classification metadata. */
export async function getAvailableCameras(): Promise<
  Array<{
    deviceId: string;
    label: string;
    classification: CameraClassification;
    isVirtual: boolean;
    isBuiltIn: boolean;
    isPreferred: boolean;
  }>
> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  let videoInputs = devices.filter((d) => d.kind === 'videoinput');

  if (videoInputs.length === 0 || videoInputs.every((d) => !d.label)) {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tempStream.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      videoInputs = devices.filter((d) => d.kind === 'videoinput');
    } catch {}
  }

  const preferred = selectPreferredCamera(videoInputs);
  return videoInputs.map((d) => {
    const classification = classifyCameraDevice(d);
    return {
      deviceId: d.deviceId,
      label: d.label || `Camera (${d.deviceId.slice(0, 6)})`,
      classification,
      isVirtual: classification === 'virtual',
      isBuiltIn: classification === 'physical-integrated',
      isPreferred: preferred?.deviceId === d.deviceId,
    };
  });
}

/**
 * Adapter from the real DOM/Chromium media APIs to the pure ExamDeviceEnv the
 * controller consumes. Keeps at most one live handle per kind; release()
 * always stops it.
 */
export interface BrowserEnvDeps {
  report(payload: SensorEventPayload): void;
  updateSession(kind: SessionKind, status: MediaSessionUpdate['status']): void;
  selectedCameraId?: string;
}

export interface BrowserExamEnv extends ExamDeviceEnv {
  /** The live stream for a started kind, or null when not running. */
  stream(kind: DeviceKind): MediaStream | null;
  dispose(): void;
}

export function createBrowserExamEnv(deps: BrowserEnvDeps): BrowserExamEnv {
  const live = new Map<DeviceKind, LiveMedia>();
  const endedCbs = new Map<DeviceKind, () => void>();

  const env: BrowserExamEnv = {
    async acquire(kind: DeviceKind): Promise<AcquireOutcome> {
      if (live.has(kind)) live.get(kind)!.stop();
      // Screen capture is a different real path (Electron desktopCapturer +
      // a chromeMediaSource getUserMedia) than camera/microphone.
      const res =
        kind === 'screen'
          ? await acquireScreenSource()
          : await acquireDevice(kind, deps.selectedCameraId);
      if (res.ok) {
        live.set(kind, res.handle);
        const cb = endedCbs.get(kind);
        if (cb) res.handle.onEnded(cb);
        return { ok: true, deviceId: res.deviceId, label: res.label };
      }
      return { ok: false, reason: res.reason };
    },

    release(kind: DeviceKind): void {
      const h = live.get(kind);
      if (h) {
        h.stop();
        live.delete(kind);
      }
    },

    onEnded(kind: DeviceKind, cb: () => void): void {
      endedCbs.set(kind, cb);
      const h = live.get(kind);
      if (h) h.onEnded(cb);
    },

    subscribeDeviceChange(cb: () => void): () => void {
      const onchange = (): void => cb();
      navigator.mediaDevices?.addEventListener?.('devicechange', onchange);
      return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onchange);
    },

    subscribeDisplayChange(cb: () => void): () => void {
      // Display-topology changes are observed in the main process and pushed
      // over the secure bridge (window.examguard.onDisplayChange).
      if (typeof window.examguard?.onDisplayChange !== 'function') return () => undefined;
      return window.examguard.onDisplayChange(cb);
    },

    stream: (kind) => {
      const h = live.get(kind);
      return h ? h.stream : null;
    },

    report: (payload) => deps.report(payload),
    updateSession: (kind, status) => deps.updateSession(kind, status),

    dispose(): void {
      for (const kind of Array.from(live.keys())) env.release(kind);
      endedCbs.clear();
    },
  };
  return env;
}

/** Mirrors mic/camera presence without opening the devices. */
export async function probeAvailability(): Promise<{
  cameraCount: number;
  micCount: number;
  cameraPermission: PermissionState;
  micPermission: PermissionState;
}> {
  let cameraCount = 0;
  let micCount = 0;
  if (navigator.mediaDevices?.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      cameraCount = devices.filter((d) => d.kind === 'videoinput').length;
      micCount = devices.filter((d) => d.kind === 'audioinput').length;
    } catch {
      // fall through
    }
  }
  return {
    cameraCount,
    micCount,
    cameraPermission: cameraCount > 0 ? 'unknown' : 'unavailable',
    micPermission: micCount > 0 ? 'unknown' : 'unavailable',
  };
}

/** One-shot preflight check for a device: acquire, verify, release. */
export async function preflightDevice(
  kind: DeviceKind,
  selectedDeviceId?: string,
): Promise<AcquireOutcome> {
  const res = await acquireDevice(kind, selectedDeviceId);
  if (res.ok) {
    res.handle.stop();
    return { ok: true, deviceId: res.deviceId, label: res.label };
  }
  return { ok: false, reason: res.reason };
}

/** Simple RMS level (0..1) from a mic stream, for AUDIO_LEVEL reporting. */
export function attachLevelMeter(
  stream: MediaStream,
  cb: (level: number) => void,
  everyMs = 250,
): () => void {
  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const id = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      cb(Math.min(1, Math.sqrt(sum / buf.length)));
    }, everyMs);
    return () => {
      clearInterval(id);
      void ctx.close();
    };
  } catch {
    return () => undefined;
  }
}

/**
 * REAL whole-display capture through Electron desktopCapturer (Phase 3C).
 * The target display is chosen deterministically (primary first) and the
 * capture is never transmitted or stored.
 */
export async function acquireScreenSource(): Promise<DeviceAcquireResult> {
  try {
    const sources: ScreenSourceInfo[] = await window.examguard!.listScreenSources();
    const picked = selectScreenSource(sources);
    if (!picked) return { ok: false, reason: 'unavailable' };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: picked.source.id,
          maxWidth: 1280,
          maxHeight: 720,
        },
      } as unknown as MediaTrackConstraints,
    });
    const handle = makeHandle('screen', stream);
    return { ok: true, handle, deviceId: picked.source.id };
  } catch (err) {
    return { ok: false, reason: reasonFromError(err) };
  }
}

/** One-shot preflight check: acquire the selected display, verify, release. */
export async function preflightScreenSource(): Promise<AcquireOutcome> {
  const res = await acquireScreenSource();
  if (res.ok) {
    res.handle.stop();
    return { ok: true, deviceId: res.deviceId };
  }
  return { ok: false, reason: res.reason };
}
