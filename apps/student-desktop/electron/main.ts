/**
 * Electron main process. Owns:
 *  - the BrowserWindow (contextIsolation + sandbox, no nodeIntegration),
 *  - all network traffic (ApiClient), token storage (safeStorage),
 *  - the persisted reliable outbox (ReliableOutbox),
 *  - the ExamSession coordinator and its heartbeat loop,
 *  - OS/desktop monitors: window focus, display topology, network state.
 *
 * The renderer receives a minimal typed surface through preload and can never
 * reach Node, the filesystem, or arbitrary IPC channels.
 */
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, screen, session as electronSession, type Display } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { ApiClient } from './api';
import { ReliableOutbox } from './outbox';
import { ExamSession } from './session';
import {
  IPC,
  type AppInfo,
  type RendererAttemptState,
  type SensorEventPayload,
  type UserProfile,
} from '../src/shared/types';
import { throttled } from '../src/shared/sensors';
import pkg from '../package.json';

// E2E isolation: each automated run gets its own userData dir so persisted
// state (outbox, secure session) can never leak across runs/users and two
// overlapping runs cannot corrupt each other's on-disk state. Must run before
// any module-level service (ReliableOutbox reads its storage eagerly).
const e2eUserData = process.env.EXAMGUARD_E2E_USER_DATA;
if (e2eUserData) {
  try {
    app.setPath('userData', e2eUserData);
  } catch {
    // non-fatal — default location
  }
}

const API_URL = process.env.EXAMGUARD_API_URL ?? 'http://localhost:4000';
const IS_DEV = process.env.EXAMGUARD_DEV === '1';
const SMOKE_TEST = process.argv.includes('--smoke-test');
const E2E_TEST = process.env.EXAMGUARD_E2E === '1';
const RENDERER_DEV_URL = process.env.EXAMGUARD_RENDERER_URL ?? 'http://localhost:5173';
const APP_VERSION = pkg.version;

// E2E runs are headless validation: the window is never shown (below). GPU
// compositing stays ON by default because Chromium's Windows camera capture
// needs the hardware-accelerated Media Foundation frame-server path to share
// one webcam across concurrent publishers; the legacy software path is
// exclusive per process. RAM-constrained boxes can opt out with
// EXAMGUARD_E2E_NO_GPU=1 (camera/mic/screen then run on software paths, which
// limits concurrent camera sharing on this OS/driver).
if (E2E_TEST && process.env.EXAMGUARD_E2E_NO_GPU === '1') app.disableHardwareAcceleration();
// Windows: prefer the Media Foundation / WinRT frame-server video-capture
// paths, which let several processes share one webcam. The legacy DShow
// fallback is exclusive per process, which would make concurrent real-camera
// publishers impossible on a single-camera machine.
if (E2E_TEST && process.platform === 'win32') {
  app.commandLine.appendSwitch(
    'enable-features',
    'MediaFoundationVideoCapture,MediaFoundationVideoCaptureWinRT',
  );
}

// ---------------------------------------------------------------------------
// Secure token storage. safeStorage encrypts at rest with the OS keychain
// (DPAPI on Windows, Keychain on macOS). If encryption is unavailable we do
// NOT persist the session — a plaintext token file is never written.
// ---------------------------------------------------------------------------

function secureStorePath(): string {
  return path.join(app.getPath('userData'), 'secure-session.bin');
}

function saveRefreshToken(token: string | null): void {
  try {
    if (!token) {
      fs.rmSync(secureStorePath(), { force: true });
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.writeFileSync(secureStorePath(), safeStorage.encryptString(token));
  } catch {
    // Non-fatal: the session simply does not survive a restart.
  }
}

function loadRefreshToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(secureStorePath()));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Outbox persistence — metadata only, never recordings or media.
// ---------------------------------------------------------------------------

function outboxPath(): string {
  return path.join(app.getPath('userData'), 'outbox.json');
}

const outboxStorage = {
  read: () => {
    try {
      return fs.readFileSync(outboxPath(), 'utf8');
    } catch {
      return null;
    }
  },
  write: (json: string) => {
    try {
      fs.writeFileSync(outboxPath(), json, 'utf8');
    } catch {
      // Keep entries in memory on write failure.
    }
  },
};

// ---------------------------------------------------------------------------
// Shared services
// ---------------------------------------------------------------------------

const api = new ApiClient({ baseUrl: API_URL, loadRefreshToken, saveRefreshToken });

let networkOnline = true;

