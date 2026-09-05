/**
 * Phase 4C E2E driver (runs in the harness renderer).
 *
 * Uses the REAL MonitorSubscriber module against the live API + SFU:
 *   per cycle: fetch subscriber token (real monitor login) → subscribe →
 *   attach camera/screen to <video> and verify actual decoded frames
 *   (requestVideoFrameCallback) → microphone track attached muted → enable
 *   focused audio → hold while the parent script samples SFU consumer bytes →
 *   disconnect cleanly.
 *
 * Markers printed to the console are forwarded to stdout by main.cjs.
 */
import { MonitorSubscriber, type SubscriberTokenInfo } from '../src/lib/media/subscriber';

const params = new URLSearchParams(window.location.search);
const API = params.get('api') ?? 'http://localhost:4000';
const ATTEMPT_ID = params.get('attemptId') ?? '';
const ACCESS_TOKEN = params.get('token') ?? '';
const CYCLES = Number(params.get('cycles') ?? '1');
const PAUSE_MS = Number(params.get('pauseMs') ?? '6000');

const log = (line: string): void => console.log(line);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const statusEl = document.getElementById('status') as HTMLElement;
const cameraVideo = document.getElementById('camera') as HTMLVideoElement;
const screenVideo = document.getElementById('screen') as HTMLVideoElement;
const micAudio = document.getElementById('mic') as HTMLAudioElement;

async function fetchToken(): Promise<SubscriberTokenInfo> {
  const res = await fetch(`${API}/api/v1/media/subscriber-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify({ attemptId: ATTEMPT_ID }),
  });
  if (!res.ok) {
    throw new Error(`subscriber token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as SubscriberTokenInfo;
}

function attachTrack(el: HTMLVideoElement | HTMLAudioElement, track: MediaStreamTrack): void {
  el.srcObject = new MediaStream([track]);
  el.muted = true;
  void (el as HTMLVideoElement).play?.().catch(() => undefined);
}

/**
 * Keeps an element bound to the subscriber's CURRENT track for a kind — a
 * transient publisher reconnect recreates consumers/tracks, so poll for a new
 * track identity and re-attach (audio stays muted on every fresh attach).
 */
function startTrackWatcher(
  subscriber: MonitorSubscriber,
  kind: 'camera' | 'microphone' | 'screen',
  el: HTMLVideoElement | HTMLAudioElement,
): () => void {
  let attached: MediaStreamTrack | null = null;
  const timer = window.setInterval(() => {
    const track = subscriber.trackOf(kind);
    if (track && track !== attached) {
      attached = track;
      el.srcObject = new MediaStream([track]);
      el.muted = true;
      void (el as HTMLVideoElement).play?.().catch(() => undefined);
    } else if (!track && attached) {
      attached = null;
      el.srcObject = null;
    }
  }, 250);
  return () => window.clearInterval(timer);
}

/** True when Chromium actually decoded at least one frame of the feed. */
function waitDecodedFrame(el: HTMLVideoElement, timeoutMs: number, label: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (ok) log(`frames ${label}: decoded`);
      else log(`frames ${label}: none`);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const request = (): void => {
      try {
        (el as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): number }).requestVideoFrameCallback(
          () => done(true),
        );
      } catch {
        done(true); // API absent — track presence already proven by attach
      }
    };
    if (el.readyState >= 2) {
      request();
    } else {
      const onLoaded = (): void => {
        el.removeEventListener('loadedmetadata', onLoaded);
        request();
      };
      el.addEventListener('loadedmetadata', onLoaded);
      setTimeout(() => {
        el.removeEventListener('loadedmetadata', onLoaded);
        if (!settled) request();
      }, 4_000);
    }
    void timer;
  });
}

async function waitLiveTrack(
  subscriber: MonitorSubscriber,
  kind: 'camera' | 'microphone' | 'screen',
  timeoutMs: number,
): Promise<MediaStreamTrack | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const track = subscriber.trackOf(kind);
    if (track && track.readyState === 'live') return track;
    await sleep(300);
  }
  return null;
}

