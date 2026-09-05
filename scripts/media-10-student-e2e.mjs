/**
 * ExamGuard Phase 4D.3 — measured 10-student realtime baseline.
 *
 * 10 REAL concurrent student publishers (Electron: real camera + microphone +
 * whole-display screen → mediasoup SFU) with a synchronization barrier, then a
 * measurement window while all 10 are ACTIVE: SFU rooms/producers/consumers,
 * Redis presence/ownership, DB rows, host CPU/memory. A monitor subscribes to
 * students #1/#5/#10 (real decoded frames + consumer byte growth, clean
 * disconnects — no leak). Student #5 performs a controlled reconnect (real
 * MediaLink socket drop, same participant). Student #7 is terminated via the
 * monitoring API while the other nine keep publishing. Finally all students
 * submit and the environment returns to baseline.
 *
 * Environment: API :4000, SFU :4010, dev Postgres :5433, Redis :6379, real
 * camera/mic/display, Windows (single physical machine, shared userData-scoped
 * single-instance locks per publisher). NOT a scalability claim: 10 students on
 * ONE machine measures this machine, not a cluster.
 *
 * Usage: node scripts/media-10-student-e2e.mjs   (STUDENT_COUNT=N to override)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const requireRoot = createRequire(path.join(ROOT, 'package.json'));
const requireApp = (p) => createRequire(path.join(ROOT, 'apps', p, 'package.json'));
const requireApi = createRequire(path.join(ROOT, 'services', 'api', 'package.json'));

const explicitDbUrl = process.env.DATABASE_URL ?? null;
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no root .env
}
if (!explicitDbUrl) delete process.env.DATABASE_URL;

const API = process.env.EXAMGUARD_API_URL || 'http://localhost:4000';
const SFU_HTTP = (process.env.WEBRTC_SERVER_URL || 'ws://localhost:4010').replace(/^ws/, 'http');
const DB_URL =
  process.env.DATABASE_URL || 'postgresql://examguard:examguard@localhost:5433/examguard?schema=public';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PASSWORD = 'ExamGuard!Desktop2026';
const STUDENT_COUNT = Number(process.env.STUDENT_COUNT ?? 10);
if (!Number.isInteger(STUDENT_COUNT) || STUDENT_COUNT < 1 || STUDENT_COUNT > 12) {
  console.error('FAIL: STUDENT_COUNT must be an integer 1..12');
  process.exit(1);
}
const STAMP = Date.now().toString(36);
const uniq = (p) => `${p}-${STAMP}@examguard.test`;
const HOLD_PREFIX = path.join(ROOT, `.tmp-10s-hold-${STAMP}`);
const DATA_PREFIX = path.join(ROOT, `.tmp-10s-data-${STAMP}`);
const RECONNECT_IDX = Math.min(4, STUDENT_COUNT - 1); // student #5
const TERMINATE_IDX = Math.min(6, STUDENT_COUNT - 1); // student #7
const MONITOR_TARGETS = [0, RECONNECT_IDX, STUDENT_COUNT - 1].filter((v, i, a) => a.indexOf(v) === i);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);
const samples = { sfu: [], redis: [], host: [] };

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function jsonFetch(url, { method = 'GET', token, body } = {}) {
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
  if (!res.ok) {
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeOrg() {
  const reg = await jsonFetch('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: uniq('ten-admin'),
      password: PASSWORD,
      firstName: 'Ten',
      lastName: 'Admin',
      organizationName: `TenOrg ${STAMP}`,
    },
  });
  const adminToken = reg.body.accessToken;
  const exam = (
    await jsonFetch('/api/v1/exams', {
      method: 'POST',
      token: adminToken,
      body: {
        name: `TenExam ${STAMP}`,
        durationMinutes: 25,
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
  const students = [];
  for (let i = 0; i < STUDENT_COUNT; i += 1) {
    const code = `T${String(i + 1).padStart(2, '0')}-${STAMP.toUpperCase().slice(-5)}`;
    const s = (
      await jsonFetch('/api/v1/students', {
        method: 'POST',
        token: adminToken,
        body: {
          email: uniq(`ten-s${i + 1}`),
          password: PASSWORD,
          firstName: `S${i + 1}`,
          lastName: 'Student',
          studentCode: code,
        },
      })
    ).body;
    students.push(s);
  }
  const monitor = (
    await jsonFetch('/api/v1/monitors', {
      method: 'POST',
      token: adminToken,
      body: {
        email: uniq('ten-monitor'),
        password: PASSWORD,
        firstName: 'Ten',
        lastName: 'Monitor',
      },
    })
  ).body;
  await jsonFetch(`/api/v1/exams/${exam.id}/students`, {
    method: 'POST',
    token: adminToken,
    body: { studentIds: students.map((s) => s.id) },
  });
  await jsonFetch(`/api/v1/exams/${exam.id}/monitors`, {
    method: 'POST',
    token: adminToken,
    body: { monitorIds: [monitor.id] },
  });
  return { adminToken, exam, students, monitor };
}

async function login(email) {
  const r = await jsonFetch('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  return r.body.accessToken;
}

// ---------------------------------------------------------------------------
// Publishers
// ---------------------------------------------------------------------------

function spawnPublisher(idx, studentEmail) {
  const electronBin = requireApp('student-desktop')('electron');
  const holdFile = `${HOLD_PREFIX}-p${idx}`;
  const userData = `${DATA_PREFIX}-p${idx}`;
  const child = spawn(electronBin, ['.'], {
    cwd: path.join(ROOT, 'apps', 'student-desktop'),
    env: {
      ...process.env,
      EXAMGUARD_E2E: '1',
      EXAMGUARD_E2E_MEDIA_PUBLISH: '1',
      EXAMGUARD_E2E_PUBLISH_HOLD_FILE: holdFile,
      EXAMGUARD_E2E_PUBLISH_RECONNECT_FILE: `${HOLD_PREFIX}-reconnect-${idx}`,
      // The 10-student run waits at the barrier for ALL publishers, then runs
      // the measurement window + monitor/reconnect/terminate legs — early
      // publishers need a longer hold than the default 5-minute budget. The
      // startup budget is also generous: 10 boots contend for RAM/devices and
      // the renderer publisher (camera+mic+screen) can exceed the 120 s default.
      EXAMGUARD_E2E_PUBLISH_HOLD_MS: process.env.EXAMGUARD_E2E_PUBLISH_HOLD_MS || '900000',
      EXAMGUARD_E2E_PUBLISH_STARTUP_MS: process.env.EXAMGUARD_E2E_PUBLISH_STARTUP_MS || '300000',
      EXAMGUARD_E2E_USER_DATA: userData,
      EXAMGUARD_E2E_EMAIL: studentEmail,
      EXAMGUARD_E2E_PASSWORD: PASSWORD,
      EXAMGUARD_API_URL: API,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = {
    idx,
    child,
    holdFile,
    out: { text: '', exit: new Promise((resolve) => child.on('exit', (c) => resolve(c ?? -1))) },
    attemptId: null,
    participantId: null,
    joinedAt: null,
    sfuAt: null,
    reconnected: null,
    exited: false,
  };
  child.stdout.on('data', (d) => {
    const s = String(d);
    handle.out.text += s;
    process.stdout.write(`[p${idx}] ${s}`);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[p${idx}-err] ${String(d)}`));
  child.on('exit', (c) => {
    handle.exited = true;
    handle.exitCode = c;
  });
  return handle;
}

// ---------------------------------------------------------------------------
// Probes: SFU / Redis / DB / host
// ---------------------------------------------------------------------------

async function sfuSnapshot() {
  const res = await fetch(`${SFU_HTTP}/status`);
  const json = await res.json();
  return {
    rooms: json.rooms ?? [],
    metrics: json.metrics ?? {},
    producerCount: (json.rooms ?? []).reduce((a, r) => a + (r.producers?.length ?? 0), 0),
    consumerCount: (json.rooms ?? []).reduce((a, r) => a + (r.consumers?.length ?? 0), 0),
    transportCount: (json.rooms ?? []).reduce(
      (a, r) => a + ((r.transports && Array.isArray(r.transports) ? r.transports.length : Number(r.transportCount ?? 0)) ?? 0),
      0,
    ),
  };
}

/** Consumers attached to a participant's room: count + summed bytesSent. */
async function consumerBytes(participantId) {
  const s = await sfuSnapshot();
  const room = s.rooms.find((r) => r.participantId === participantId);
  if (!room) return null;
  const cs = room.consumers ?? [];
  return { count: cs.length, bytes: cs.reduce((a, c) => a + (c.bytesSent ?? 0), 0) };
}

