/**
 * ExamGuard Phase 4B — real student WebRTC publisher → SFU E2E.
 *
 * The REAL desktop app (renderer ExamScreen → Phase 3 device controller →
 * Phase 4B publisher) publishes camera + microphone + screen to the REAL
 * mediasoup SFU. Main-process markers plus SFU /status byte sampling prove
 * actual RTP flows, then cleanup after submit is verified.
 *
 * Security negatives run against the live API + SFU:
 *   - cross-tenant subscribe/token issuance is rejected server-side
 *   - an ended attempt cannot obtain a publisher credential
 *   - an expired media token is rejected by the SFU (401)
 *   - a second concurrent publisher connection for the same participant is
 *     resolved server-side (eviction) — never two live rooms
 *
 * Prereqs: API on :4000, SFU on :4010, migrated dev Postgres on 5433.
 * Usage: node scripts/media-publish-e2e.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Share the API/SFU signing secret (repo-root .env) so forged-token negative
// tests and reconnects exercise the same key the services actually use.
try {
  process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
} catch {
  // no root .env — defaults below
}
const API = process.env.EXAMGUARD_API_URL || 'http://localhost:4000';
const SFU_HTTP = (process.env.WEBRTC_SERVER_URL || 'ws://localhost:4010').replace(/^ws/, 'http');
const SFU_WS = (process.env.WEBRTC_SERVER_URL || 'ws://localhost:4010').replace(/^http/, 'ws');
const JWT_SECRET =
  process.env.EXAMGUARD_JWT_SECRET ?? process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me';
const PASSWORD = 'ExamGuard!Desktop2026';
const STAMP = Date.now().toString(36);
const uniq = (p) => `${p}-${STAMP}@examguard.test`;

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
    console.error(`SECURITY FAIL: ${label} unexpectedly succeeded (${status})`);
    process.exit(1);
  }
  console.log(`E2E_SECURITY denied ${label} (${status})`);
}

async function makeOrg(name, settings) {
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
  const student = (await jsonFetch('/api/v1/students', {
    method: 'POST',
    token: adminToken,
    body: {
      email: studentEmail,
      password: PASSWORD,
      firstName: name,
      lastName: 'Student',
      studentCode: `${name.toUpperCase()}-${STAMP}`,
    },
  })).body;
  const exam = (await jsonFetch('/api/v1/exams', {
    method: 'POST',
    token: adminToken,
    body: {
      name: `${name} exam ${STAMP}`,
      durationMinutes: 20,
      maxAttempts: 1,
      autoSubmit: true,
      status: 'OPEN',
      settings: { ...settings },
    },
  })).body;
  await jsonFetch(`/api/v1/exams/${exam.id}/students`, {
    method: 'POST',
    token: adminToken,
    body: { studentIds: [student.id] },
  });
  return { adminToken, student, studentEmail, exam };
}

/** Minimal HS256 media-token signer matching packages/auth (jose) claims. */
function signToken(claims, ttlSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const payload = enc({ ...claims, type: 'media', iat: nowSeconds, exp: nowSeconds + ttlSeconds });
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

let requireFromApp;
function requireApp() {
  if (requireFromApp) return requireFromApp;
  const appDir = path.join(__dirname, '..', 'apps', 'student-desktop');
  requireFromApp = createRequire(path.join(appDir, 'package.json'));
  return requireFromApp;
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  const sfuHealth = await fetch(`${SFU_HTTP}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error('API not reachable on ' + API + '. Start it first.');
    process.exit(2);
  }
  if (!sfuHealth || !sfuHealth.ok) {
    console.error('SFU not reachable on ' + SFU_HTTP + '. Start it first (services/media).');
    process.exit(2);
  }
  const req = requireApp();
  const WebSocket = req('ws');

  // 1. Fixtures: two orgs (tenant-isolation target) ---------------------------
  const settings = {
    cameraRequired: true,
    microphoneRequired: true,
    screenMonitoringRequired: true,
    identityVerificationRequired: false,
    aiProctoringEnabled: false,
  };
  const orgA = await makeOrg('PubA', settings);
  const orgB = await makeOrg('PubB', settings);
  console.log(`Fixture ready: orgA-exam=${orgA.exam.id} studentA=${orgA.studentEmail} orgB-exam=${orgB.exam.id} studentB=${orgB.studentEmail}`);

  // 2. Real Electron app: renderer publisher → SFU ----------------------------
  const appDir = path.join(__dirname, '..', 'apps', 'student-desktop');
  const electronBin = req('electron');
  const child = spawn(electronBin, ['.'], {
    cwd: appDir,
    env: {
      ...process.env,
      EXAMGUARD_E2E: '1',
      EXAMGUARD_E2E_MEDIA_PUBLISH: '1',
      EXAMGUARD_E2E_EMAIL: orgA.studentEmail,
      EXAMGUARD_E2E_PASSWORD: PASSWORD,
      EXAMGUARD_API_URL: API,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    const s = String(d);
    out += s;
    process.stdout.write(`[app] ${s}`);
  });
  child.stderr.on('data', (d) => {
    const s = String(d);
    err += s;
    process.stderr.write(`[app-err] ${s}`);
  });

  const WATCHDOG_MS = 300_000;
  const exit = await new Promise((resolve) => {
    const watchdog = setTimeout(() => {
      console.error(`TIMEOUT after ${WATCHDOG_MS / 1000}s — killing electron (pid ${child.pid}).`);
      console.error(`Last app output:\n${out.trim() || '(none)'}`);
      child.kill('SIGKILL');
      resolve(-2);
    }, WATCHDOG_MS);
    child.on('exit', (code) => {
      clearTimeout(watchdog);
      resolve(code ?? -1);
    });
  });

  const required = [
    /E2E_STEP login .*role=STUDENT/,
    /E2E_MEDIA_PUBLISH attempt [0-9a-f-]{36}/,
    /E2E_MEDIA_PUBLISH renderer \{[^}]*"state":"publishing"/,
    /E2E_MEDIA_PUBLISH sfu \{.*"cameraBytesGrew":true/,
    /E2E_MEDIA_PUBLISH sfu \{.*"screenBytesGrew":true/,
    /E2E_MEDIA_PUBLISH sfu \{.*"micProducerPresent":true/,
    /E2E_MEDIA_PUBLISH events-delivered/,
    /E2E_STEP submit SUBMITTED/,
    /E2E_MEDIA_PUBLISH sfu-clean/,
  ];
  const missing = required.filter((re) => !re.test(out));
  if (missing.length > 0) {
    console.error(`FAIL: missing markers: ${missing.join(', ')}`);
    if (err.trim()) console.error(`[electron stderr]\n${err.trim()}`);
    process.exit(1);
  }
  if (exit !== 0) {
    console.error(`FAIL: electron exited ${exit}`);
    process.exit(1);
  }
  const attemptMatch = out.match(/E2E_MEDIA_PUBLISH attempt ([0-9a-f-]{36})/);
  const attemptId = attemptMatch ? attemptMatch[1] : null;
  const sfuMatch = out.match(/E2E_MEDIA_PUBLISH sfu (\{.*?\})\n/);
  const sfuInfo = sfuMatch ? JSON.parse(sfuMatch[1]) : null;
  if (!attemptId || !sfuInfo) {
    console.error('FAIL: could not parse attempt / sfu markers');
    process.exit(1);
  }
  console.log(`E2E_PUBLISH renderer-producers=${JSON.stringify(sfuInfo.producers)}`);

  // 3. SFU state fully drained (room gone after submit) ------------------------
  await new Promise((r) => setTimeout(r, 1500));
  const roomsNow = (await (await fetch(`${SFU_HTTP}/status`)).json()).rooms ?? [];
  const leftover = roomsNow.filter((r) => r.attemptId === attemptId);
  if (leftover.length > 0) {
    console.error(`FAIL: SFU still has room for attempt after cleanup (${JSON.stringify(leftover[0])})`);
    process.exit(1);
  }
  console.log('E2E_PUBLISH sfu-empty-after-submit');

  // 4. Security negatives ------------------------------------------------------
  // 4a. Cross-tenant publisher token issuance: orgB student on orgA attempt.
  const studentBLogin = await jsonFetch('/api/v1/auth/login', {
    method: 'POST',
    body: { email: orgB.studentEmail, password: PASSWORD },
  });
  await expectDenied('cross-tenant publisher token (orgB student → orgA attempt)', () =>
    jsonFetch('/api/v1/media/token', {
      method: 'POST',
      token: studentBLogin.body.accessToken,
      body: { attemptId },
      ok: true,
    }),
  );

  // 4b. Ended attempt cannot obtain a NEW publisher credential.
  const studentALogin = await jsonFetch('/api/v1/auth/login', {
    method: 'POST',
    body: { email: orgA.studentEmail, password: PASSWORD },
  });
  await expectDenied('publisher token for SUBMITTED attempt', () =>
    jsonFetch('/api/v1/media/token', {
      method: 'POST',
      token: studentALogin.body.accessToken,
      body: { attemptId },
      ok: true,
    }),
  );

  // 4c. Expired media token rejected by the SFU (401).
  const expired = signToken(
    { sub: 'x', orgId: 'o', examId: 'e', attemptId, participantId: 'x', role: 'publisher' },
    -60,
  );
  const expiredResult = await new Promise((resolve) => {
    const ws = new WebSocket(`${SFU_WS}/sfu`);
    const timer = setTimeout(() => {
      ws.close();
      resolve({ code: 0, message: 'timeout' });
    }, 6000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', data: { token: expired } })));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'error') {
        clearTimeout(timer);
        resolve({ code: m.data.code, message: m.data.message });
        ws.close();
      }
      if (m.type === 'joined') {
        clearTimeout(timer);
        resolve({ code: 0, message: 'unexpectedly joined' });
        ws.close();
      }
    });
  });
  if (expiredResult.code !== 401) {
    console.error(`FAIL: expired token accepted by SFU (${JSON.stringify(expiredResult)})`);
    process.exit(1);
  }
  console.log(`E2E_SECURITY expired publisher token rejected (${expiredResult.code})`);

  // 4d. Duplicate publisher: two concurrent joins for the same participant.
  //     The SFU resolves this server-side (eviction) — never two live rooms.
  const dupToken = signToken(
    { sub: 'dup', orgId: 'dup-org', examId: 'dup-exam', attemptId: 'dup-attempt', participantId: 'dup-participant', role: 'publisher' },
    120,
  );
  const openSockets = [];
  const connectOnce = () =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${SFU_WS}/sfu`);
      openSockets.push(ws);
      let joined = false;
      const timer = setTimeout(() => {
        ws.close();
        resolve({ joined, closed: true });
      }, 8000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', data: { token: dupToken } })));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === 'joined') {
          joined = true;
          clearTimeout(timer);
          resolve({ joined });
        }
        if (m.type === 'error') {
          clearTimeout(timer);
          resolve({ joined: false, error: m.data.code });
        }
      });
      ws.on('close', (code) => {
        if (code === 4001) resolve({ joined, evicted: true });
      });
    });
  const first = await connectOnce();
  await new Promise((r) => setTimeout(r, 500));
  const second = await connectOnce();
  await new Promise((r) => setTimeout(r, 800));
  const dupRooms = (await (await fetch(`${SFU_HTTP}/status`)).json()).rooms ?? [];
  const dupRoomCount = dupRooms.filter((r) => r.participantId === 'dup-participant').length;
  if (!first.joined || !second.joined || dupRoomCount !== 1) {
    console.error(`FAIL: duplicate publisher handling (first=${JSON.stringify(first)} second=${JSON.stringify(second)} rooms=${dupRoomCount})`);
    process.exit(1);
  }
  console.log(`E2E_SECURITY duplicate publisher resolved (single room, ${dupRoomCount})`);

  // Self-clean: close every socket we opened (the surviving duplicate keeps the
  // room AND this process alive if left open) and wait for the room to drain so
  // downstream E2Es (cleanup baseline checks) always start from zero rooms.
  for (const s of openSockets) {
    try {
      s.close(1000, 'e2e-done');
    } catch {
      // already closed
    }
  }
  const drainDeadline = Date.now() + 10_000;
  for (;;) {
    const rooms = (await (await fetch(`${SFU_HTTP}/status`)).json()).rooms ?? [];
    if (!rooms.some((r) => r.participantId === 'dup-participant')) break;
    if (Date.now() > drainDeadline) {
      console.error('FAIL: duplicate-publisher room did not drain after socket close');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('E2E_SECURITY duplicate room drained');

  console.log(
    `MEDIA_PUBLISH_E2E PASS (real renderer publisher: camera+mic+screen producers, SFU byte growth, cleanup, tenant/expiry/duplicate negatives) attempt=${attemptId}`,
  );
  // Force-exit so an incidental open handle can never leave a zombie process
  // (and its SFU room) behind after a green run.
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});