const outbox = new ReliableOutbox(outboxStorage, {
  deliver: async (entry) => {
    try {
      if (entry.kind === 'event') {
        await api.postProctoringEvent(entry.attemptId, entry.payload);
      } else {
        await api.saveAnswer(entry.attemptId, entry.payload.questionId, entry.payload.value);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[outbox] delivery failed for ${entry.kind} ${JSON.stringify(entry.payload).slice(0, 160)}: ${message}`);
      throw err;
    }
  },
}, {
  retryBaseMs: 2_000,
  retryMaxMs: 60_000,
  maxAttempts: 20,
  onStatus: (s) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.evQueue, { pending: s.pending, online: networkOnline });
    }
  },
});

let session: ExamSession | null = null;
let mainWindow: BrowserWindow | null = null;
let examModeActive = false;

function hasLiveAttempt(): boolean {
  return Boolean(session?.currentAttemptId && session?.attempt?.status === 'ACTIVE');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    title: 'ExamGuard Secure Exam',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: IS_DEV,
      // Hidden E2E windows must not throttle the capture/outbox timers.
      backgroundThrottling: !E2E_TEST,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!E2E_TEST) mainWindow?.show();
  });

  // --- window hardening --------------------------------------------------
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  if (!IS_DEV) {
    // Disable keyboard shortcuts that open devtools or reload.
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase();
      if (key === 'f12') event.preventDefault();
      if ((input.control || input.meta) && (key === 'r' || key === 'shift+r')) event.preventDefault();
    });
  }

  // Window close during a live attempt requires confirmation (and logs a focus
  // event — evidence, not accusation).
  mainWindow.on('close', (event) => {
    if (examModeActive && hasLiveAttempt()) {
      event.preventDefault();
      dialog
        .showMessageBox(mainWindow!, {
          type: 'warning',
          buttons: ['Stay in exam', 'Close application'],
          defaultId: 0,
          cancelId: 0,
          title: 'Exit secure exam?',
          message: 'Closing the application during an active exam will be recorded.',
        })
        .then(({ response }) => {
          if (response === 1) {
            examModeActive = false;
            mainWindow?.destroy();
          }
        });
    }
  });

  mainWindow.on('focus', () => {
    if (examModeActive && session?.currentAttemptId) {
      session.reportSensor({ type: 'EXAM_WINDOW_FOCUS_RESTORED', severity: 'INFO', detail: { source: 'window' } });
    }
  });
  mainWindow.on('blur', () => {
    if (examModeActive && session?.currentAttemptId) {
      session.reportSensor({ type: 'EXAM_WINDOW_LOST_FOCUS', severity: 'WARNING', detail: { source: 'window' } });
    }
  });

  // --- display topology monitoring ---------------------------------------
  const reportDisplays = (reason: string): void => {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    if (!session?.currentAttemptId) return;
    if (!throttled(`display:${reason}`, 2_000)) return;
    const detail: Record<string, unknown> = { reason, count: displays.length, primaryId: primary.id };
    if (displays.length > 1) {
      session.reportSensor({ type: 'MULTIPLE_DISPLAY_DETECTED', severity: 'WARNING', detail });
    } else {
      session.reportSensor({ type: 'DISPLAY_CHANGED', severity: 'INFO', detail });
    }
    // Tell the renderer device controller so a lost screen source is reacquired.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.evDisplayChange, true);
    }
  };
  screen.on('display-added', () => reportDisplays('display-added'));
  screen.on('display-removed', () => reportDisplays('display-removed'));
  screen.on('display-metrics-changed', (_event, _display: Display) => reportDisplays('metrics-changed'));

  // --- renderer loading ---------------------------------------------------
  if (IS_DEV) {
    void mainWindow.loadURL(RENDERER_DEV_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

// ---------------------------------------------------------------------------
// Network monitoring (main-process side). The outbox also flips state based
// on delivery outcomes; a periodic health poll catches silent stalls.
// ---------------------------------------------------------------------------

async function probeNetwork(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    const res = await fetch(`${API_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function networkLoop(): Promise<void> {
  const online = await probeNetwork();
  setNetworkOnline(online);
  setTimeout(() => void networkLoop(), 10_000);
}

function setNetworkOnline(online: boolean): void {
  if (online === networkOnline) return;
  networkOnline = online;
  outbox.setOnline(online);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.evNetwork, online);
    win.webContents.send(IPC.evQueue, { pending: outbox.pendingCount, online });
  }
  if (session?.currentAttemptId) {
    session.reportSensor({
      type: online ? 'NETWORK_RESTORED' : 'NETWORK_LOST',
      severity: online ? 'INFO' : 'WARNING',
      detail: { source: 'probe' },
    });
  }
}

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    return {
      appVersion: APP_VERSION,
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      osRelease: (process as { getSystemVersion?: () => string }).getSystemVersion
        ? (process as { getSystemVersion: () => string }).getSystemVersion()
        : '',
      userDataPath: app.getPath('userData'),
      displayCount: screen.getAllDisplays().length,
      lockDown: { fullscreen: examModeActive, devTools: IS_DEV },
    };
  });

  ipcMain.handle(IPC.authLogin, async (_event, { email, password }: { email: string; password: string }) => {
    const user = await session!.login(email, password);
    return { user };
  });

  ipcMain.handle(IPC.authLogout, async () => {
    await session!.logout();
    examModeActive = false;
  });

  ipcMain.handle(IPC.authStatus, async () => {
    // If a session was persisted, finish restoring it before answering, so the
    // renderer never flashes the login screen for an existing session.
    if (!session?.user && api.hasPersistedSession) {
      await session?.tryRestore();
    }
    return { loggedIn: Boolean(session?.user), user: session?.user ?? null };
  });

  ipcMain.handle(IPC.examsList, () => session!.listExams());
  ipcMain.handle(IPC.examGet, (_event, { examId }: { examId: string }) => session!.getExam(examId));

  ipcMain.handle(
    IPC.attemptStart,
    (
      _event,
      { examId, opts }: { examId: string; opts: { consent: Record<string, unknown>; deviceInfo: Record<string, unknown> } },
    ) => {
      const { consent, deviceInfo } = opts;
      return session!.start(examId, { ...consent, deviceInfo });
    },
  );

  ipcMain.handle(IPC.attemptGet, async (_event, { attemptId }: { attemptId: string }) => {
    const res = await api.getAttempt(attemptId);
    await session!.resumeExisting(attemptId);
    return res;
  });

  ipcMain.handle(
    IPC.answerSave,
    (_event, { attemptId, questionId, value }: { attemptId: string; questionId: string; value: unknown }) => {
      // Validate attempt ownership in the renderer-facing API only; the actual
      // server write happens via the outbox (idempotent upsert per question).
      session!.saveAnswer(questionId, value);
      return { remainingMs: session?.attempt?.remainingMs ?? 0 };
    },
  );

  ipcMain.handle(IPC.attemptHeartbeat, async (_event, { attemptId }: { attemptId: string }) => {
    const view = await session!.heartbeat(attemptId);
    return view;
  });

  ipcMain.handle(IPC.attemptSubmit, async (_event, { attemptId }: { attemptId: string }) => {
    if (session?.currentAttemptId !== attemptId) throw new Error('No active attempt for this id');
    const view = await session!.submit();
    examModeActive = false;
    return view;
  });

  ipcMain.handle(IPC.sensorReport, (_event, { payload }: { payload: SensorEventPayload }) => {
    const ok = session?.reportSensor(payload) ?? false;
    return { queued: ok };
  });

  ipcMain.handle(IPC.mediaSession, (_event, { update }: { update: Parameters<ExamSession['updateMediaSession']>[0] }) => {
    return session!.updateMediaSession(update).then(() => undefined);
  });

  // Short-lived SFU publisher credential — requested in the renderer by the
  // Phase 4B publisher, fetched here (main process) so tokens never touch the
  // network from the renderer and never enter the preload surface beyond this.
  ipcMain.handle(IPC.mediaToken, async (_event, { attemptId }: { attemptId: string }) => {
    const current = session?.currentAttemptId;
    if (!current || current !== attemptId) throw new Error('No active attempt for this id');
    return api.getMediaToken(attemptId);
  });

  ipcMain.handle(IPC.screenSources, async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      displayId: s.display_id || undefined,
    }));
  });

  ipcMain.handle(IPC.windowExamMode, (_event, { active }: { active: boolean }) => {
    examModeActive = active;
    if (mainWindow) {
      mainWindow.setFullScreen(active);
      mainWindow.setMenuBarVisibility(!active);
      if (active) mainWindow.focus();
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.evSecureMode, active);
    }
    return { fullscreen: active };
  });
}