async function redisSnapshot() {
  const Redis = requireApi('ioredis');
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  try {
    const keys = await client.keys('examguard:media:*');
    const presence = keys.filter((k) => k.includes(':presence:'));
    const owners = keys.filter((k) => k.includes(':owner:'));
    const rows = [];
    for (const k of presence) {
      const h = await client.hgetall(k);
      rows.push({ key: k, state: h.connectionState ?? '?', participantId: h.participantId ?? '' });
    }
    return { keys: keys.length, presence: presence.length, owners: owners.length, rows };
  } finally {
    client.disconnect();
  }
}

async function dbSnapshot() {
  const { Client } = requireRoot('pg');
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const participants = await db.query(
      'select id, status, \"attemptId\", \"studentId\", \"organizationId\", \"examId\" from "MediaParticipant" order by "createdAt" asc',
    );
    const wanted = new Set(participants.rows.map((r) => r.attemptId));
    const attempts = await db.query('select id, status from "ExamAttempt"');
    attempts.rows = attempts.rows.filter((r) => wanted.has(r.id));
    return { participants: participants.rows, attempts: attempts.rows };
  } finally {
    await db.end();
  }
}

/** Host + key-process CPU-seconds and memory (Windows). */
function hostSample(prev = null) {
  const ps =
    'Get-Process electron,mediasoup-worker,node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,CPU | ConvertTo-Json -Compress';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 15_000, encoding: 'utf8' });
  let rows = [];
  try {
    const parsed = JSON.parse(r.stdout.trim());
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
  const now = Date.now();
  const groups = {};
  for (const row of rows) {
    if (!row || row.WorkingSet64 == null) continue;
    const name = row.ProcessName === 'mediasoup-worker' ? 'sfu' : row.ProcessName;
    groups[name] = groups[name] || { ws: 0, cpu: 0, n: 0 };
    groups[name].ws += Number(row.WorkingSet64);
    groups[name].cpu += Number(row.CPU || 0);
    groups[name].n += 1;
  }
  const out = { at: now, groups: {}, totalWs: 0 };
  for (const [name, g] of Object.entries(groups)) {
    const deltaCpu = prev ? g.cpu - (prev.groups[name]?.cpu ?? g.cpu) : 0;
    const wallS = prev ? (now - prev.at) / 1000 : 0;
    out.groups[name] = {
      n: g.n,
      wsMB: Math.round(g.ws / 1048576),
      cpuSecondsSincePrev: Math.max(0, deltaCpu).toFixed(1),
      wallSeconds: wallS.toFixed(1),
    };
    out.totalWs += g.ws;
  }
  out.totalWsMB = Math.round(out.totalWs / 1048576);
  out.freeMemMB = Math.round(os.freemem() / 1048576);
  return out;
}

