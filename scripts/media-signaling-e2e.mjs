/**
 * ExamGuard Phase 4A — media-session control-plane E2E.
 *
 * Verifies the REAL authenticated media-session lifecycle end to end (no media
 * transport — that is Phase 4B):
 *
 *   Login → start active exam → create media session → WebSocket connect →
 *   authenticate → join → CONNECTED → disconnect → reconnect → SAME participant
 *   → duplicate connection rejected → idempotent end → ENDED
 *
 * plus REST security checks (cross-tenant, cross-student, discovery
 * authorization) against the live API. Phase 3 device/media E2Es already prove
 * camera/mic/screen acquisition — nothing here transmits media.
 *
 * Prereqs: API on http://localhost:4000 (with media gateway) + migrated dev
 * Postgres on 5433. Usage: node scripts/media-signaling-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.EXAMGUARD_API_URL ?? 'http://localhost:4000';
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
      durationMinutes: 30,
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
  })).body;
  await jsonFetch(`/api/v1/exams/${exam.id}/students`, {
    method: 'POST',
    token: adminToken,
    body: { studentIds: [student.id] },
  });
  return { adminToken, student, studentEmail, exam };
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error('API not reachable. Start it first.');
    process.exit(2);
  }

  // 1. Fixtures: two organizations (tenant-isolation target) -----------------
  const orgA = await makeOrg('OrgA');
  const orgB = await makeOrg('OrgB');
  console.log(
    `Fixture ready: orgA-exam=${orgA.exam.id} studentA=${orgA.studentEmail} orgB-exam=${orgB.exam.id} studentB=${orgB.studentEmail}`,
  );

  // 2. Real Electron app: full control-plane flow with markers ----------------
  const appDir = path.join(__dirname, '..', 'apps', 'student-desktop');
  const requireFromApp = createRequire(path.join(appDir, 'package.json'));
  const electronBin = requireFromApp('electron');
  const child = spawn(electronBin, ['.'], {
    cwd: appDir,
    env: {
      ...process.env,
      EXAMGUARD_E2E: '1',
      EXAMGUARD_E2E_MEDIA_SIGNALING: '1',
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

  const WATCHDOG_MS = 150_000;
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
    /E2E_STEP start ACTIVE remainingMs=\d+/,
    /E2E_MEDIA_SIGNALING created \{[^}]*"state":"(CONNECTING|ACTIVE)"/,
    /E2E_MEDIA_SIGNALING create-idempotent/,
    /E2E_MEDIA_SIGNALING joined \{[^}]*"state":"ACTIVE"/,
    /E2E_MEDIA_SIGNALING duplicate-rejected \{"code":409\}/,
    /E2E_MEDIA_SIGNALING reconnected \{[^}]*"state":"ACTIVE"/,
    /E2E_MEDIA_SIGNALING ended \{[^}]*"state":"ENDED"/,
    /E2E_MEDIA_SIGNALING end-idempotent/,
    /E2E_STEP submit (SUBMITTED|AUTO_SUBMITTED)/,
    /E2E_OK/,
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
  const createdMatch = out.match(/E2E_MEDIA_SIGNALING created (\{.*?\})/);
  const reconnectedMatch = out.match(/E2E_MEDIA_SIGNALING reconnected (\{.*?\})/);
  const created = createdMatch ? JSON.parse(createdMatch[1]) : null;
  const reconnected = reconnectedMatch ? JSON.parse(reconnectedMatch[1]) : null;
  if (!created || !reconnected) {
    console.error('FAIL: could not parse app markers');
    process.exit(1);
  }
  if (created.participantId !== reconnected.participantId || created.mediaSessionId !== reconnected.mediaSessionId) {
    console.error('FAIL: reconnect did not preserve participant identity');
    process.exit(1);
  }
  console.log(`E2E_SECURITY reconnect-same-participant ${created.participantId === reconnected.participantId}`);
  const { mediaSessionId } = created;

  // 3. REST security checks (real API + fresh tokens, post-submit attempt) ----
  const loginA = await jsonFetch('/api/v1/auth/login', {
    method: 'POST',
    body: { email: orgA.studentEmail, password: PASSWORD },
  });
  const loginB = await jsonFetch('/api/v1/auth/login', {
    method: 'POST',
    body: { email: orgB.studentEmail, password: PASSWORD },
  });
  const tokenA = loginA.body.accessToken;
  const tokenB = loginB.body.accessToken;

  // Owner can still read the session (now ENDED). The row shows endedAt.
  const own = await jsonFetch(`/api/v1/media/sessions/${mediaSessionId}`, { token: tokenA });
  console.log(`E2E_SECURITY owner-get ${own.status} state=${own.body.state} attempt=${own.body.attemptId}`);
  if (own.body.state !== 'ENDED' || !own.body.endedAt) {
    console.error('FAIL: ended session not reflected in owner read');
    process.exit(1);
  }

  // Student B cannot read Org A's session nor create one for Org A's attempt.
  await expectDenied('cross-student session get', () =>
    jsonFetch(`/api/v1/media/sessions/${mediaSessionId}`, { token: tokenB, ok: true }),
  );
  await expectDenied('cross-org session create', () =>
    jsonFetch('/api/v1/media/sessions', { method: 'POST', token: tokenB, body: { attemptId: own.body.attemptId }, ok: true }),
  );

  // Discovery: a student lacks media:subscribe; Org B admin cannot see Org A's exam.
  await expectDenied('student discovery forbidden', () =>
    jsonFetch(`/api/v1/media/sessions?examId=${orgA.exam.id}`, { token: tokenA, ok: true }),
  );
  await expectDenied('cross-org discovery', () =>
    jsonFetch(`/api/v1/media/sessions?examId=${orgA.exam.id}`, { token: orgB.adminToken, ok: true }),
  );

  // Authorized discovery (Org A admin) returns metadata for the publisher.
  const discover = await jsonFetch(`/api/v1/media/sessions?examId=${orgA.exam.id}`, {
    token: orgA.adminToken,
  });
  const found = (discover.body ?? []).some((s) => s.mediaSessionId === mediaSessionId);
  console.log(`E2E_SECURITY discovery ${found ? 'PASS' : 'FAIL'}`);
  if (!found) {
    console.error(JSON.stringify(discover.body).slice(0, 400));
    process.exit(1);
  }

  console.log(
    'MEDIA_SIGNALING_E2E PASS (control plane: REST authz + create/join/reconnect-same-participant/duplicate-reject/idempotent-end + tenant isolation)',
  );
}

main().catch((err) => {
  console.error('MEDIA_SIGNALING_E2E FAIL:', err.message);
  process.exit(1);
});
