/**
 * ExamGuard Phase 4C.2 — Monitor Live View UI E2E.
 *
 * Drives the REAL Monitor Web application (Next.js) in a real browser engine
 * (Electron/Chromium) end to end against the live API + SFU + Postgres:
 *
 *   login (real form) → assigned exam → monitoring board → student A detail
 *     → REAL camera/screen frames decode in the live panel
 *     → microphone muted by default → Enable audio (focused student)
 *     → switch to student B (active attempt, no secure-desktop session)
 *       → A's SFU consumers cleaned, B shows a settled unavailable state
 *     → back to A → fresh subscription (no accumulation), audio muted again
 *     → terminate A from the real UI modal → server-side cleanup drains the SFU
 *
 * A REAL student publisher (Electron renderer: camera + microphone + screen →
 * mediasoup) is held open so the monitor consumes actual media. The lower-level
 * `scripts/media-monitor-e2e.mjs` infrastructure test remains separate.
 *
 * Prereqs: API :4000, SFU :4010, dev Postgres :5433, real camera/mic/display,
 * monitor-web built (`next build`). Usage: node scripts/monitor-live-view-e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const requireRoot = createRequire(path.join(ROOT, 'package.json'));
const requireApp = (p) => createRequire(path.join(ROOT, 'apps', p, 'package.json'));

const explicitDbUrl = process.env.DATABASE_URL ?? null;
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no root .env — defaults below
}
if (!explicitDbUrl) delete process.env.DATABASE_URL;

const API = process.env.EXAMGUARD_API_URL || 'http://localhost:4000';
const SFU_HTTP = (process.env.WEBRTC_SERVER_URL || 'ws://localhost:4010').replace(/^ws/, 'http');
const JWT_SECRET =
  process.env.EXAMGUARD_JWT_SECRET ?? process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me';
const PASSWORD = 'ExamGuard!Desktop2026';
const STAMP = Date.now().toString(36);
const uniq = (p) => `${p}-${STAMP}@examguard.test`;
const HOLD_FILE = path.join(ROOT, '.tmp-4c2-hold');
const UI_PORT = Number(process.env.E2E_UI_PORT || 3210);
const UI_BASE = `http://127.0.0.1:${UI_PORT}`;
const USER_DATA_DIR = path.join(ROOT, `.tmp-ui-userdata-${STAMP}`);
const UI_USER_DATA_DIR = path.join(ROOT, `.tmp-ui-harness-${STAMP}`);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kills leftover ExamGuard Electron processes from earlier runs (shared
 * hardware: a zombie publisher holds the camera and breaks the next run). */
