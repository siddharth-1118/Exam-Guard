/**
 * ExamGuard Phase 4D.1 — realtime media-session cleanup E2E.
 *
 * Proves SERVER-SIDE lifecycle cleanup of live publisher resources. The WS
 * clients here behave like a crashed/uncooperative desktop: they join and then
 * simply stay connected — they NEVER send `leave` or a final cleanup request.
 * All teardown must come from the API + SFU.
 *
 * Legs:
 *   A submit    — student submits while gateway + SFU sockets are live:
 *                 gateway socket closed 4002, SFU room evicted, row ENDED,
 *                 audit written, second eviction idempotent (404).
 *   B terminate — monitor terminates while sockets are live: same guarantees.
 *   C duplicate — a second gateway publisher join for the same attempt is
 *                 rejected 409 (one live publisher per attempt).
 *   D reconnect — drop/join ×3 keeps the SAME participantId; dropping past the
 *                 sweep lease lands the row DISCONNECTED (never destroyed) and
 *                 a later join still restores ACTIVE with reconnected=true.
 *   E stale     — a CONNECTING row that never joined is swept to FAILED
 *                 (join-timeout) by the lease sweeper.
 *   F baseline  — after termination every attempt's rows are ENDED/FAILED and
 *                 the SFU holds zero rooms; diagnostics counters print.
 *
 * Requires the API running with a short sweep lease
 * (MEDIA_SWEEP_LEASE_MS=7000 MEDIA_SWEEP_INTERVAL_MS=3000), SFU on :4010.
 * Usage: node scripts/media-cleanup-e2e.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const { Client } = requireRoot('pg');
const { WebSocket } = createRequire(path.join(root, 'apps', 'student-desktop', 'package.json'))('ws');

const API = process.env.EXAMGUARD_API_URL || 'http://localhost:4000';
const API_WS = API.replace(/^http/, 'ws');
const SFU_HTTP = process.env.SFU_HTTP_URL || 'http://127.0.0.1:4010';
const SFU_WS = SFU_HTTP.replace(/^http/, 'ws');
const SFU_ADMIN_KEY = process.env.SFU_ADMIN_KEY || 'examguard-dev-sfu-admin-key';
const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://examguard:examguard@localhost:5433/examguard?schema=public';
const PASSWORD = 'ExamGuard!Desktop2026';
const STAMP = Date.now().toString(36);
const uniq = (p) => `${p}-${STAMP}@examguard.test`;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function log(msg) {
  console.log(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeOrg() {
  const reg = await jsonFetch('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: uniq('clean-admin'),
      password: PASSWORD,
      firstName: 'Cleanup',
      lastName: 'Admin',
      organizationName: `Cleanup ${STAMP}`,
    },
  });
  const adminToken = reg.body.accessToken;
  const exam = (
    await jsonFetch('/api/v1/exams', {
      method: 'POST',
      token: adminToken,
      body: {
        name: `Cleanup exam ${STAMP}`,
        durationMinutes: 20,
        maxAttempts: 1,
        autoSubmit: true,
        status: 'OPEN',
        settings: {
          cameraRequired: false,
          microphoneRequired: false,
          screenMonitoringRequired: false,
          identityVerificationRequired: false,
          aiProctoringEnabled: false,
        },
      },
    })
  ).body;

  const students = [];
  for (const label of ['A', 'B', 'C', 'E']) {
    const s = (
      await jsonFetch('/api/v1/students', {
        method: 'POST',
        token: adminToken,
        body: {
          email: uniq(`clean-student-${label.toLowerCase()}`),
          password: PASSWORD,
          firstName: `Clean${label}`,
          lastName: 'Student',
          studentCode: `CLEAN-${label}-${STAMP}`,
        },
      })
    ).body;
    students.push({ label, ...s });
  }
  await jsonFetch(`/api/v1/exams/${exam.id}/students`, {
    method: 'POST',
    token: adminToken,
    body: { studentIds: students.map((s) => s.id) },
  });
  return { adminToken, exam, students };
}

async function login(email) {
  const r = await jsonFetch('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  return r.body.accessToken;
}

async function startAttempt(student, token) {
  const r = await jsonFetch('/api/v1/attempts', {
    method: 'POST',
    token,
    body: {
      examId: student.examId,
      deviceInfo: { os: 'Windows', appVersion: '0.3.0-e2e' },
      consent: {
        version: '1',
        camera: false,
        microphone: false,
        screen: false,
        acceptedAt: new Date().toISOString(),
      },
    },
  });
  const attemptId = r.body.attempt.id;
  if (r.body.attempt.status !== 'ACTIVE') fail(`attempt not ACTIVE (${r.body.attempt.status})`);
  return attemptId;
}

async function createSessionAndToken(attemptId, token) {
  const session = (
    await jsonFetch('/api/v1/media/sessions', {
      method: 'POST',
      token,
      body: { attemptId },
    })
  ).body;
  const media = (
    await jsonFetch('/api/v1/media/token', {
      method: 'POST',
      token,
      body: { attemptId },
    })
  ).body;
  return { participantId: session.participantId, mediaToken: media.token };
}

// Gateway publisher socket: joins, then stays open (never sends leave).
function gatewayJoin(attemptId, accessToken) {
  const ws = new WebSocket(`${API_WS}/api/v1/media/ws`);
  const handle = {
    ws,
    joined: false,
    participantId: null,
    state: null,
    reconnected: false,
    closeInfo: null,
    closePromise: new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        handle.closeInfo = { code, reason: String(reason) };
        resolve(handle.closeInfo);
      });
    }),
  };
  const timeout = setTimeout(() => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    fail('gateway join timed out');
  }, 10_000);
  ws.on('open', () =>
    ws.send(JSON.stringify({ type: 'media-session-join', data: { token: accessToken, attemptId } })),
  );
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.type === 'joined') {
      clearTimeout(timeout);
      handle.joined = true;
      handle.participantId = m.data?.participantId ?? null;
      handle.state = m.data?.state ?? null;
      handle.reconnected = Boolean(m.data?.reconnected);
    } else if (m.type === 'media-error') {
      handle.error = { code: m.data?.code, message: m.data?.message };
      clearTimeout(timeout);
    }
  });
  return handle;
}

async function gatewayJoinOk(attemptId, accessToken) {
  const h = gatewayJoin(attemptId, accessToken);
  await waitFor('gateway joined', () => (h.joined || h.error ? true : false), 10_000, 100);
  if (h.error) fail(`gateway join error ${h.error.code}: ${h.error.message}`);
  return h;
}

// SFU publisher socket: joins a room (real media tokens / protocol frames).
function sfuJoin(mediaToken) {
  const ws = new WebSocket(`${SFU_WS}/sfu`);
  const handle = {
    ws,
    joined: false,
    error: null,
    closeInfo: null,
    closePromise: new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        handle.closeInfo = { code, reason: String(reason) };
        resolve(handle.closeInfo);
      });
    }),
  };
  const timeout = setTimeout(() => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    fail('sfu join timed out');
  }, 10_000);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', data: { token: mediaToken } })));
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.type === 'joined') {
      clearTimeout(timeout);
      handle.joined = true;
      handle.roomId = m.data?.roomId ?? null;
    } else if (m.type === 'error') {
      handle.error = { code: m.data?.code, message: m.data?.message };
      clearTimeout(timeout);
    }
  });
  return handle;
}

async function sfuJoinOk(mediaToken) {
  const h = sfuJoin(mediaToken);
  await waitFor('sfu joined', () => (h.joined || h.error ? true : false), 10_000, 100);
  if (h.error) fail(`sfu join error ${h.error.code}: ${h.error.message}`);
  return h;
}

async function sfuRooms() {
  const res = await fetch(`${SFU_HTTP}/status`);
  const json = await res.json();
  return json.rooms ?? [];
}
const sfuRoomCountFor = async (participantId) =>
  (await sfuRooms()).filter((r) => r.participantId === participantId).length;

async function db(sql, params = []) {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    await client.end();
  }
}

async function participantState(participantId) {
  const rows = await db('select "status" from "MediaParticipant" where id = $1', [participantId]);
  return rows[0]?.status ?? null;
}

async function hasAudit(attemptId, action, detailCheck) {
  const rows = await db(
    'select 1 from "AuditLog" where "resourceId" = $1 and action = $2 and detail::text like $3 limit 1',
    [attemptId, action, detailCheck],
  );
  return rows.length > 0;
}

async function sessionView(participantId, adminToken) {
  const r = await jsonFetch(`/api/v1/media/sessions/${participantId}`, {
    token: adminToken,
  });
  return r.body;
}

async function attemptStatus(attemptId, adminToken) {
  const r = await jsonFetch(`/api/v1/attempts/${attemptId}`, { token: adminToken });
  return r.body.attempt.status;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiHealth = await fetch(`${API}/health`).catch(() => null);
  const sfuHealth = await fetch(`${SFU_HTTP}/health`).catch(() => null);
  if (!apiHealth?.ok) fail(`API not reachable on ${API}`);
  if (!sfuHealth?.ok) fail(`SFU not reachable on ${SFU_HTTP}`);

  const org = await makeOrg();
  const { exam, adminToken } = org;
  const students = org.students.map((s) => ({ ...s, examId: exam.id }));
  log(`Fixture ready: org exam=${exam.id} students=${students.map((s) => s.label).join(',')}`);

  const results = [];
  const track = (name, value) => {
    results.push(`${name}=${value}`);
    log(`E2E_CLEANUP ${name} ${value}`);
  };

  // ---- Leg A: submit while the publisher sockets are live (no client leave) --
  {
    const student = students.find((s) => s.label === 'A');
    const token = await login(student.email);
    const attemptId = await startAttempt(student, token);
    const { participantId, mediaToken } = await createSessionAndToken(attemptId, token);

    const gw = await gatewayJoinOk(attemptId, token);
    if (gw.participantId !== participantId) fail('gateway participantId mismatch');
    const sfu = await sfuJoinOk(mediaToken);
    await waitFor('sfu room appears', async () => (await sfuRoomCountFor(participantId)) === 1, 8_000);
    track('submit room-live-before', true);

    // Submit — the sockets never send leave; cleanup must be server-initiated.
    await jsonFetch(`/api/v1/attempts/${attemptId}/submit`, { method: 'POST', token });
    track('submit status', await attemptStatus(attemptId, adminToken));

    const gwClose = await gw.closePromise;
    const sfuClose = await sfu.closePromise;
    if (gwClose.code !== 4002) fail(`gateway close ${JSON.stringify(gwClose)} (expected 4002)`);
    track('submit gateway-close-4002', true);
    if (sfuClose.code !== 4002) fail(`sfu close ${JSON.stringify(sfuClose)} (expected 4002)`);
    track('submit sfu-close-4002', true);

    await waitFor('sfu room evicted', async () => (await sfuRoomCountFor(participantId)) === 0, 8_000);
    track('submit sfu-room-evicted', true);

    const rowState = await waitFor('participant row ENDED', async () => {
      const st = await participantState(participantId);
      return st === 'ENDED' ? st : null;
    }, 8_000);
    track('submit row-ended', rowState);
    const viaApi = await sessionView(participantId, adminToken);
    if (viaApi.state !== 'ENDED') fail(`session API state ${viaApi.state}`);
    track('submit api-state-ended', true);
    if (!(await hasAudit(attemptId, 'media.session.ended', '%"cause": "attempt.submit"%'))) {
      fail('missing server-initiated media.session.ended audit (submit)');
    }
    track('submit audit', true);

    // Idempotency: evicting an already-gone room is a 404, never an error.
    const again = await fetch(`${SFU_HTTP}/admin/evict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sfu-admin-key': SFU_ADMIN_KEY },
      body: JSON.stringify({ participantId, reason: 'probe' }),
    });
    if (again.status !== 404) fail(`second evict -> ${again.status} (expected 404)`);
    track('evict idempotent-404', true);

    if (sfu.ws.readyState !== WebSocket.CLOSED) sfu.ws.close();
  }

  // ---- Leg B: monitor TERMINATE while sockets are live ---------------------
  {
    const student = students.find((s) => s.label === 'B');
    const token = await login(student.email);
    const attemptId = await startAttempt(student, token);
    const { participantId, mediaToken } = await createSessionAndToken(attemptId, token);

    const gw = await gatewayJoinOk(attemptId, token);
    const sfu = await sfuJoinOk(mediaToken);
    await waitFor('sfu room appears', async () => (await sfuRoomCountFor(participantId)) === 1, 8_000);

    await jsonFetch(`/api/v1/monitoring/students/${student.id}/terminate`, {
      method: 'POST',
      token: adminToken,
      body: { reason: 'cleanup e2e terminate' },
    });
    track('terminate status', await attemptStatus(attemptId, adminToken));

    const gwClose = await gw.closePromise;
    const sfuClose = await sfu.closePromise;
    if (gwClose.code !== 4002) fail(`gateway close ${JSON.stringify(gwClose)} (expected 4002)`);
    track('terminate gateway-close-4002', true);
    if (sfuClose.code !== 4002) fail(`sfu close ${JSON.stringify(sfuClose)} (expected 4002)`);
    track('terminate sfu-close-4002', true);

    await waitFor('sfu room evicted', async () => (await sfuRoomCountFor(participantId)) === 0, 8_000);
    const rowState = await waitFor('participant row ENDED', async () => {
      const st = await participantState(participantId);
      return st === 'ENDED' ? st : null;
    }, 8_000);
    track('terminate row-ended', rowState);
    if (!(await hasAudit(attemptId, 'media.session.ended', '%"cause": "attempt.terminate"%'))) {
      fail('missing server-initiated media.session.ended audit (terminate)');
    }
    track('terminate audit', true);
    if (sfu.ws.readyState !== WebSocket.CLOSED) sfu.ws.close();
  }

  // ---- Leg C+D: duplicate rejection + reconnect (same participant) ----------
  {
    const student = students.find((s) => s.label === 'C');
    const token = await login(student.email);
    const attemptId = await startAttempt(student, token);
    const { participantId } = await createSessionAndToken(attemptId, token);

    // Duplicate: second live publisher connection for the same attempt → 409.
    const first = await gatewayJoinOk(attemptId, token);
    const second = gatewayJoin(attemptId, token);
    await waitFor('duplicate rejected', () => (second.error ? true : false), 8_000, 100);
    if (second.error.code !== 409) fail(`duplicate join -> ${JSON.stringify(second.error)} (expected 409)`);
    second.ws.close();
    track('duplicate rejected-409', true);

    // The original connection is untouched and still owns the slot.
    first.ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitFor('pong on first connection', async () => {
      return await new Promise((resolve) => {
        const onMsg = (raw) => {
          try {
            const m = JSON.parse(String(raw));
            if (m.type === 'pong') {
              first.ws.off('message', onMsg);
              resolve(true);
            }
          } catch {
            /* ignore */
          }
        };
        first.ws.on('message', onMsg);
        setTimeout(() => resolve(false), 4_000);
      });
    }, 6_000);
    if (!pong) fail('first publisher connection did not stay healthy');
    track('duplicate first-connection-healthy', true);

    // Reconnect cycles: drop → join → drop → join, always the SAME participant.
    // After each drop we wait for the row to reach RECONNECTING (the async
    // ACTIVE→RECONNECTING transition) so the rejoin is a true reconnect rather
    // than racing the server's socket-close handling.
    let active = first; // current open publisher connection
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      active.ws.close();
      await active.closePromise;
      await waitFor('row RECONNECTING', async () => {
        const st = await participantState(participantId);
        return st === 'RECONNECTING';
      }, 4_000, 120);
      const again = await gatewayJoinOk(attemptId, token);
      if (again.participantId !== participantId) {
        fail(`reconnect cycle ${cycle} changed participant (${again.participantId})`);
      }
      if (!again.reconnected) fail(`cycle ${cycle} not flagged as reconnect`);
      track(`reconnect cycle${cycle} same-participant`, again.reconnected);
      active = again;
    }
    // Drop the last connection and let the lease walk ACTIVE → RECONNECTING →
    // DISCONNECTED (never destroys the row while the attempt is still open).
    active.ws.close();
    await active.closePromise;

    const disconnected = await waitFor('row swept DISCONNECTED after grace', async () => {
      const st = await participantState(participantId);
      return st === 'DISCONNECTED' ? st : null;
    }, 20_000, 1_000);
    track('reconnect-after-grace row-disconnected', disconnected);

    // Attempt is still ACTIVE → a later join must restore the SAME participant.
    const late = await gatewayJoinOk(attemptId, token);
    if (late.participantId !== participantId || !late.reconnected || late.state !== 'ACTIVE') {
      fail(`late reconnect unexpected ${JSON.stringify({ p: late.participantId, r: late.reconnected, s: late.state })}`);
    }
    track('reconnect-after-grace restores-active', true);
    late.ws.close();

    // Cleanup: end the attempt (row DISCONNECTED is ended by the terminate hook).
    await jsonFetch(`/api/v1/monitoring/students/${student.id}/terminate`, {
      method: 'POST',
      token: adminToken,
      body: { reason: 'cleanup e2e close leg C' },
    });
    track('legC cleanup terminated', await attemptStatus(attemptId, adminToken));
  }

  // ---- Leg E: stale CONNECTING row swept to FAILED (never joined) -----------
  {
    const student = students.find((s) => s.label === 'E');
    const token = await login(student.email);
    const attemptId = await startAttempt(student, token);
    const session = (
      await jsonFetch('/api/v1/media/sessions', {
        method: 'POST',
        token,
        body: { attemptId },
      })
    ).body;
    const participantId = session.participantId;
    if (session.state !== 'CONNECTING') fail(`session state ${session.state}`);

    const failed = await waitFor('stale CONNECTING swept to FAILED', async () => {
      const st = await participantState(participantId);
      return st === 'FAILED' ? st : null;
    }, 25_000, 1_000);
    track('stale-connecting swept-failed', failed);
    if (!(await hasAudit(attemptId, 'media.session.failed', '%"reason": "join-timeout"%'))) {
      fail('missing sweeper media.session.failed audit (join-timeout)');
    }
    track('stale-connecting audit', true);

    await jsonFetch(`/api/v1/monitoring/students/${student.id}/terminate`, {
      method: 'POST',
      token: adminToken,
      body: { reason: 'cleanup e2e close leg E' },
    });
    track('legE cleanup terminated', await attemptStatus(attemptId, adminToken));
  }

  // ---- Leg F: baseline — nothing left behind -------------------------------
  const rooms = await sfuRooms();
  if (rooms.length !== 0) fail(`SFU left ${rooms.length} rooms behind: ${JSON.stringify(rooms)}`);
  track('sfu zero-rooms', true);

  const leftovers = await db(
    `select count(*)::int as n from "MediaParticipant" mp
     join "ExamAttempt" ea on ea.id = mp."attemptId"
     where ea."examId" = $1 and mp.status in ('CONNECTING','ACTIVE','RECONNECTING','DISCONNECTED')`,
    [exam.id],
  );
  if (leftovers[0].n !== 0) fail(`left ${leftovers[0].n} non-terminal participant rows`);
  track('db zero-active-participants', true);

  const diag = (
    await jsonFetch('/api/v1/media/sessions/diagnostics', { token: adminToken })
  ).body;
  log(
    `E2E_CLEANUP diagnostics ${JSON.stringify({
      gateway: diag.gateway,
      sweeper: diag.sweeper,
    })}`,
  );

  log(`MEDIA_CLEANUP_E2E PASS (${results.join(' ')})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