// ---------------------------------------------------------------------------
// Media permissions. Our window only ever loads ExamGuard's own content
// (navigation and window.open are blocked), so 'media' is granted for that
// webContents. 'display-capture' stays denied until Phase 3C wires screens.
// ---------------------------------------------------------------------------

function installPermissionHandlers(): void {
  // 'media' covers camera/mic; 'display-capture' covers desktopCapturer screen
  // capture. Both are only ever granted to our own locked-down window.
  const allowedPermission = (permission: string, wc: Electron.WebContents | null): boolean =>
    (permission === 'media' || permission === 'display-capture') && wc === mainWindow?.webContents;
  electronSession.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowedPermission(permission, wc));
  });
  electronSession.defaultSession.setPermissionCheckHandler((wc, permission) => allowedPermission(permission, wc));
}

// ---------------------------------------------------------------------------
// Headless end-to-end: EXAMGUARD_E2E=1 + EXAMGUARD_E2E_EMAIL/_PASSWORD drives
// the REAL main-process stack (ApiClient, ExamSession, outbox) against a live
// backend: login -> assigned exams -> start attempt -> heartbeat -> submit.
// Used by the automated verification script; prints markers for assertions.
// ---------------------------------------------------------------------------

/**
 * Real-hardware probe executed INSIDE the app's renderer: getUserMedia for
 * camera + microphone, verifies actual (non-black) camera frames, returns a
 * serializable outcome. Media never leaves the machine.
 */
const MEDIA_PROBE_SNIPPET = `(async () => {
  const result = { camera: 'error', mic: 'error', cameraFrames: false };
  const gUM = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  if (!gUM) return { camera: 'unavailable', mic: 'unavailable', cameraFrames: false };
  const cls = (e) => (e && e.name) === 'NotAllowedError' ? 'denied' : (e && e.name) === 'NotFoundError' ? 'unavailable' : 'error';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
    result.camera = 'ok';
    try {
      const v = document.createElement('video');
      v.srcObject = s; v.muted = true; v.playsInline = true; v.width = 320; v.height = 240;
      await new Promise((res, rej) => { v.onloadedmetadata = res; setTimeout(() => rej(new Error('meta timeout')), 4000); });
      await v.play();
      await new Promise((r) => setTimeout(r, 400));
      const c = document.createElement('canvas'); c.width = 320; c.height = 240;
      const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, 320, 240);
      const data = ctx.getImageData(0, 0, 320, 240).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) { lit += 1; if (lit > 20) break; }
      }
      result.cameraFrames = lit > 20;
      v.srcObject = null;
    } catch { result.cameraFrames = false; }
    s.getTracks().forEach((t) => t.stop());
  } catch (e) { result.camera = cls(e); }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    result.mic = 'ok';
    s.getTracks().forEach((t) => t.stop());
  } catch (e) { result.mic = cls(e); }
  return result;
})()`;

function mediaSessionKind(kind: 'camera' | 'mic'): 'CAMERA' | 'MICROPHONE' {
  return kind === 'camera' ? 'CAMERA' : 'MICROPHONE';
}