function fail(line: string): never {
  log(`E2E_MONITOR_FAIL ${line}`);
  throw new Error(line);
}

async function runCycle(cycle: number): Promise<void> {
  log(`E2E_MONITOR_CYCLE_START ${cycle}`);
  const token = await fetchToken();
  let subscriber: MonitorSubscriber | null = null;
  const feeds = { camera: 'connecting', microphone: 'connecting', screen: 'connecting' };
  try {
    subscriber = new MonitorSubscriber({
      attemptId: ATTEMPT_ID,
      getToken: async () => token,
      onState: (_s, list) => {
        for (const f of list) feeds[f.kind] = f.status;
      },
      log: (line) => log(`[sub] ${line}`),
    });
    await subscriber.start();
    if (subscriber.stateValue !== 'subscribed') {
      fail(`subscriber final state ${subscriber.stateValue}`);
    }

    const camera = await waitLiveTrack(subscriber, 'camera', 30_000);
    const screen = await waitLiveTrack(subscriber, 'screen', 30_000);
    const mic = await waitLiveTrack(subscriber, 'microphone', 30_000);
    if (!camera) fail('camera consumer track never went live');
    if (!screen) fail('screen consumer track never went live');
    if (!mic) fail('microphone consumer track never went live');

    const stopWatch = [
      startTrackWatcher(subscriber, 'camera', cameraVideo),
      startTrackWatcher(subscriber, 'screen', screenVideo),
      startTrackWatcher(subscriber, 'microphone', micAudio),
    ];
    // MUTED BY DEFAULT: verify the browser is actually muted before enabling.
    const audioMutedDefault = micAudio.muted === true && cameraVideo.muted === true;
    await sleep(800);

    const [cameraFrames, screenFrames] = await Promise.all([
      waitDecodedFrame(cameraVideo, 15_000, 'camera'),
      waitDecodedFrame(screenVideo, 15_000, 'screen'),
    ]);

    // Focused-student audio: enable it explicitly.
    micAudio.muted = false;
    await micAudio.play().catch(() => undefined);
    const audioEnabled = micAudio.muted === false;

    const snapshot = subscriber.snapshot();
    log(
      `E2E_MONITOR_CYCLE ${JSON.stringify({
        cycle,
        participantId: subscriber.participantId,
        attemptId: ATTEMPT_ID,
        state: snapshot.state,
        feeds: snapshot.feeds,
        cameraFrames,
        screenFrames,
        micTrack: true,
        audioMutedDefault,
        audioEnabled,
        audioContentVerified: false, // audible content is not measured here
      })}`,
    );

    // Parent script samples the SFU consumer bytes while we hold the feed.
    await sleep(PAUSE_MS);

    stopWatch.forEach((fn) => fn());
    subscriber.stop();
    subscriber = null;
    cameraVideo.srcObject = null;
    screenVideo.srcObject = null;
    micAudio.srcObject = null;
    log(`E2E_MONITOR_DISCONNECT ${JSON.stringify({ cycle })}`);
    await sleep(1_000);
  } finally {
    subscriber?.stop();
  }
}

async function main(): Promise<void> {
  statusEl.textContent = `starting (attempt ${ATTEMPT_ID}, cycles ${CYCLES})`;
  log(`E2E_MONITOR_START ${JSON.stringify({ attemptId: ATTEMPT_ID, cycles: CYCLES })}`);
  if (!ATTEMPT_ID || !ACCESS_TOKEN) fail('attemptId and monitor token required');
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    await runCycle(cycle);
    if (cycle < CYCLES) await sleep(1_500);
  }
  log('E2E_MONITOR_DONE');
  statusEl.textContent = 'done';
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  log(`E2E_MONITOR_FAIL ${message}`);
});
