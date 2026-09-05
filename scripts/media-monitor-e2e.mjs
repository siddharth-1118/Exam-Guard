/**
 * ExamGuard Phase 4C — monitor live-media subscriber E2E.
 *
 * Real pipeline: REAL student publisher (Electron renderer: camera +
 * microphone + whole-display screen → mediasoup SFU, held open for the
 * monitor) → REAL monitor subscriber (Electron harness running the actual
 * monitor-web MonitorSubscriber module in Chromium). The monitor consumes the
 * student's camera/screen/microphone through the SFU and proves actual decoded
 * frames; the SFU /status proves consumer byte growth server-side.
 *
 * Legs:
 *   fixtures       orgA + exam(3 devices) + studentA + monitorA(assigned);
 *                  orgB + monitorB (cross-tenant target)
 *   publish        real desktop publisher, held open on the HOLD_FILE
 *   positives      monitorA subscriber-token 200 + full subscribe cycle ×2
 *                  (each cycle ends with a clean disconnect: SFU consumers 0)
 *   negatives      cross-org token (orgB monitor → orgA attempt) denied;
 *                  wrong participantId denied; expired subscriber token 401
 *                  at the SFU; subscriber join with no publisher room → 409;
 *                  subscriber token after attempt end denied
 *   cleanup        publisher released → submits → Phase 4D.1 eviction leaves
 *                  zero SFU rooms + participant ENDED + audits present
 *
 * Prereqs: API :4000, SFU :4010, dev Postgres :5433, real camera/mic/display.
 * Usage: node scripts/media-monitor-e2e.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// The root .env may target a DIFFERENT local Postgres (e.g. 5432); the dev
// ExamGuard stack runs on 5433. Capture an explicit caller-provided URL before
// the .env load, then drop the .env value so it can't override the dev DB.
const explicitDbUrl = process.env.DATABASE_URL ?? null;
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no root .env — defaults below
}
if (!explicitDbUrl) delete process.env.DATABASE_URL;
const API = process.env.EXAMGUARD_API_URL || 'http://localhost:4000';
const SFU_HTTP = (process.env.WEBRTC_SERVER_URL || 'ws://localhost:4010').replace(/^ws/, 'http');
const SFU_WS = SFU_HTTP.replace(/^http/, 'ws');
const PASSWORD = 'ExamGuard!Desktop2026';
const STAMP = Date.now().toString(36);
const uniq = (p) => `${p}-${STAMP}@examguard.test`;
const HOLD_FILE = path.join(ROOT, '.tmp-4c-hold');
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function expectDenied(label, run) {
  const { status } = await run();
  if (status >= 200 && status < 300) {
    fail(`SECURITY FAIL: ${label} unexpectedly succeeded (${status})`);
  }
  log(`E2E_SECURITY denied ${label} (${status})`);
}

async function makeOrg(name) {
  const reg = await jsonFetch('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: uniq(name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-admin'),
      password: PASSWORD,
      firstName: name,
      lastName: 'Admin',
      organizationName: `${name} ${STAMP}`,
    },
  });
  const adminToken = reg.body.accessToken;
  const studentEmail = uniq(`${name.toLowerCase()}-student`);
  const student = (
    await jsonFetch('/api/v1/students', {
      method: 'POST',
      token: adminToken,
      body: {
        email: studentEmail,
        password: PASSWORD,
        firstName: name,
        lastName: 'Student',
        studentCode: `${name.toUpperCase()}-${STAMP}`,
      },
    })
  ).body;
  const monitorEmail = uniq(`${name.toLowerCase()}-monitor`);
  const monitor = (
    await jsonFetch('/api/v1/monitors', {
      method: 'POST',
      token: adminToken,
      body: {
        email: monitorEmail,
        password: PASSWORD,
        firstName: name,
        lastName: 'Monitor',
      },
    })
  ).body;
  const exam = (
    await jsonFetch('/api/v1/exams', {
      method: 'POST',
      token: adminToken,
      body: {
        name: `${name} exam ${STAMP}`,
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
  await jsonFetch(`/api/v1/exams/${exam.id}/students`, {
    method: 'POST',
    token: adminToken,
    body: { studentIds: [student.id] },
  });
  await jsonFetch(`/api/v1/exams/${exam.id}/monitors`, {
    method: 'POST',
    token: adminToken,
    body: { monitorIds: [monitor.id] },
  });
  return { adminToken, student, studentEmail, monitorId: monitor.id, monitorEmail, exam };
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
  const req = createRequire(path.join(ROOT, 'apps', 'student-desktop', 'package.json'));
  const electronBin = req('electron');
  const child = spawn(electronBin, ['.'], {
    cwd: path.join(ROOT, 'apps', 'student-desktop'),
    env: {
      ...process.env,
      EXAMGUARD_E2E: '1',
      EXAMGUARD_E2E_MEDIA_PUBLISH: '1',
      EXAMGUARD_E2E_PUBLISH_HOLD_FILE: HOLD_FILE,
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

/** Bundles the real monitor-web subscriber driver for the harness renderer. */
async function buildMonitorDriver() {
  const esbuild = createRequire(path.join(ROOT, 'apps', 'student-desktop', 'package.json'))('esbuild');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'apps', 'monitor-web', 'e2e', 'driver.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    outfile: path.join(ROOT, 'apps', 'monitor-web', 'e2e', 'driver.bundle.js'),
    logLevel: 'error',
  });
}