// ---------------------------------------------------------------------------
// Monitor harness (real MonitorSubscriber in Chromium)
// ---------------------------------------------------------------------------

async function buildMonitorDriver() {
  const esbuild = requireApp('student-desktop')('esbuild');
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

function spawnMonitor(attemptId, monitorAccessToken, cycles = 1, pauseMs = 4_000) {
  const electronBin = requireApp('student-desktop')('electron');
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!(await fetch(`${API}/health`).catch(() => null))?.ok) fail(`API not reachable on ${API}`);
  if (!(await fetch(`${SFU_HTTP}/health`).catch(() => null))?.ok) fail(`SFU not reachable on ${SFU_HTTP}`);
  // Leftover Electron processes (shared camera/display) break the run.
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'student-desktop|monitor-web' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ],
    { timeout: 20_000 },
  );
  await SLEEP(2_000);
  await buildMonitorDriver();
  log(`E2E_10 baseline driver built (students=${STUDENT_COUNT} targets=${MONITOR_TARGETS.join(',')} reconnect=${RECONNECT_IDX} terminate=${TERMINATE_IDX})`);

  const fx = await makeOrg();
  log(`Fixture ready: exam=${fx.exam.id} students=${fx.students.length} monitor=${fx.monitor.email}`);
  const monitorToken = await login(fx.monitor.email);
  if (!monitorToken) fail('monitor login failed');

  // Baselines
  const sfuBase = await sfuSnapshot();
  const redisBase = await redisSnapshot();
  const dbBase = await dbSnapshot();
  const hostBase = hostSample();
  log(
    `E2E_10 baseline sfu=${JSON.stringify({ rooms: sfuBase.metrics.rooms, producers: sfuBase.producerCount, consumers: sfuBase.consumerCount, transports: sfuBase.transportCount })} redis=${JSON.stringify({ keys: redisBase.keys })} dbActive=${dbBase.participants.filter((p) => p.status === 'ACTIVE').length}`,
  );

  // Launch all publishers (staggered so device/encoder start-up spreads out).
  // 12 s between boots: with the auth limiter raised for the test window, ten
  // logins no longer self-throttle, so without this stagger all ten would open
  // camera/WGC capture simultaneously and trip Chromium's utility processes on
  // this single machine.
  const publishers = [];
  for (let i = 0; i < STUDENT_COUNT; i += 1) {
    publishers.push(spawnPublisher(i, fx.students[i].email));
    await SLEEP(12_000);
  }
  log(`E2E_10 all ${STUDENT_COUNT} publishers spawned, waiting for ACTIVE barrier`);

  // Barrier: every publisher must reach the SFU-verified hold.
  for (const p of publishers) {
    const started = Date.now();
    await waitFor(
      `publisher ${p.idx} holding`,
      async () => {
        const m = p.out.text.match(/E2E_MEDIA_PUBLISH sfu (\{.*?\})\n/s);
        if (!m) return false;
        const sfu = JSON.parse(m[1]);
        p.participantId = sfu.participantId;
        p.sfuAt = Date.now();
        const am = p.out.text.match(/E2E_MEDIA_PUBLISH attempt ([0-9a-f-]{36})/);
        p.attemptId = am ? am[1] : null;
        return /holding-for-subscriber/.test(p.out.text);
      },
      240_000,
      1_000,
    );
    p.joinedAt = started;
    log(
      `E2E_10 publisher ${p.idx} ACTIVE participant=${p.participantId?.slice(0, 8)} timeToHoldMs=${Date.now() - started}`,
    );
  }
  if (publishers.some((p) => !p.participantId)) {
    fail('not every publisher reached the SFU-verified hold');
  }
  log(`E2E_10 BARRIER: all ${STUDENT_COUNT} publishers simultaneously ACTIVE`);

  // ---- Measurement window (all 10 ACTIVE) ---------------------------------
  const windowStart = Date.now();
  const WINDOW_MS = 30_000;
  // CPU% deltas need a sample taken at the barrier itself (spawn time is too far back).
  let prevHost = hostSample();
  if (!prevHost) prevHost = hostBase;
  while (Date.now() - windowStart < WINDOW_MS) {
    const s = await sfuSnapshot();
    const r = await redisSnapshot();
    const h = hostSample(prevHost);
    if (h) prevHost = h;
    samples.sfu.push({
      t: Date.now() - windowStart,
      rooms: s.metrics.rooms,
      producers: s.producerCount,
      consumers: s.consumerCount,
      transports: s.transportCount,
      subscribers: s.rooms.reduce((a, room) => a + Number(room.subscribers ?? 0), 0),
    });
    samples.redis.push({ t: Date.now() - windowStart, presence: r.presence, owners: r.owners, keys: r.keys });
    samples.host.push(h);
    await SLEEP(5_000);
  }
  const peakSfu = samples.sfu.reduce((a, x) => (x.producers > a.producers ? x : a), samples.sfu[0]);
  const peakPresence = Math.max(...samples.redis.map((r) => r.presence));
  const peakOwners = Math.max(...samples.redis.map((r) => r.owners));
  const peakHost = samples.host.reduce((a, x) => (x && x.totalWsMB > (a?.totalWsMB ?? 0) ? x : a), null);
  log(
    `E2E_10 window peak sfu=${JSON.stringify(peakSfu)} redisPresence=${peakPresence} owners=${peakOwners} host=${JSON.stringify(peakHost)}`,
  );

  // ---- Reconnect FIRST: student #5 (controlled MediaLink socket drop) -----
  // Runs before the monitor cycles so the #5 monitor pass ALSO proves the
  // monitor recovers the feed after a real reconnect (spec §9).
  const rp = publishers[RECONNECT_IDX];
  const reconnectFile = `${HOLD_PREFIX}-reconnect-${RECONNECT_IDX}`;
  fs.writeFileSync(reconnectFile, 'go');
  const reconnectStarted = Date.now();
  const rcRaw = await waitFor(
    `student ${RECONNECT_IDX + 1} reconnected marker`,
    () => {
      const m = rp.out.text.match(/E2E_MEDIA_PUBLISH reconnected (\{.*?\})\n/);
      return m ? m[1] : null;
    },
    60_000,
    500,
  );
  const rc = JSON.parse(rcRaw);
  fs.rmSync(reconnectFile, { force: true });
  if (!rc.sameParticipant) fail(`reconnect changed participant: ${JSON.stringify(rc)}`);
  const rcMs = Date.now() - reconnectStarted;
  // No duplicate producers / no orphaned transport: room still has exactly 3
  // producers for that participant after the reconnect.
  const roomAfterReconnect = (await sfuSnapshot()).rooms.find((r) => r.participantId === rp.participantId);
  const producerKinds = new Set((roomAfterReconnect?.producers ?? []).map((pr) => pr.appKind));
  const count3 = (roomAfterReconnect?.producers?.length ?? 0) === 3;
  const hasAllKinds = ['camera', 'microphone', 'screen'].every((k) => producerKinds.has(k));
  if (!count3 || !hasAllKinds) fail(`producers wrong after reconnect: ${JSON.stringify({ count: roomAfterReconnect?.producers?.length, kinds: [...producerKinds] })}`);
  const redisAfterRc = await redisSnapshot();
  const rcPresence = redisAfterRc.rows.find((x) => x.participantId === rp.participantId);
  if (rcPresence?.state !== 'ACTIVE') {
    fail(`Redis presence not ACTIVE after reconnect: ${JSON.stringify(rcPresence ?? null)}`);
  }
  log(
    `E2E_10 reconnect student${RECONNECT_IDX + 1} PASS sameParticipant=${rc.sameParticipant} recoveryMs=${rcMs} producers=3 kinds=all redisState=${rcPresence.state}`,
  );

  // ---- Monitor subscriptions: #1, #5 (post-reconnect), #10 (sequential) ----
  for (const target of MONITOR_TARGETS) {
    const p = publishers[target];
    const mon = spawnMonitor(p.attemptId, monitorToken, 1, 10_000);
    const monWatchdog = setTimeout(() => mon.child.kill('SIGKILL'), 180_000);
    const cyclesRaw = await waitFor(
      `monitor cycle for student ${target + 1}`,
      () => {
        // Trailing space disambiguates from the earlier E2E_MONITOR_CYCLE_START log.
        const i = mon.out.text.indexOf('E2E_MONITOR_CYCLE {');
        if (i < 0) return null;
        const m = mon.out.text.slice(i).match(/(\{.*?\})\n/);
        return m ? m[1] : null;
      },
      180_000,
      1_000,
    );
    const cycle = JSON.parse(cyclesRaw);
    if (!cycle.cameraFrames || !cycle.screenFrames || !cycle.micTrack) {
      fail(`monitor did not receive real media from student ${target + 1}: ${cyclesRaw}`);
    }
    // Mid-hold SFU evidence: the room must carry 3 consumers whose bytesSent
    // grow while the monitor is attached (real media flowing monitor-ward).
    const cb1 = await consumerBytes(p.participantId);
    await SLEEP(3_000);
    const cb2 = await consumerBytes(p.participantId);
    if (!cb1 || !cb2 || cb1.count < 3) {
      fail(`student ${target + 1} consumers not attached: ${JSON.stringify({ cb1, cb2 })}`);
    }
    if (!(cb2.bytes > cb1.bytes)) {
      fail(`student ${target + 1} consumer bytes did not grow: ${JSON.stringify({ b1: cb1.bytes, b2: cb2.bytes })}`);
    }
    clearTimeout(monWatchdog);
    const exit = await Promise.race([mon.out.exit, SLEEP(30_000).then(() => -9)]);
    if (exit !== 0) fail(`monitor harness exited ${exit} for student ${target + 1}`);
    // Clean disconnect: this student's consumers must be back to 0.
    await waitFor(
      `student ${target + 1} consumers cleaned`,
      async () => {
        const s = await sfuSnapshot();
        const room = s.rooms.find((r) => r.participantId === p.participantId);
        return room === undefined || (room.consumers?.length ?? 0) === 0;
      },
      20_000,
      500,
    );
    log(
      `E2E_10 monitor student${target + 1} PASS frames=${cycle.cameraFrames}/${cycle.screenFrames} mic=${cycle.micTrack} consumers=${cb2.count} bytesGrew=${cb2.bytes - cb1.bytes}B`,
    );
    await SLEEP(2_000);
  }
  // No consumer leak across all 10 publishers (all monitor cycles done).
  const sfuMid = await sfuSnapshot();
  if (sfuMid.consumerCount !== 0) fail(`consumers leaked after monitor cycles: ${sfuMid.consumerCount}`);
  log(`E2E_10 monitor-switch no-consumer-leak (consumers=${sfuMid.consumerCount})`);

  // ---- Termination: student #7 via the monitoring API ----------------------
  const tp = publishers[TERMINATE_IDX];
  const tStarted = Date.now();
  await jsonFetch(`/api/v1/monitoring/students/${fx.students[TERMINATE_IDX].id}/terminate`, {
    method: 'POST',
    token: monitorToken,
    body: { reason: 'Automated 4D.3 termination isolation test' },
  });
  await waitFor(
    `student ${TERMINATE_IDX + 1} room gone`,
    async () => {
      const s = await sfuSnapshot();
      return !s.rooms.some((r) => r.participantId === tp.participantId);
    },
    25_000,
      500,
  );
  await waitFor(`publisher ${TERMINATE_IDX + 1} exited`, () => tp.exited, 30_000, 500);
  const dbAfterTerm = await dbSnapshot();
  const termRow = dbAfterTerm.participants.find((p) => p.id === tp.participantId);
  if (!termRow || termRow.status !== 'ENDED') fail(`terminated student row=${JSON.stringify(termRow)}`);
  const redisAfterTerm = await redisSnapshot();
  if (redisAfterTerm.rows.some((x) => x.participantId === tp.participantId)) {
    fail('terminated student still has Redis presence');
  }
  // Isolation: every OTHER publisher still holds with room + presence.
  for (const p of publishers) {
    if (p.idx === TERMINATE_IDX) continue;
    const room = (await sfuSnapshot()).rooms.find((r) => r.participantId === p.participantId);
    if (!room || (room.producers?.length ?? 0) !== 3) {
      fail(`student ${p.idx + 1} disrupted by termination (room=${room ? room.producers.length : 'gone'})`);
    }
  }
  log(
    `E2E_10 terminate student${TERMINATE_IDX + 1} PASS terminateToRoomGoneMs=${Date.now() - tStarted} row=${termRow.status} othersIntact=true`,
  );

  // ---- Peak snapshot captured; release all → submit → cleanup --------------
  const sfuPeak = await sfuSnapshot();
  const redisPeak = await redisSnapshot();
  for (const p of publishers) {
    if (!p.exited) fs.writeFileSync(p.holdFile, 'release');
  }
  for (const p of publishers) {
    const exit = await Promise.race([p.out.exit, SLEEP(60_000).then(() => -9)]);
    if (exit !== 0) log(`WARN publisher ${p.idx} exited ${exit}`);
  }
  await SLEEP(3_000);

  // ---- Final verification ---------------------------------------------------
  const sfuAfter = await sfuSnapshot();
  const redisAfter = await redisSnapshot();
  const dbAfter = await dbSnapshot();
  if (sfuAfter.rooms !== 0 || sfuAfter.producerCount !== 0 || sfuAfter.consumerCount !== 0) {
    fail(`SFU did not return to baseline: ${JSON.stringify({ rooms: sfuAfter.metrics.rooms, producers: sfuAfter.producerCount, consumers: sfuAfter.consumerCount })}`);
  }
  if (redisAfter.keys !== 0) fail(`Redis keys not cleaned: ${redisAfter.keys}`);
  const activeRows = dbAfter.participants.filter((p) => p.status === 'ACTIVE');
  if (activeRows.length !== 0) fail(`ACTIVE participants remain: ${activeRows.length}`);

  // Per-student timings
  const timings = publishers.map((p) => ({
    student: p.idx + 1,
    participantId: p.participantId?.slice(0, 8),
    timeToSfuVerifiedMs: p.sfuAt ? p.sfuAt - (p.joinedAt ?? p.sfuAt) : null,
    status: dbAfter.participants.find((x) => x.id === p.participantId)?.status ?? 'unknown',
  }));
  log(`E2E_10 timings ${JSON.stringify(timings)}`);

  // CPU util aggregates from the window samples (pct of wall interval).
  const pctOf = (g) =>
    samples.host
      .filter((h) => h && h.groups[g] && Number(h.groups[g].wallSeconds) > 0.5)
      .map((h) => (Number(h.groups[g].cpuSecondsSincePrev) / Number(h.groups[g].wallSeconds)) * 100);
  const stat = (arr) =>
    arr.length ? { avgPct: (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1), peakPct: Math.max(...arr).toFixed(1) } : null;
  const memStats = samples.host.filter(Boolean).map((h) => h.totalWsMB);
  const freeMin = Math.min(...samples.host.filter(Boolean).map((h) => h.freeMemMB));
  log(
    `E2E_10 report windowMs=${WINDOW_MS} sfuPeak=${JSON.stringify({ rooms: sfuPeak.metrics.rooms, producers: sfuPeak.producerCount, consumers: sfuPeak.consumerCount, transports: sfuPeak.transportCount })} redisPeakPresence=${redisPeak.presence} redisPeakOwners=${redisPeak.owners} hostPeak=${JSON.stringify(peakHost)} cpu=${JSON.stringify({ electron: stat(pctOf('electron')), sfu: stat(pctOf('sfu')), node: stat(pctOf('node')) })} memPeakMB=${Math.max(...memStats)} memMinFreeMB=${freeMin}`,
  );
  log(
    `TEN_STUDENT_E2E PASS (${STUDENT_COUNT} concurrent real publishers, monitor subs on students ${MONITOR_TARGETS.map((t) => t + 1).join('/')}, reconnect student ${RECONNECT_IDX + 1}, terminate student ${TERMINATE_IDX + 1}, baseline restored)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  try {
    fs.rmSync(HOLD_PREFIX, { force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});