function killLeftoverElectron() {
  const ps = `Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'student-desktop|monitor-web' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 20_000 });
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
const log = (m) => console.log(m);

async function jsonFetch(url, { method = 'GET', token, body, ok = false } = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok && !ok) {
    throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return { status: res.status, body: parsed };
}

async function waitFor(what, fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await SLEEP(intervalMs);
  }
}

async function makeOrg() {
  const reg = await jsonFetch('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: uniq('liveview-admin'),
      password: PASSWORD,
      firstName: 'LiveView',
      lastName: 'Admin',
      organizationName: `LiveView ${STAMP}`,
    },
  });
  const adminToken = reg.body.accessToken;
  const exam = (
    await jsonFetch('/api/v1/exams', {
      method: 'POST',
      token: adminToken,
      body: {
        name: `LiveView exam ${STAMP}`,
        durationMinutes: 20,
        maxAttempts: 1,
        autoSubmit: true,
        status: 'OPEN',
        settings: {
          cameraRequired: true,
          microphoneRequired: true,
          screenMonitoringRequired: true,
          identityVerificationRequired: false,
          aiProctoringEnabled: false,
        },
      },
    })
  ).body;
  const mk = async (label, code) => {
    const s = (
      await jsonFetch('/api/v1/students', {
        method: 'POST',
        token: adminToken,
        body: {
          email: uniq(`liveview-${label}`),
          password: PASSWORD,
          firstName: `Live${label.toUpperCase()}`,
          lastName: 'Student',
          studentCode: code,
        },
      })
    ).body;
    return s;
  };
  const studentA = await mk('a', `LVA-${STAMP.toUpperCase().slice(-6)}`);
  const studentB = await mk('b', `LVB-${STAMP.toUpperCase().slice(-6)}`);
  const monitor = (
    await jsonFetch('/api/v1/monitors', {
      method: 'POST',
      token: adminToken,
      body: {
        email: uniq('liveview-monitor'),
        password: PASSWORD,
        firstName: 'Live',
        lastName: 'Monitor',
      },
    })
  ).body;
  await jsonFetch(`/api/v1/exams/${exam.id}/students`, {
    method: 'POST',
    token: adminToken,
    body: { studentIds: [studentA.id, studentB.id] },
  });
  await jsonFetch(`/api/v1/exams/${exam.id}/monitors`, {
    method: 'POST',
    token: adminToken,
    body: { monitorIds: [monitor.id] },
  });
  return { adminToken, exam, studentA, studentB, monitorEmail: monitor.email };
}

async function login(email) {
  const r = await jsonFetch('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  return r.body.accessToken;
}

async function sfuRooms() {
  const res = await fetch(`${SFU_HTTP}/status`);
  const json = await res.json();
  return json.rooms ?? [];
}
const roomFor = async (participantId) => {
  const rooms = await sfuRooms();
  return rooms.find((r) => r.participantId === participantId) ?? null;
};

/** Spawns the REAL student desktop publisher (auto-drive, hold mode). */
function spawnPublisher(studentEmail) {
  const electronBin = requireApp('student-desktop')('electron');
  const child = spawn(electronBin, ['.'], {
    cwd: path.join(ROOT, 'apps', 'student-desktop'),
    env: {
      ...process.env,
      EXAMGUARD_E2E: '1',
      EXAMGUARD_E2E_MEDIA_PUBLISH: '1',
      EXAMGUARD_E2E_PUBLISH_HOLD_FILE: HOLD_FILE,
      EXAMGUARD_E2E_USER_DATA: USER_DATA_DIR,
      EXAMGUARD_E2E_EMAIL: studentEmail,
      EXAMGUARD_E2E_PASSWORD: PASSWORD,
      EXAMGUARD_API_URL: API,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { text: '', exit: new Promise((resolve) => child.on('exit', (c) => resolve(c ?? -1))) };
  child.stdout.on('data', (d) => {
    const s = String(d);
    out.text += s;
    process.stdout.write(`[pub] ${s}`);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[pub-err] ${String(d)}`));
  return { child, out };
}

/** Resolve the real `next` CLI entry WITHOUT executing it (requiring
 * next/dist/bin/next runs the CLI in-process — a footgun). */
function resolveNextCli() {
  const nmNext = path.join(ROOT, 'apps', 'monitor-web', 'node_modules', 'next');
  const real = fs.realpathSync(nmNext); // pnpm symlink → store dir
  const pj = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
  const bin = typeof pj.bin === 'string' ? pj.bin : pj.bin?.next;
  if (typeof bin !== 'string') throw new Error('cannot resolve next bin');
  return path.join(real, bin);
}