/** Spawns the real monitor subscriber harness (monitor-web module in Chromium). */
function spawnMonitor(attemptId, monitorAccessToken, cycles = 1, pauseMs = 6_000) {
  const req = createRequire(path.join(ROOT, 'apps', 'student-desktop', 'package.json'));
  const electronBin = req('electron');
  const child = spawn(electronBin, [path.join(ROOT, 'apps', 'monitor-web', 'e2e', 'main.cjs')], {
    cwd: path.join(ROOT, 'apps', 'monitor-web'),
    env: {
      ...process.env,
      EXAMGUARD_API_URL: API,
      E2E_ATTEMPT_ID: attemptId,
      E2E_MONITOR_TOKEN: monitorAccessToken,
      E2E_CYCLES: String(cycles),
      E2E_PAUSE_MS: String(pauseMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { text: '', exit: new Promise((resolve) => child.on('exit', (c) => resolve(c ?? -1))) };
  child.stdout.on('data', (d) => {
    const s = String(d);
    out.text += s;
    process.stdout.write(`[mon] ${s}`);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[mon-err] ${String(d)}`));
  return { child, out };
}

async function main() {
  if (!(await fetch(`${API}/health`).catch(() => null))?.ok) fail(`API not reachable on ${API}`);
  if (!(await fetch(`${SFU_HTTP}/health`).catch(() => null))?.ok) fail(`SFU not reachable on ${SFU_HTTP}`);
  await buildMonitorDriver();
  log('E2E_MONITOR driver-bundle built');

  // Fixtures: orgA has the real student + an assigned monitor; orgB monitor is
  // the cross-tenant target.
  const orgA = await makeOrg('MonA');
  const orgB = await makeOrg('MonB');
  log(`Fixture ready: examA=${orgA.exam.id} studentA=${orgA.studentEmail} monitorA+monitorB created`);
  const monitorAToken = (await jsonFetch('/api/v1/auth/login', { method: 'POST', body: { email: orgA.monitorEmail, password: PASSWORD } })).body.accessToken;
  const monitorBToken = (await jsonFetch('/api/v1/auth/login', { method: 'POST', body: { email: orgB.monitorEmail, password: PASSWORD } })).body.accessToken;
  if (!monitorAToken || !monitorBToken) fail('monitor login failed');

  fs.rmSync(HOLD_FILE, { force: true });

  // 1. REAL student publisher → SFU, held open for the monitor leg.
  const publisher = spawnPublisher(orgA.studentEmail);
  const WATCHDOG_MS = 300_000;
  const watchdog = setTimeout(() => {
    publisher.child.kill('SIGKILL');
    fail(`publisher watchdog after ${WATCHDOG_MS / 1000}s`);
  }, WATCHDOG_MS);
  const releaseAndCleanup = () => {
    try {
      fs.rmSync(HOLD_FILE, { force: true });
    } catch {
      // ignore
    }
    if (publisher && !publisher.child.killed) {
      try {
        publisher.child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  };
  process.on('exit', releaseAndCleanup);
  await waitFor('publisher attempt + sfu media verified', () => {
    const m = publisher.out.text.match(/E2E_MEDIA_PUBLISH sfu (\{.*?\})\n/s);
    return m ? JSON.parse(m[1]) : null;
  }, 280_000, 1_000);
  const attemptMatch = publisher.out.text.match(/E2E_MEDIA_PUBLISH attempt ([0-9a-f-]{36})/);
  const sfuInfo = JSON.parse(publisher.out.text.match(/E2E_MEDIA_PUBLISH sfu (\{.*?\})\n/s)[1]);
  if (!attemptMatch) fail('no attempt marker from publisher');
  const attemptId = attemptMatch[1];
  const participantId = sfuInfo.participantId;
  log(`Publisher live: attempt=${attemptId} participant=${participantId} producers=${JSON.stringify(sfuInfo.producers)}`);
  await waitFor('publisher holding for subscriber', () => /E2E_MEDIA_PUBLISH holding-for-subscriber/.test(publisher.out.text), 30_000);

  const room = await roomFor(participantId);
  if (!room) fail('SFU room missing for participant');
  const kinds = new Set(room.producers.map((p) => p.appKind));
  if (!(kinds.has('camera') && kinds.has('microphone') && kinds.has('screen'))) {
    fail(`SFU producers incomplete: ${JSON.stringify(room.producers)}`);
  }
  log(`E2E_MONITOR sfu-publishers ${JSON.stringify(room.producers.map((p) => ({ kind: p.appKind, bytes: p.bytesSent })))}`);

  // 2. Positive subscriber authorization + the two real subscribe cycles.
  const subTokenRes = await jsonFetch('/api/v1/media/subscriber-token', {
    method: 'POST',
    token: monitorAToken,
    body: { attemptId },
  });
  if (subTokenRes.status !== 201 && subTokenRes.status !== 200) fail(`subscriber token ${subTokenRes.status}`);
  if (subTokenRes.body.participantId !== participantId) fail('subscriber token participant mismatch');
  if (subTokenRes.body.attemptId !== attemptId) fail('subscriber token attempt mismatch');
  log(`E2E_MONITOR subscriber-token-ok participant=${subTokenRes.body.participantId}`);

  const assertConsumersGrow = async (label, cycle) => {
    const sample = async () => {
      const r = await roomFor(participantId);
      const byKind = {};
      for (const c of r?.consumers ?? []) byKind[c.appKind] = { bytes: c.bytesSent, bitrate: c.bitrate };
      return { byKind, count: r?.consumers?.length ?? 0, subscribers: r?.subscribers ?? 0 };
    };
    const a = await sample();
    await SLEEP(4_000);
    const b = await sample();
    const camera = b.byKind.camera?.bytes > a.byKind.camera?.bytes;
    const screen = b.byKind.screen?.bytes > a.byKind.screen?.bytes;
    const mic = Boolean(b.byKind.microphone);
    log(
      `E2E_MONITOR sfu-consumers ${JSON.stringify({ cycle, label, before: a, after: b, cameraBytesGrew: camera, screenBytesGrew: screen, micConsumerPresent: mic })}`,
    );
    if (!camera || !screen || !mic) fail(`consumer byte growth failed (${label}): ${JSON.stringify({ a, b })}`);
  };

  const expectCleanDisconnect = async (label) => {
    await waitFor(`consumers cleaned after ${label}`, async () => {
      const r = await roomFor(participantId);
      return r && r.consumers.length === 0 && r.subscribers === 0;
    }, 20_000, 500);
    const r = await roomFor(participantId);
    if (!r || r.producers.length !== 3) fail(`publisher damaged after ${label}`);
    log(`E2E_MONITOR clean-disconnect ${label}`);
  };

  // Cycle 1 + 2: subscribe → verified live frames → clean disconnect.
  for (const cycle of [1, 2]) {
    const mon = spawnMonitor(attemptId, monitorAToken, 1, 6_000);
    const cycleWatchdog = setTimeout(() => {
      mon.child.kill('SIGKILL');
      fail(`monitor harness cycle ${cycle} watchdog`);
    }, 150_000);
    const cycleMarker = await waitFor(
      `monitor cycle ${cycle} verified`,
      () => {
        const m = mon.out.text.match(/E2E_MONITOR_CYCLE (\{.*?\})\n/);
        return m ? JSON.parse(m[1]) : null;
      },
      120_000,
      500,
    );
    if (!cycleMarker.cameraFrames || !cycleMarker.screenFrames) {
      fail(`cycle ${cycle} frame decode failed: ${JSON.stringify(cycleMarker)}`);
    }
    if (!cycleMarker.micTrack || !cycleMarker.audioMutedDefault || !cycleMarker.audioEnabled) {
      fail(`cycle ${cycle} audio behavior failed: ${JSON.stringify(cycleMarker)}`);
    }
    if (cycleMarker.participantId !== participantId) fail('monitor subscribed to wrong participant');
    if (cycleMarker.feeds.some((f) => f.status !== 'live')) {
      fail(`cycle ${cycle} feeds not all live: ${JSON.stringify(cycleMarker.feeds)}`);
    }
    log(`E2E_MONITOR cycle${cycle}-verified ${JSON.stringify(cycleMarker)}`);
    await assertConsumersGrow(`cycle ${cycle}`, cycle);
    await waitFor(`cycle ${cycle} disconnect marker`, () => /E2E_MONITOR_DISCONNECT/.test(mon.out.text), 30_000);
    const exit = await Promise.race([mon.out.exit, SLEEP(30_000).then(() => -9)]);
    clearTimeout(cycleWatchdog);
    if (exit !== 0) fail(`monitor harness cycle ${cycle} exited ${exit}`);
    await expectCleanDisconnect(`cycle ${cycle}`);
  }

  // 3. Security negatives (publisher still live so rooms exist).

  // 3a. Cross-tenant: orgB monitor cannot obtain a token for orgA's attempt.
  await expectDenied('cross-org subscriber token (orgB monitor → orgA attempt)', () =>
    jsonFetch('/api/v1/media/subscriber-token', { method: 'POST', token: monitorBToken, body: { attemptId }, ok: true }),
  );

  // 3b. Wrong participant: supplying a foreign participantId must 404.
  await expectDenied('wrong participantId on subscriber token', () =>
    jsonFetch('/api/v1/media/subscriber-token', {
      method: 'POST',
      token: monitorAToken,
      body: { attemptId, participantId: '00000000-0000-4000-8000-000000000000' },
      ok: true,
    }),
  );

  // 3c. Expired subscriber credential rejected by the SFU (401).
  const jwtSecret = process.env.EXAMGUARD_JWT_SECRET ?? process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me';
  const signToken = (claims, ttlSeconds, nowSeconds = Math.floor(Date.now() / 1000)) => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const header = enc({ alg: 'HS256', typ: 'JWT' });
    const payload = enc({ ...claims, type: 'media', iat: nowSeconds, exp: nowSeconds + ttlSeconds });
    const sig = crypto.createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
  };
  const wsDenied = (token, expectCode) =>
    new Promise((resolve, reject) => {
      const WebSocket = createRequire(path.join(ROOT, 'apps', 'student-desktop', 'package.json'))('ws');
      const ws = new WebSocket(`${SFU_WS}/sfu`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`sfu did not answer (expected ${expectCode})`));
      }, 8_000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', data: { token } })));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === 'error') {
          clearTimeout(timer);
          if (m.data?.code !== expectCode) {
            reject(new Error(`expected ${expectCode}, got ${m.data?.code}`));
            return;
          }
          resolve(m.data.code);
          ws.close();
        }
      });
      ws.on('close', (code) => {
        if (code !== 1000) {
          clearTimeout(timer);
          resolve(code);
        }
      });
    });
  const expiredSubscriber = signToken(
    { sub: 'x', orgId: orgA.exam.organizationId ?? 'o', examId: orgA.exam.id, attemptId, participantId: 'x', role: 'subscriber' },
    -60,
  );
  const expiredCode = await wsDenied(expiredSubscriber, 401);
  log(`E2E_SECURITY expired subscriber token rejected (${expiredCode})`);

  // 3d. Subscriber join with no publisher room (forged, valid, other participant).
  const noRoomToken = signToken(
    { sub: 'x', orgId: 'o', examId: 'e', attemptId: 'ffffffff-0000-4000-8000-000000000000', participantId: 'ffffffff-0000-4000-8000-000000000000', role: 'subscriber' },
    120,
  );
  const noRoomCode = await wsDenied(noRoomToken, 409);
  log(`E2E_SECURITY subscriber no-room join rejected (${noRoomCode})`);

  // 4. Release the publisher: it submits; Phase 4D.1 cleanup must drain the SFU.
  fs.writeFileSync(HOLD_FILE, 'release');
  clearTimeout(watchdog);
  const pubExit = await publisher.out.exit;
  const missing = [
    /E2E_STEP submit SUBMITTED/,
    /E2E_MEDIA_PUBLISH sfu-clean/,
    /E2E_MEDIA_PUBLISH hold-released/,
  ].filter((re) => !re.test(publisher.out.text));
  if (pubExit !== 0 || missing.length > 0) {
    fail(`publisher final ${JSON.stringify({ exit: pubExit, missing })}`);
  }
  log('E2E_MONITOR publisher-submitted-clean');

  // 5. Ended attempt: subscriber authorization must now be refused.
  await expectDenied('subscriber token after attempt end', () =>
    jsonFetch('/api/v1/media/subscriber-token', { method: 'POST', token: monitorAToken, body: { attemptId }, ok: true }),
  );

  // 6. Final state: no SFU rooms, participant row ENDED.
  await waitFor('sfu fully drained', async () => (await sfuRooms()).length === 0, 15_000);
  const { Client } = createRequire(path.join(ROOT, 'package.json'))('pg');
  const DB_URL = 'postgresql://examguard:examguard@localhost:5433/examguard?schema=public';
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  const rows = await client.query('select status from "MediaParticipant" where id = $1', [participantId]);
  await client.end();
  if (rows.rows[0]?.status !== 'ENDED') fail(`participant final state ${JSON.stringify(rows.rows)}`);
  log(`E2E_MONITOR participant-ended ${participantId}`);

  log(
    `MEDIA_MONITOR_E2E PASS (real monitor subscriber: camera+screen decoded frames, mic track, audio muted-by-default + enabled, SFU consumer byte growth, clean disconnect ×2, attempt-end cleanup, cross-org/wrong-participant/expired/no-room/ended negatives) attempt=${attemptId}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  try {
    fs.rmSync(HOLD_FILE, { force: true });
  } catch {
    // ignore
  }
  process.exit(1);
});
