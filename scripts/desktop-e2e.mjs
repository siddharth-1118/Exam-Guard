/**
 * ExamGuard student-desktop end-to-end verification.
 *
 * Creates a fresh org + student + OPEN exam (with one MCQ) through the real
 * API, then launches the REAL Electron app in EXAMGUARD_E2E mode and asserts
 * the marker sequence: login -> exams -> start -> answer saved (outbox
 * delivered to the server) -> heartbeat -> submit -> logout.
 *
 * Prereqs: API on http://localhost:4000 with a migrated dev Postgres on 5433.
 * Usage:    node scripts/desktop-e2e.mjs
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
  return parsed;
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error('API not reachable. Start it first (see docs/DESKTOP.md).');
    process.exit(2);
  }

  // 1. Fixture over the real API -------------------------------------------
  const orgName = `Desktop E2E ${STAMP}`;
  const adminEmail = uniq('admin');
  const reg = await jsonFetch('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: adminEmail,
      password: PASSWORD,
      firstName: 'E2E',
      lastName: 'Admin',
      organizationName: orgName,
    },
  });
  const adminToken = reg.accessToken;

  const studentEmail = uniq('student');
  const student = await jsonFetch('/api/v1/students', {
    method: 'POST',
    token: adminToken,
    body: {
      email: studentEmail,
      password: PASSWORD,
      firstName: 'E2E',
      lastName: 'Student',
      studentCode: `DESK-${STAMP}`,
    },
  });

  const exam = await jsonFetch('/api/v1/exams', {
    method: 'POST',
    token: adminToken,
    body: {
      name: `Desktop E2E ${STAMP}`,
      description: 'Automated desktop end-to-end',
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
  });

  const question = await jsonFetch('/api/v1/questions', {
    method: 'POST',
    token: adminToken,
    body: {
      type: 'SINGLE_CHOICE',
      text: 'E2E: which option is correct?',
      marks: 1,
      options: [
        { text: 'Alpha', isCorrect: true, order: 1 },
        { text: 'Beta', isCorrect: false, order: 2 },
      ],
    },
  });
  await jsonFetch(`/api/v1/exams/${exam.id}/questions`, {
    method: 'POST',
    token: adminToken,
    body: { questionIds: [question.id] },
  });
  await jsonFetch(`/api/v1/exams/${exam.id}/students`, {
    method: 'POST',
    token: adminToken,
    body: { studentIds: [student.id] },
  });
  console.log(`Fixture ready: org=${orgName} exam=${exam.id} student=${student.email}`);

  // 2. Launch the real Electron app in E2E mode ----------------------------
  const appDir = path.join(__dirname, '..', 'apps', 'student-desktop');
  const requireFromApp = createRequire(path.join(appDir, 'package.json'));
  const electronBin = requireFromApp('electron'); // path to the real binary
  const child = spawn(electronBin, ['.'], {
    cwd: appDir,
    env: {
      ...process.env,
      EXAMGUARD_E2E: '1',
      EXAMGUARD_E2E_EMAIL: studentEmail,
      EXAMGUARD_E2E_PASSWORD: PASSWORD,
      EXAMGUARD_API_URL: API,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Stream output live (a silent stall must be visible) and watchdog the app.
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

  const WATCHDOG_MS = 120_000;
  const exit = await new Promise((resolve) => {
    const watchdog = setTimeout(() => {
      console.error(`TIMEOUT after ${WATCHDOG_MS / 1000}s — killing electron (pid ${child.pid}).`);
      console.error(`Last app output:\n${out.trim() || '(none)'}`);
      console.error(`Last app stderr:\n${err.trim() || '(none)'}`);
      child.kill('SIGKILL');
      resolve(-2);
    }, WATCHDOG_MS);
    child.on('exit', (code) => {
      clearTimeout(watchdog);
      resolve(code ?? -1);
    });
  });

  const required = [
    /E2E_STEP login/,
    /E2E_STEP exams/,
    /E2E_STEP start ACTIVE remainingMs=\d+/,
    /E2E_STEP answer saved/,
    /E2E_STEP heartbeat/,
    /E2E_STEP proctoring event delivered/,
    /E2E_STEP submit (SUBMITTED|AUTO_SUBMITTED)/,
    /E2E_OK/,
  ];
  for (const re of required) {
    if (!re.test(out)) {
      console.error(`FAIL: missing marker ${re}`);
      process.exit(1);
    }
  }
  if (exit !== 0) {
    console.error(`FAIL: electron exited ${exit}`);
    process.exit(1);
  }
  console.log('DESKTOP_E2E PASS');
}

main().catch((err) => {
  console.error('DESKTOP_E2E FAIL:', err.message);
  process.exit(1);
});
