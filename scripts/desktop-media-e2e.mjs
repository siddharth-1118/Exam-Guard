/**
 * ExamGuard student-desktop media verification (Phase 3B).
 *
 * Like scripts/desktop-e2e.mjs, but the fixture exam REQUIRES camera +
 * microphone and the Electron app runs with EXAMGUARD_E2E_MEDIA=1, so after
 * the attempt starts it probes the REAL camera/microphone inside the real
 * renderer (getUserMedia + pixel-level frame check) and pushes the actual
 * device state through the real outbox → /api/v1/proctoring/events → Postgres
 * pipeline.
 *
 * Prereqs: API on http://localhost:4000 with a migrated dev Postgres on 5433.
 * Usage:    node scripts/desktop-media-e2e.mjs
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
    console.error('API not reachable. Start it first.');
    process.exit(2);
  }

  // 1. Fixture: exam REQUIRES camera + microphone ---------------------------
  const orgName = `Media E2E ${STAMP}`;
  const reg = await jsonFetch('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: uniq('admin'),
      password: PASSWORD,
      firstName: 'Media',
      lastName: 'Admin',
      organizationName: orgName,
    },
  });
  const adminToken = reg.accessToken;

  const studentEmail = uniq('media-student');
  const student = await jsonFetch('/api/v1/students', {
    method: 'POST',
    token: adminToken,
    body: {
      email: studentEmail,
      password: PASSWORD,
      firstName: 'Media',
      lastName: 'Student',
      studentCode: `MEDIA-${STAMP}`,
    },
  });

  const exam = await jsonFetch('/api/v1/exams', {
    method: 'POST',
    token: adminToken,
    body: {
      name: `Media E2E ${STAMP}`,
      durationMinutes: 30,
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
  });

  const question = await jsonFetch('/api/v1/questions', {
    method: 'POST',
    token: adminToken,
    body: {
      type: 'SINGLE_CHOICE',
      text: 'Media E2E: which option is correct?',
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
  console.log(`Fixture ready: exam=${exam.id} student=${studentEmail}`);

  // 2. Launch the real Electron app with the media leg enabled --------------
  const appDir = path.join(__dirname, '..', 'apps', 'student-desktop');
  const requireFromApp = createRequire(path.join(appDir, 'package.json'));
  const electronBin = requireFromApp('electron');
  const child = spawn(electronBin, ['.'], {
    cwd: appDir,
    env: {
      ...process.env,
      EXAMGUARD_E2E: '1',
      EXAMGUARD_E2E_MEDIA: '1',
      EXAMGUARD_E2E_EMAIL: studentEmail,
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
    /E2E_STEP login/,
    /E2E_STEP start ACTIVE remainingMs=\d+/,
    /E2E_MEDIA \{"camera":"(ok|denied|unavailable|error)","mic":"(ok|denied|unavailable|error)"/,
    /E2E_MEDIA_SCREEN \{"screen":"(ok|denied|unavailable|error)"/,
    /E2E_STEP media events delivered/,
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

  // Report the real hardware outcome factually.
  const mediaMatch = out.match(/E2E_MEDIA (\{.*\})/);
  const media = mediaMatch ? JSON.parse(mediaMatch[1]) : null;
  const screenMatch = out.match(/E2E_MEDIA_SCREEN (\{.*\})/);
  const screen = screenMatch ? JSON.parse(screenMatch[1]) : null;
  if (media) {
    console.log(
      'DESKTOP_MEDIA_E2E PASS (real devices exercised: camera=' +
        media.camera +
        ' frames=' +
        media.cameraFrames +
        ' mic=' +
        media.mic +
        ' screen=' +
        (screen ? screen.screen : 'unknown') +
        ' screenFrames=' +
        (screen ? screen.screenFrames : 'unknown'),
    );
  }
}

main().catch((err) => {
  console.error('DESKTOP_MEDIA_E2E FAIL:', err.message);
  process.exit(1);
});