/** Spawns the Next.js production server serving the real Monitor Web app. */
async function spawnMonitorWeb() {
  const nextCli = resolveNextCli();
  const child = spawn(process.execPath, [nextCli, 'start', '-p', String(UI_PORT)], {
    cwd: path.join(ROOT, 'apps', 'monitor-web'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JWT_SECRET,
      EXAMGUARD_JWT_SECRET: JWT_SECRET,
      API_URL: API,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { text: '' };
  child.stdout.on('data', (d) => {
    const s = String(d);
    out.text += s;
    process.stdout.write(`[web] ${s}`);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[web-err] ${String(d)}`));
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ok = await fetch(`${UI_BASE}/login`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      fail(`monitor-web did not come up on ${UI_BASE}`);
    }
    await SLEEP(1_000);
  }
  log(`E2E_LIVEVIEW monitor-web up on ${UI_BASE}`);
  return child;
}

/** Spawns the real-UI Electron harness (drives the actual Next portal). */
function spawnUiHarness(env) {
  const electronBin = requireApp('student-desktop')('electron');
  const child = spawn(electronBin, [path.join(ROOT, 'apps', 'monitor-web', 'e2e', 'ui-main.cjs')], {
    cwd: path.join(ROOT, 'apps', 'monitor-web'),
    env: {
      ...process.env,
      E2E_UI_URL: UI_BASE,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { text: '', exit: new Promise((resolve) => child.on('exit', (c) => resolve(c ?? -1))) };
  child.stdout.on('data', (d) => {
    const s = String(d);
    out.text += s;
    process.stdout.write(`[ui] ${s}`);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[ui-err] ${String(d)}`));
  return { child, out };
}

async function main() {
  if (!(await fetch(`${API}/health`).catch(() => null))?.ok) fail(`API not reachable on ${API}`);
  if (!(await fetch(`${SFU_HTTP}/health`).catch(() => null))?.ok) fail(`SFU not reachable on ${SFU_HTTP}`);
  killLeftoverElectron();
  await SLEEP(2_000);
  fs.rmSync(HOLD_FILE, { force: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(UI_USER_DATA_DIR, { recursive: true, force: true });

  // Fixtures: one device-required exam with two students; monitor assigned.
  const fx = await makeOrg();
  log(`Fixture ready: exam=${fx.exam.id} studentA=${fx.studentA.studentCode} studentB=${fx.studentB.studentCode} monitor=${fx.monitorEmail} examName=${fx.exam.name}`);

  // Student B: ACTIVE attempt via the API, but never runs the secure desktop,
  // so there is no media session to subscribe to (honest unavailable state).
  const tokenB = await login(fx.studentB.email);
  const startedB = await jsonFetch('/api/v1/attempts', {
    method: 'POST',
    token: tokenB,
    body: {
      examId: fx.exam.id,
      deviceInfo: { os: 'Windows', appVersion: '0.4.0-ui-e2e' },
      consent: {
        version: '1',
        camera: true,
        microphone: true,
        screen: true,
        acceptedAt: new Date().toISOString(),
      },
    },
  });
  if (startedB.body.attempt.status !== 'ACTIVE') fail(`student B attempt not ACTIVE (${startedB.body.attempt.status})`);
  log(`Student B attempt active: ${startedB.body.attempt.id}`);

  // Real publisher (student A) held open for the monitor leg.
  const publisher = spawnPublisher(fx.studentA.email);
  const children = [publisher.child];
  const watchdog = setTimeout(() => {
    publisher.child.kill('SIGKILL');
    fail(`publisher watchdog`);
  }, 280_000);
  const cleanup = () => {
    try {
      fs.rmSync(HOLD_FILE, { force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(UI_USER_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    for (const c of children) {
      try {
        if (!c.killed) c.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', cleanup);

  await waitFor('publisher attempt + sfu media verified', () => {
    const m = publisher.out.text.match(/E2E_MEDIA_PUBLISH sfu (\{.*?\})\n/s);
    return m ? JSON.parse(m[1]) : null;
  }, 240_000, 1_000);
  const attemptMatch = publisher.out.text.match(/E2E_MEDIA_PUBLISH attempt ([0-9a-f-]{36})/);
  const sfuInfo = JSON.parse(publisher.out.text.match(/E2E_MEDIA_PUBLISH sfu (\{.*?\})\n/s)[1]);
  if (!attemptMatch) fail('no attempt marker from publisher');
  const participantId = sfuInfo.participantId;
  await waitFor('publisher holding', () => /holding-for-subscriber/.test(publisher.out.text), 30_000);
  log(`Publisher live: participant=${participantId}`);

  // Monitor-web (Next production server) — the REAL Monitor Web application.
  const web = await spawnMonitorWeb();
  children.push(web);

  // The real-UI harness drives the actual portal.
  const harness = spawnUiHarness({
    E2E_MONITOR_EMAIL: fx.monitorEmail,
    E2E_MONITOR_PASSWORD: PASSWORD,
    E2E_EXAM_NAME: fx.exam.name,
    E2E_STUDENT_A_CODE: fx.studentA.studentCode,
    E2E_STUDENT_B_CODE: fx.studentB.studentCode,
    EXAMGUARD_E2E_USER_DATA: UI_USER_DATA_DIR,
  });
  children.push(harness.child);
  const harnessWatchdog = setTimeout(() => {
    harness.child.kill('SIGKILL');
    fail('UI harness watchdog');
  }, 300_000);
  const waitMarker = (label, what, timeoutMs = 240_000) =>
    waitFor(what, () => {
      const i = harness.out.text.indexOf(label);
      if (i < 0) return null;
      const m = harness.out.text.slice(i).match(/(\{.*?\})\n/);
      return m ? m[1] : true;
    }, timeoutMs, 500);

  // --- A live: real decoded frames + SFU consumer growth -------------------
  const aLiveRaw = await waitMarker('UI_A_LIVE', 'A live markers');
  const aLive = aLiveRaw === true ? {} : JSON.parse(aLiveRaw);
  log(`E2E_LIVEVIEW a-live ${aLiveRaw}`);
  if (!aLive.cameraFrames || !aLive.screenFrames || !aLive.micLive || !aLive.mutedDefault || !aLive.audioEnabled) {
    fail(`A live view assertions failed: ${JSON.stringify(aLive)}`);
  }
  const consumerSample = async () => {
    const r = await roomFor(participantId);
    const byKind = {};
    for (const c of r?.consumers ?? []) byKind[c.appKind] = c.bytesSent;
    return { count: r?.consumers?.length ?? 0, subscribers: r?.subscribers ?? 0, byKind };
  };
  const before = await consumerSample();
  await SLEEP(4_000);
  const after = await consumerSample();
  log(
    `E2E_LIVEVIEW sfu-a-consumers ${JSON.stringify({ before, after, cameraGrew: after.byKind.camera > before.byKind.camera, screenGrew: after.byKind.screen > before.byKind.screen })}`,
  );
  if (before.count !== 3 || after.count !== 3 || before.subscribers !== 1) {
    fail(`A SFU consumers wrong: ${JSON.stringify({ before, after })}`);
  }
  if (!(after.byKind.camera > before.byKind.camera) || !(after.byKind.screen > before.byKind.screen)) {
    fail('A SFU consumer bytes did not grow during live view');
  }

  // --- Switch to B: A cleaned, B settled unavailable ------------------------
  await waitMarker('UI_B_OPEN', 'B open markers', 120_000);
  await waitFor('A consumers cleaned after switching to B', async () => {
    const r = await roomFor(participantId);
    return r && r.consumers.length === 0 && r.subscribers === 0;
  }, 25_000, 500);
  log('E2E_LIVEVIEW switch-b-a-cleaned');

  // --- Back to A: fresh subscription, exactly 3 consumers, no leak ----------
  const aLive2Raw = await waitMarker('UI_A_LIVE_2', 'A re-live markers', 120_000);
  log(`E2E_LIVEVIEW a-live-2 ${aLive2Raw}`);
  await waitFor('A consumers restored to 3', async () => {
    const r = await roomFor(participantId);
    return r && r.consumers.length === 3;
  }, 30_000, 500);
  const b2 = await consumerSample();
  await SLEEP(4_000);
  const b3 = await consumerSample();
  if (b3.count !== 3 || !(b3.byKind.camera > b2.byKind.camera)) {
    fail(`A re-subscribe leak or stall: ${JSON.stringify({ b2, b3 })}`);
  }
  log('E2E_LIVEVIEW a-resubscribed-no-leak');

  // --- Terminate A from the real UI modal ------------------------------------
  await waitMarker('UI_TERMINATED', 'terminated markers', 120_000);
  log('E2E_LIVEVIEW ui-terminated');
  await waitFor('SFU room drained after UI termination', async () => {
    const r = await roomFor(participantId);
    return r === null;
  }, 25_000, 500);
  const { Client } = requireRoot('pg');
  const DB_URL = 'postgresql://examguard:examguard@localhost:5433/examguard?schema=public';
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  const rows = await db.query('select status from "MediaParticipant" where id = $1', [participantId]);
  await db.end();
  if (rows.rows[0]?.status !== 'ENDED') fail(`participant final state ${JSON.stringify(rows.rows)}`);
  log('E2E_LIVEVIEW participant-ended');

  // --- Harness clean exit -----------------------------------------------------
  clearTimeout(watchdog);
  clearTimeout(harnessWatchdog);
  const exit = await Promise.race([harness.out.exit, SLEEP(30_000).then(() => -9)]);
  if (exit !== 0 || !/UI_DONE/.test(harness.out.text)) {
    fail(`UI harness exited ${exit}`);
  }
  await SLEEP(1_000);
  cleanup();
  log(
    `MONITOR_LIVE_VIEW_E2E PASS (real Monitor Web UI: login→exam→board→student A live camera+screen frames, mic muted-by-default + enabled, switch to B cleans A, back to A resubscribes without leak, UI terminate drains SFU + ENDED row)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  try {
    fs.rmSync(HOLD_FILE, { force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