/** Real whole-display capture probe run inside the renderer (never stored). */
const SCREEN_PROBE_SNIPPET = (sourceId: string): string => `(async () => {
  const result = { screen: 'error', screenFrames: false };
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: ${JSON.stringify(sourceId)},
          maxWidth: 1280,
          maxHeight: 720,
        },
      },
    });
    result.screen = 'ok';
    try {
      const v = document.createElement('video');
      v.srcObject = s; v.muted = true; v.playsInline = true; v.width = 320; v.height = 180;
      await new Promise((res, rej) => { v.onloadedmetadata = res; setTimeout(() => rej(new Error('meta timeout')), 4000); });
      await v.play();
      await new Promise((r) => setTimeout(r, 500));
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, 320, 180);
      const data = ctx.getImageData(0, 0, 320, 180).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) { lit += 1; if (lit > 20) break; }
      }
      result.screenFrames = lit > 20;
      v.srcObject = null;
    } catch { result.screenFrames = false; }
    s.getTracks().forEach((t) => t.stop());
  } catch (e) {
    result.screen = (e && e.name) === 'NotAllowedError' ? 'denied' : (e && e.name) === 'NotFoundError' ? 'unavailable' : 'error';
  }
  return result;
})()`;

async function probeScreenInRenderer(): Promise<{ screen: string; screenFrames: boolean; sourceName: string }> {
  if (!mainWindow) throw new Error('no window for screen probe');
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  if (sources.length === 0) {
    console.log('E2E_MEDIA_SCREEN {"screen":"unavailable","screenFrames":false,"source":"none"}');
    session!.updateMediaSession({ kind: 'SCREEN', status: 'FAILED' });
    return { screen: 'unavailable', screenFrames: false, sourceName: '' };
  }
  // DesktopCapturer returns the primary display first — the same selection
  // rule the exam controller uses (selectScreenSource).
  const primary = sources[0];
  const result = (await mainWindow.webContents.executeJavaScript(SCREEN_PROBE_SNIPPET(primary.id), true)) as {
    screen: string;
    screenFrames: boolean;
  };
  const summary = { ...result, sourceName: primary.name };
  console.log(`E2E_MEDIA_SCREEN ${JSON.stringify(summary)}`);
  if (result.screen === 'ok') {
    session!.reportSensor({ type: 'SCREEN_PERMISSION_GRANTED', severity: 'INFO', detail: { source: 'e2e-probe' } });
    session!.reportSensor({
      type: 'SCREEN_CAPTURE_STARTED',
      severity: 'INFO',
      detail: { source: 'e2e-probe', sourceName: primary.name, framesVerified: result.screenFrames },
    });
    await session!.updateMediaSession({ kind: 'SCREEN', status: 'ACTIVE' });
    // The probe releases its stream immediately — report the honest lifecycle.
    session!.reportSensor({
      type: 'SCREEN_CAPTURE_STOPPED',
      severity: 'INFO',
      detail: { source: 'e2e-probe', reason: 'probe-release' },
    });
    await session!.updateMediaSession({ kind: 'SCREEN', status: 'ENDED' });
  } else if (result.screen === 'denied') {
    session!.reportSensor({ type: 'SCREEN_PERMISSION_DENIED', severity: 'WARNING', detail: { source: 'e2e-probe' } });
    session!.updateMediaSession({ kind: 'SCREEN', status: 'FAILED' });
  } else {
    // Unavailable/generic failure: honest session state, no fake event.
    session!.updateMediaSession({ kind: 'SCREEN', status: 'FAILED' });
  }
  return summary;
}

async function runMediaProbe(): Promise<{
  camera: string;
  mic: string;
  cameraFrames: boolean;
  screen: string;
  screenFrames: boolean;
  screenSource: string;
}> {
  if (!mainWindow) throw new Error('no window for media probe');
  const result = (await mainWindow.webContents.executeJavaScript(MEDIA_PROBE_SNIPPET, true)) as {
    camera: string;
    mic: string;
    cameraFrames: boolean;
  };
  console.log(`E2E_MEDIA ${JSON.stringify(result)}`);

  // Each update is awaited so ACTIVE strictly precedes ENDED on the wire —
  // fire-and-forget PATCHes race and the server can apply them out of order.
  const reportDevice = async (kind: 'camera' | 'mic', state: string, frames: boolean): Promise<void> => {
    const isCamera = kind === 'camera';
    if (state === 'ok') {
      if (isCamera) {
        session!.reportSensor({ type: 'CAMERA_PERMISSION_GRANTED', severity: 'INFO', detail: { source: 'e2e-probe' } });
        session!.reportSensor({ type: 'CAMERA_CONNECTED', severity: 'INFO', detail: { source: 'e2e-probe', framesVerified: frames } });
      } else {
        session!.reportSensor({ type: 'MIC_PERMISSION_GRANTED', severity: 'INFO', detail: { source: 'e2e-probe' } });
        session!.reportSensor({ type: 'MIC_CONNECTED', severity: 'INFO', detail: { source: 'e2e-probe' } });
      }
      await session!.updateMediaSession({ kind: mediaSessionKind(kind), status: 'ACTIVE' });
    } else if (state === 'denied') {
      session!.reportSensor(
        isCamera
          ? { type: 'CAMERA_PERMISSION_DENIED', severity: 'WARNING', detail: { source: 'e2e-probe' } }
          : { type: 'MIC_PERMISSION_DENIED', severity: 'WARNING', detail: { source: 'e2e-probe' } },
      );
      await session!.updateMediaSession({ kind: mediaSessionKind(kind), status: 'FAILED' });
    } else {
      // Unavailable (no hardware) or generic error: no fake event, but record
      // the media session state honestly.
      await session!.updateMediaSession({ kind: mediaSessionKind(kind), status: 'FAILED' });
    }
  };
  await reportDevice('camera', result.camera, result.cameraFrames);
  await reportDevice('mic', result.mic, false);
  // The probe released its streams immediately; mark sessions ended.
  await session!.updateMediaSession({ kind: 'CAMERA', status: 'ENDED' });
  await session!.updateMediaSession({ kind: 'MICROPHONE', status: 'ENDED' });

  const screenResult = await probeScreenInRenderer();
  return {
    camera: result.camera,
    mic: result.mic,
    cameraFrames: result.cameraFrames,
    screen: screenResult.screen,
    screenFrames: screenResult.screenFrames,
    screenSource: screenResult.sourceName,
  };
}

/**
 * Phase 4B E2E leg — REAL renderer publisher → SFU.
 *
 * Flow: login (main) → reload renderer with E2E auto-drive flag → the REAL
 * App/ExamScreen starts the attempt, acquires camera/mic/screen through the
 * Phase 3 device controller, and publishes the existing streams to the SFU.
 * Main only observes (publisher state + SFU /status byte deltas), drains the
 * outbox, then submits and verifies SFU cleanup.
 */
async function runPublishE2E(
  examId: string,
  initialStep: string,
  fail: (message: string) => void,
  drainOutbox: (context: string, timeoutMs?: number) => Promise<boolean>,
): Promise<void> {
  let step = initialStep;
  const waitFor = async (pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 90_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await pred())) {
      if (Date.now() > deadline) {
        fail(`${what} timed out`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  };
  const rendererJs = async <T>(code: string): Promise<T | null> => {
    try {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return null;
      return (await win.webContents.executeJavaScript(code, true)) as T;
    } catch {
      return null;
    }
  };

  // TEMP DEBUG: forward renderer console so E2E failures are diagnosable.
  // Electron 44 passes an event object; legacy (level, message) args are kept
  // as a fallback.
  const onRendererConsole = (...args: unknown[]): void => {
    const first = args[0] as { level?: string | number; message?: string } | undefined;
    const level =
      typeof first?.level === 'string' ? first.level : String(first?.level ?? args[1] ?? 'log');
    const message =
      typeof first?.message === 'string' ? first.message : String(args[2] ?? '');
    const isSevere =
      level === 'error' || level === 'warning' || String(level) === '3' || String(level) === '2';
    if (isSevere || message.includes('[pub') || message.includes('e2e')) {
      console.log(`[renderer:${level}] ${message}`);
    }
  };
  mainWindow?.webContents.on('console-message' as never, onRendererConsole as never);

  // 1. Hand the renderer to auto-drive mode. will-navigate is blocked, so the
  //    reload must be main-initiated: set the flag, then re-load the page.
  step = 'publish-boot';
  await rendererJs(`sessionStorage.setItem('__examguardE2E','1'); true`);
  if (mainWindow) {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  await new Promise((resolve) => setTimeout(resolve, 4_000));

  // 2. Wait for the app (ExamScreen) to start the attempt itself.
  step = 'publish-attempt';
  await waitFor(
    () => session?.attempt?.status === 'ACTIVE' && session?.currentAttemptId != null,
    'renderer attempt start',
    60_000,
  );
  const attemptId = session!.currentAttemptId!;
  console.log(`E2E_MEDIA_PUBLISH attempt ${attemptId}`);

  // 3. Devices + publisher: all three real kinds published by the renderer.
  step = 'publish-producers';
  const uiText = await rendererJs<string>('document.body.innerText.slice(0, 500)');
  console.log(`E2E_MEDIA_PUBLISH ui ${JSON.stringify(uiText ?? '(none)')}`);
  await waitFor(async () => {
    const s = await rendererJs<{ state?: string; producers?: Array<{ kind: string }> }>(
      `(() => { const p = window.__examguardPub; if (!p) return null; const s = p.getState(); return s ? { state: s.state, producers: s.producers } : null; })()`,
    );
    if (!s || s.state !== 'publishing') return false;
    const kinds = new Set((s.producers ?? []).map((p) => p.kind));
    return kinds.has('camera') && kinds.has('microphone') && kinds.has('screen');
  }, 'renderer publisher with camera+mic+screen', Number(process.env.EXAMGUARD_E2E_PUBLISH_STARTUP_MS ?? 120_000));

  const pubSnapshot = await rendererJs<{ state?: string; producers?: Array<{ kind: string; producerId: string }> }>(
    `(() => { const p = window.__examguardPub; return p ? p.getState() : null; })()`,
  );
  console.log(
    `E2E_MEDIA_PUBLISH renderer ${JSON.stringify({ state: pubSnapshot?.state, producers: (pubSnapshot?.producers ?? []).map((p) => p.kind) })}`,
  );

  // 4. SFU-side proof: room exists for this attempt with 3 producers and live
  //    byte counters (camera/screen video producers must grow between samples).
  step = 'publish-sfu';
  const sfuHttp = (process.env.WEBRTC_SERVER_URL || 'ws://localhost:4010/sfu')
    .replace(/\/sfu$/, '')
    .replace(/^ws/, 'http');
  const sfuRooms = async (): Promise<
    Array<{ participantId: string; attemptId: string; producers: Array<{ appKind: string; bytesSent: number; bitrate: number }> }>
  > => {
    try {
      const res = await fetch(`${sfuHttp}/status`);
      if (!res.ok) return [];
      const body = (await res.json()) as { rooms?: Array<unknown> };
      return (body.rooms ?? []) as Array<{
        participantId: string;
        attemptId: string;
        producers: Array<{ appKind: string; bytesSent: number; bitrate: number }>;
      }>;
    } catch {
      return [];
    }
  };
  await waitFor(async () => {
    const rooms = await sfuRooms();
    const room = rooms.find((r) => r.attemptId === attemptId);
    if (!room) return false;
    const kinds = new Set(room.producers.map((p) => p.appKind));
    return kinds.has('camera') && kinds.has('microphone') && kinds.has('screen');
  }, 'SFU room with 3 producers', 90_000);

  const sample = async () => {
    const rooms = await sfuRooms();
    return rooms.find((r) => r.attemptId === attemptId) ?? null;
  };
  const first = await sample();
  // Give Chromium's encoders a real window to start sending RTP.
  await new Promise((resolve) => setTimeout(resolve, 6_500));
  const second = await sample();
  if (!first || !second) {
    fail('SFU room vanished between samples');
    return;
  }
  const bytesOf = (room: typeof first, kind: string): number =>
    room?.producers.find((p) => p.appKind === kind)?.bytesSent ?? 0;
  const cameraGrew = bytesOf(second, 'camera') > bytesOf(first, 'camera');
  const screenGrew = bytesOf(second, 'screen') > bytesOf(first, 'screen');
  const micPresent =
    first.producers.some((p) => p.appKind === 'microphone') && second.producers.some((p) => p.appKind === 'microphone');
  console.log(
    `E2E_MEDIA_PUBLISH sfu ${JSON.stringify({
      participantId: first.participantId,
      producers: first.producers.map((p) => ({ kind: p.appKind, bytes: p.bytesSent, kbps: p.bitrate })),
      cameraBytesGrew: cameraGrew,
      screenBytesGrew: screenGrew,
      micProducerPresent: micPresent,
    })}`,
  );
  if (!cameraGrew || !screenGrew || !micPresent) {
    fail('SFU did not observe growing camera/screen bytes and a mic producer');
    return;
  }

  // 5. Drain publisher lifecycle events, submit, verify SFU cleanup.
  step = 'publish-drain';
  if (!(await drainOutbox('publisher events', 30_000))) return;
  console.log('E2E_MEDIA_PUBLISH events-delivered');

  // Phase 4C cooperation: keep the attempt alive and publishing while an
  // external authorized monitor subscribes. Release = the hold file appears
  // (written by the monitor E2E after its verification + cleanup). The
  // publisher never exits the exam on its own during the hold.
  const holdFile = process.env.EXAMGUARD_E2E_PUBLISH_HOLD_FILE;
  const reconnectFile = process.env.EXAMGUARD_E2E_PUBLISH_RECONNECT_FILE;
  if (holdFile) {
    step = 'publish-hold';
    console.log('E2E_MEDIA_PUBLISH holding-for-subscriber');
    // Configurable so the 4D.3 10-student run (long barrier + measurement
    // window + monitor/reconnect/terminate legs) can extend the hold without
    // touching the default 5-minute budget used by 4C/4D.1/4D.2 E2Es.
    const holdMs = Number(process.env.EXAMGUARD_E2E_PUBLISH_HOLD_MS ?? 300_000);
    const holdDeadline = Date.now() + (Number.isFinite(holdMs) && holdMs > 0 ? holdMs : 300_000);
    let reconnectTriggered = false;
    while (!fs.existsSync(holdFile)) {
      // Controlled reconnect (Phase 4D.3): the orchestrator creates the
      // reconnect file mid-hold; the REAL MediaLink control socket is dropped
      // so the bounded reconnect path runs (ACTIVE → RECONNECTING → ACTIVE,
      // same participant). The renderer's SFU transport is untouched, so no
      // producers are duplicated and the monitor feed is uninterrupted.
      if (!reconnectTriggered && reconnectFile && fs.existsSync(reconnectFile)) {
        reconnectTriggered = true;
        step = 'publish-reconnect';
        console.log('E2E_MEDIA_PUBLISH reconnect-file-seen');
        const before = session!.mediaLink?.sessionInfo;
        session!.mediaLink?.dropConnectionForTest();
        const reconnectDeadline = Date.now() + 45_000;
        while (Date.now() < reconnectDeadline) {
          const link = session!.mediaLink;
          if (link?.stateValue === 'connected' && link.sessionInfo?.state === 'ACTIVE') {
            const after = link.sessionInfo;
            const sameParticipant =
              after?.participantId === before?.participantId && after?.id === before?.id;
            console.log(
              `E2E_MEDIA_PUBLISH reconnected ${JSON.stringify({
                mediaSessionId: after?.id,
                participantId: after?.participantId,
                state: after?.state,
                sameParticipant,
              })}`,
            );
            if (!sameParticipant) {
              fail('reconnect produced a different participant');
              return;
            }
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        step = 'publish-hold';
      }
      if (Date.now() > holdDeadline) {
        fail('publish hold file never appeared (monitor leg timed out)');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    console.log('E2E_MEDIA_PUBLISH hold-released');
  }

  step = 'publish-submit';
  const view = await session!.submit();
  console.log(`E2E_STEP submit ${view.status}`);
  if (view.status !== 'SUBMITTED' && view.status !== 'AUTO_SUBMITTED') {
    fail(`unexpected final status ${view.status}`);
    return;
  }

  step = 'publish-cleanup';
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const roomsAfter = await sfuRooms();
  const leftover = roomsAfter.find((r) => r.attemptId === attemptId);
  if (leftover) {
    fail(`SFU room still active after submit (${leftover.participantId})`);
    return;
  }
  console.log('E2E_MEDIA_PUBLISH sfu-clean');
}

async function runE2EFlow(): Promise<void> {
  let step = 'starting';
  const fail = (message: string): void => {
    console.error(`E2E_FAIL: ${message} (at step: ${step})`);
    app.exit(1);
  };
  // Fail-safe so a stalled flow can never leave an orphaned app alive.
  // Extended budget: the publish leg boots the renderer UI and real devices;
  // the Phase 4C hold leg adds an external monitor subscription window.
  const holdMsOverride = Number(process.env.EXAMGUARD_E2E_PUBLISH_HOLD_MS ?? 0);
  const failSafeMs = process.env.EXAMGUARD_E2E_PUBLISH_HOLD_FILE
    ? Number.isFinite(holdMsOverride) && holdMsOverride > 0
      ? holdMsOverride + 180_000
      : 480_000
    : 240_000;
  const failSafe = setTimeout(() => {
    console.error(`E2E_FAIL: flow stalled at step: ${step}`);
    app.exit(2);
  }, failSafeMs);
  const email = process.env.EXAMGUARD_E2E_EMAIL;
  const password = process.env.EXAMGUARD_E2E_PASSWORD;
  if (!email || !password) {
    fail('EXAMGUARD_E2E_EMAIL/_PASSWORD required');
    return;
  }

  /** Polls until the outbox is empty (server acked everything) or times out. */
  async function drainOutbox(context: string, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (outbox.pendingCount > 0) {
      if (Date.now() > deadline) {
        fail(`${context} was not acknowledged by the server (${outbox.pendingCount} queued)`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (outbox.pendingCount > 0) await outbox.pump();
    }
    return true;
  }
  try {
    step = 'login';
    const user = await session!.login(email, password);
    console.log(`E2E_STEP login ${user.email} role=${user.role}`);

    step = 'exams';
    const exams = await session!.listExams();
    console.log(`E2E_STEP exams ${exams.length}`);
    const exam = exams.find((e) => e.status === 'OPEN');
    if (!exam) {
      fail('no assigned OPEN exam');
      return;
    }

    // Phase 4B: the REAL renderer pipeline publishes to the SFU. The main
    // process hands control to the renderer (ExamScreen → device controller →
    // publisher) and only observes + verifies, then submits.
    if (process.env.EXAMGUARD_E2E_MEDIA_PUBLISH === '1') {
      await runPublishE2E(exam.id, step, fail, drainOutbox);
      clearTimeout(failSafe);
      app.exit(0);
      return;
    }

    step = 'start';
    const mediaEnabled = process.env.EXAMGUARD_E2E_MEDIA === '1';
    const started = await session!.start(exam.id, {
      camera: mediaEnabled,
      microphone: mediaEnabled,
      screen: false,
    });
    console.log(`E2E_STEP start ${started.attempt.status} remainingMs=${started.attempt.remainingMs} questions=${started.questions.length}`);
    if (started.attempt.remainingMs <= 0) {
      fail('server returned no remaining time');
      return;
    }

    // Save an answer through the reliable outbox and verify server delivery.
    const first = (started.questions as Array<{ id: string; options?: Array<{ id: string }> }>)[0];
    if (first) {
      const value = first.options?.[0]?.id ?? '42';
      step = 'answer';
      session!.saveAnswer(first.id, value);
      if (!(await drainOutbox('answer'))) return;
      console.log('E2E_STEP answer saved');
    }

    step = 'heartbeat';
    const live = await session!.heartbeat(started.attempt.id);
    console.log(`E2E_STEP heartbeat ${live.status}`);

    // Emit a real proctoring event through the outbox (same path the window
    // focus/display handlers use) and verify the server acknowledged it.
    step = 'proctoring-event';
    const queued = session!.reportSensor({
      type: 'EXAM_WINDOW_LOST_FOCUS',
      severity: 'WARNING',
      detail: { source: 'e2e' },
    });
    if (!queued) {
      fail('proctoring event was rejected by the validator');
      return;
    }
    if (!(await drainOutbox('proctoring event'))) return;
    console.log('E2E_STEP proctoring event delivered');

    // Phase 4A control-plane leg: EXAMGUARD_E2E_MEDIA_SIGNALING=1 drives the
    // REAL media-session REST + WebSocket gateway flow (no media transport):
    // create → join(CONNECTED) → duplicate rejected → drop → reconnect with the
    // SAME participant → idempotent end (ENDED).
    if (process.env.EXAMGUARD_E2E_MEDIA_SIGNALING === '1') {
      const waitFor = async (pred: () => boolean, what: string, timeoutMs = 20_000): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (!pred()) {
          if (Date.now() > deadline) fail(`${what} timed out`);
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      };
      step = 'media-signaling';
      const attemptId = started.attempt.id;
      const created = await api.createMediaSession(attemptId);
      console.log(`E2E_MEDIA_SIGNALING created ${JSON.stringify({ mediaSessionId: created.id, participantId: created.participantId, attemptId, state: created.state })}`);
      // Session creation must be idempotent (same row/participant returned).
      const createdAgain = await api.createMediaSession(attemptId);
      if (createdAgain.id !== created.id || createdAgain.participantId !== created.participantId) {
        fail('media session create was not idempotent');
      }
      console.log('E2E_MEDIA_SIGNALING create-idempotent');
      // The ExamSession auto-started a MediaLink when the attempt went ACTIVE;
      // wait for it to reach CONNECTED (join succeeded server-side).
      await waitFor(() => session!.mediaLink?.stateValue === 'connected', 'media link connect');
      const joinedInfo = session!.mediaLink!.sessionInfo;
      console.log(`E2E_MEDIA_SIGNALING joined ${JSON.stringify({ mediaSessionId: joinedInfo!.id, participantId: joinedInfo!.participantId, state: joinedInfo!.state })}`);

      // Duplicate live connection for the same attempt must be rejected (409).
      step = 'media-signaling-dup';
      const token = api.getAccessToken();
      const dupResult: { code: number } = await new Promise((resolve, reject) => {
        const sock = new WebSocket(api.mediaWsUrl);
        const timer = setTimeout(() => {
          sock.close();
          reject(new Error('duplicate ws did not respond'));
        }, 8_000);
        sock.on('open', () => {
          sock.send(JSON.stringify({ type: 'media-session-join', data: { token, attemptId } }));
        });
        sock.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw)) as { type: string; data?: { code: number } };
            if (msg.type === 'media-error' && msg.data?.code) {
              clearTimeout(timer);
              resolve({ code: msg.data.code });
              sock.close();
            }
            if (msg.type === 'joined') {
              clearTimeout(timer);
              reject(new Error('duplicate join unexpectedly succeeded'));
              sock.close();
            }
          } catch {
            // ignore
          }
        });
      });
      console.log(`E2E_MEDIA_SIGNALING duplicate-rejected ${JSON.stringify(dupResult)}`);

      // Drop the socket → bounded reconnect must restore the SAME participant.
      step = 'media-signaling-reconnect';
      session!.mediaLink!.dropConnectionForTest();
      await waitFor(
        () => session!.mediaLink?.stateValue === 'connected' && session!.mediaLink?.sessionInfo?.state === 'ACTIVE',
        'media link reconnect',
        30_000,
      );
      const after = session!.mediaLink!.sessionInfo!;
      if (after.participantId !== created.participantId || after.id !== created.id) {
        fail('reconnect produced a different participant (identity must be stable)');
      }
      console.log(`E2E_MEDIA_SIGNALING reconnected ${JSON.stringify({ mediaSessionId: after.id, participantId: after.participantId, state: after.state })}`);
      // The lifecycle events (MEDIA_SESSION_CREATED/CONNECTED/RECONNECTING/
      // RECONNECTED) travel through the ReliableOutbox → /proctoring/events.
      // Drain so the database carries the evidence before we end the session.
      if (!(await drainOutbox('media-signaling events'))) return;
      console.log('E2E_MEDIA_SIGNALING events-delivered');

      // Idempotent end: row lands in ENDED with endedAt.
      step = 'media-signaling-end';
      const ended = await api.endMediaSession(created.id);
      console.log(`E2E_MEDIA_SIGNALING ended ${JSON.stringify({ mediaSessionId: ended.id, state: ended.state, endedAt: ended.endedAt })}`);
      const endedAgain = await api.endMediaSession(created.id);
      if (endedAgain.state !== 'ENDED') fail('end was not idempotent');
      console.log('E2E_MEDIA_SIGNALING end-idempotent');
    }

    // Optional real-hardware leg: EXAMGUARD_E2E_MEDIA=1 probes the actual
    // camera/microphone inside the renderer and pushes REAL device state
    // through the same outbox -> /proctoring/events -> Postgres pipeline.
    if (process.env.EXAMGUARD_E2E_MEDIA === '1') {
      step = 'media-probe';
      try {
        await runMediaProbe();
      } catch (err) {
        fail(`media probe failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!(await drainOutbox('media events'))) return;
      console.log('E2E_STEP media events delivered');
    }

    step = 'submit';
    const view = await session!.submit();
    console.log(`E2E_STEP submit ${view.status}`);
    if (view.status !== 'SUBMITTED' && view.status !== 'AUTO_SUBMITTED') {
      fail(`unexpected final status ${view.status}`);
      return;
    }

    step = 'logout';
    await session!.logout();
    clearTimeout(failSafe);
    console.log('E2E_OK');
    app.exit(0);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Automated boot smoke test: `electron . --smoke-test` opens the real window,
// waits for the renderer to finish loading, prints a marker and exits.
// ---------------------------------------------------------------------------

function runSmokeTest(): void {
  const failTimer = setTimeout(() => {
    console.error('EXAMGUARD_SMOKE_FAIL: window did not become ready in time');
    app.exit(1);
  }, 30_000);
  const finish = (): void => {
    clearTimeout(failTimer);
    console.log('EXAMGUARD_SMOKE_OK');
    app.exit(0);
  };
  if (!mainWindow) {
    console.error('EXAMGUARD_SMOKE_FAIL: no window created');
    clearTimeout(failTimer);
    app.exit(1);
    return;
  }
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', () => setTimeout(finish, 800));
  } else {
    setTimeout(finish, 800);
  }
}

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

function wireSession(): void {
  session = new ExamSession({
    api,
    outbox,
    appVersion: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    osRelease: (process as { getSystemVersion?: () => string }).getSystemVersion
      ? (process as { getSystemVersion: () => string }).getSystemVersion()
      : '',
    onExitSecureMode: () => {
      examModeActive = false;
      if (mainWindow) mainWindow.setFullScreen(false);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.evSecureMode, false);
      }
    },
  });

  session.onAttempt((state: RendererAttemptState) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.evAttempt, state);
    }
  });

  void session.tryRestore().then((user) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.evSession, user);
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    installPermissionHandlers();
    wireSession();
    createWindow();
    if (SMOKE_TEST) runSmokeTest();
    if (E2E_TEST) {
      void session!.tryRestore().finally(() => {
        void runE2EFlow();
      });
    }
    void networkLoop();
    // Retry loop for anything still queued.
    setInterval(() => {
      if (networkOnline) void outbox.pump();
    }, 5_000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    void session?.release();
  });
}
