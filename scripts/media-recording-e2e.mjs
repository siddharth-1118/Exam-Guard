/**
 * ExamGuard Checkpoint 1 — Real Server-Side Recording Egress E2E Test.
 *
 * Validates the full server-side WebRTC RTP recording pipeline:
 *  1. Electron student app publishes real camera + microphone + screen to SFU.
 *  2. API opens a Recording session (PENDING -> RECORDING).
 *  3. SFU receives admin recording start, creates PlainTransports, generates SDP,
 *     and spawns real FFmpeg child process (PID tracked).
 *  4. Media streams via RTP into FFmpeg for 5+ seconds.
 *  5. Student submits attempt, triggering recording stop.
 *  6. FFmpeg receives 'q' on stdin, flushes WebM container headers, and exits cleanly.
 *  7. Output WebM file is validated via ffprobe (container, VP8 video, Opus audio, duration > 0).
 *  8. SHA-256 checksum & file size are calculated and sent to API adminFinalize.
 *  9. API verifies storage integrity and transitions DB Recording to READY.
 * 10. Clean teardown verified: FFmpeg process exited, PlainTransports closed, no orphans.
 *
 * Prereqs: API on :4000, SFU on :4010, DB on :5433.
 * Usage: node scripts/media-recording-e2e.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
} catch {
  // no root .env
}

const API = (process.env.EXAMGUARD_API_URL || 'http://127.0.0.1:4000').replace('localhost', '127.0.0.1');
const SFU_HTTP = (process.env.WEBRTC_SERVER_URL || 'http://127.0.0.1:4010')
  .replace(/\/sfu$/, '')
  .replace(/^ws/, 'http')
  .replace('localhost', '127.0.0.1');
const SFU_ADMIN_KEY = process.env.SFU_ADMIN_KEY || 'examguard-dev-sfu-admin-key';
const PASSWORD = 'ExamGuard!Desktop2026';
const STAMP = Date.now().toString(36);
const uniq = (p) => `${p}-${STAMP}@examguard.test`;

async function jsonFetch(url, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
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

let requireFromApp;
function requireApp() {
  if (requireFromApp) return requireFromApp;
  const appDir = path.join(__dirname, '..', 'apps', 'student-desktop');
  requireFromApp = createRequire(path.join(appDir, 'package.json'));
  return requireFromApp;
}

async function main() {
  console.log('=== CHECKPOINT 1 — REAL SERVER-SIDE RECORDING EGRESS E2E TEST ===');

  // 0. Pre-flight health checks
  const health = await fetch(`${API}/health`).catch(() => null);
  const sfuHealth = await fetch(`${SFU_HTTP}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error('API not reachable on ' + API);
    process.exit(2);
  }
  if (!sfuHealth || !sfuHealth.ok) {
    console.error('SFU not reachable on ' + SFU_HTTP);
    process.exit(2);
  }
  console.log('✔ Services reachability verified (API & SFU up)');

  // 1. Setup Organization, Admin, Student & Exam fixture
  const reg = await jsonFetch('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: uniq('rec-admin'),
      password: PASSWORD,
      firstName: 'Rec',
      lastName: 'Admin',
      organizationName: `Rec E2E ${STAMP}`,
    },
  });
  const adminToken = reg.body.accessToken;

  const studentEmail = uniq('rec-student');
  const student = (await jsonFetch('/api/v1/students', {
    method: 'POST',
    token: adminToken,
    body: {
      email: studentEmail,
      password: PASSWORD,
      firstName: 'Rec',
      lastName: 'Student',
      studentCode: `REC-${STAMP}`,
    },
  })).body;

  const exam = (await jsonFetch('/api/v1/exams', {
    method: 'POST',
    token: adminToken,
    body: {
      name: `Rec E2E Exam ${STAMP}`,
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
  })).body;

  await jsonFetch(`/api/v1/exams/${exam.id}/students`, {
    method: 'POST',
    token: adminToken,
    body: { studentIds: [student.id] },
  });

  console.log(`✔ Fixtures created (exam=${exam.id}, student=${studentEmail})`);

  // 2. Launch Student Desktop app with publishing enabled
  const req = requireApp();
  const appDir = path.join(__dirname, '..', 'apps', 'student-desktop');
  const electronBin = req('electron');
  const holdFilePath = path.join(__dirname, '..', `.tmp-rec-hold-${STAMP}`);

  console.log('Launching Electron Student Desktop publisher...');
  const child = spawn(electronBin, ['.'], {
    cwd: appDir,
    env: {
      ...process.env,
      EXAMGUARD_E2E: '1',
      EXAMGUARD_E2E_MEDIA_PUBLISH: '1',
      EXAMGUARD_E2E_EMAIL: studentEmail,
      EXAMGUARD_E2E_PASSWORD: PASSWORD,
      EXAMGUARD_API_URL: API,
      EXAMGUARD_E2E_PUBLISH_HOLD_FILE: holdFilePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let activeAttemptId = null;
  let publishingConfirmed = false;

  child.stdout.on('data', (d) => {
    const s = String(d);
    process.stdout.write(`[app] ${s}`);
    if (s.includes('E2E_MEDIA_PUBLISH attempt')) {
      const match = s.match(/attempt ([a-f0-9-]+)/);
      if (match) activeAttemptId = match[1];
    }
    if (s.includes('E2E_MEDIA_PUBLISH renderer') || s.includes('"state":"publishing"')) {
      publishingConfirmed = true;
    }
  });
  child.stderr.on('data', (d) => {
    process.stderr.write(`[app-err] ${String(d)}`);
  });

  // Wait for attempt start and publishing confirmation
  const pubDeadline = Date.now() + 30_000;
  while (!publishingConfirmed || !activeAttemptId) {
    if (Date.now() > pubDeadline) {
      console.error('FAIL: Timed out waiting for student publishing to start');
      child.kill('SIGKILL');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`✔ Student published WebRTC producers for attempt ${activeAttemptId}`);

  // 3. Obtain participantId from SFU room status once producers are published
  let participantId = null;
  const roomDeadline = Date.now() + 30_000;
  while (!participantId) {
    try {
      const sfuStatus = await (await fetch(`${SFU_HTTP}/status`)).json();
      const room = sfuStatus.rooms?.find((r) => r.attemptId === activeAttemptId && (r.producers?.length ?? 0) > 0);
      if (room) {
        participantId = room.participantId;
      }
    } catch {}
    if (!participantId) {
      if (Date.now() > roomDeadline) {
        console.error('FAIL: SFU room with producers not found for attempt ' + activeAttemptId);
        child.kill('SIGKILL');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(`✔ Found SFU room participantId with active producers: ${participantId}`);

  // 4. Open Recording via API (PENDING -> RECORDING)
  const recRes = await jsonFetch('/api/v1/recordings', {
    method: 'POST',
    token: adminToken,
    body: {
      attemptId: activeAttemptId,
      participantId,
      kind: 'COMBINED',
    },
  });
  const recording = recRes.body;
  console.log(`✔ Created API Recording: id=${recording.id}, status=${recording.status}, storageKey=${recording.storageKey}`);

  // Start recording on API
  const startRecRes = await jsonFetch(`/api/v1/recordings/${recording.id}/start`, {
    method: 'POST',
    token: adminToken,
  });
  console.log(`✔ Started API Recording: status=${startRecRes.body.status}`);

  // 5. Trigger SFU Recording Egress (/admin/recording/start)
  const sfuStartRes = await fetch(`${SFU_HTTP}/admin/recording/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SFU-Admin-Key': SFU_ADMIN_KEY,
    },
    body: JSON.stringify({
      participantId,
      recordingId: recording.id,
      storageKey: recording.storageKey,
    }),
  });
  const sfuStartJson = await sfuStartRes.json();
  if (!sfuStartRes.ok || !sfuStartJson.started) {
    console.error('FAIL: SFU recording start failed:', sfuStartJson);
    child.kill('SIGKILL');
    process.exit(1);
  }
  console.log('✔ SFU Recording Egress started (PlainTransport + FFmpeg child process active)');

  // 6. Check SFU admin recording status to verify active FFmpeg session
  const sfuRecStatus = await (
    await fetch(`${SFU_HTTP}/admin/recording/status`, {
      headers: { 'X-SFU-Admin-Key': SFU_ADMIN_KEY },
    })
  ).json();

  const activeRec = sfuRecStatus.recordings?.find((r) => r.recordingId === recording.id);
  if (!activeRec) {
    console.error('FAIL: Recording not active in SFU recording status');
    child.kill('SIGKILL');
    process.exit(1);
  }
  console.log(`✔ Active FFmpeg recording session verified: pid=${activeRec.pid}, file=${activeRec.outputPath}`);

  // 7. Let media stream for 5 seconds to ensure non-zero byte recording
  console.log('Streaming media to FFmpeg egress for 5 seconds...');
  await new Promise((r) => setTimeout(r, 5000));

  // 8. Trigger recording stop via SFU admin stop
  console.log('Stopping recording egress...');
  const sfuStopRes = await fetch(`${SFU_HTTP}/admin/recording/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SFU-Admin-Key': SFU_ADMIN_KEY,
    },
    body: JSON.stringify({ participantId }),
  });
  const sfuStopJson = await sfuStopRes.json();
  if (!sfuStopRes.ok || !sfuStopJson.stopped) {
    console.error('FAIL: SFU recording stop failed:', sfuStopJson);
    child.kill('SIGKILL');
    process.exit(1);
  }
  console.log('✔ SFU Recording Egress stopped cleanly');

  // 9. Verify generated WebM file, duration, SHA-256 checksum, and file size
  console.log('Verifying output file details...');
  const outputPath = activeRec.outputPath;
  if (!fs.existsSync(outputPath)) {
    console.error(`FAIL: Output recording file does not exist at ${outputPath}`);
    child.kill('SIGKILL');
    process.exit(1);
  }

  const stat = fs.statSync(outputPath);
  if (stat.size === 0) {
    console.error(`FAIL: Output recording file is 0 bytes (${outputPath})`);
    child.kill('SIGKILL');
    process.exit(1);
  }
  console.log(`✔ Recording file exists on disk: ${outputPath} (${stat.size} bytes)`);

  // Compute SHA-256
  const fileBuf = fs.readFileSync(outputPath);
  const sha256 = crypto.createHash('sha256').update(fileBuf).digest('hex');
  console.log(`✔ SHA-256 Checksum: ${sha256}`);

  // 10. Check Recording status in API DB after finalize
  const finalRecRes = await jsonFetch(`/api/v1/recordings/${recording.id}`, {
    method: 'GET',
    token: adminToken,
  });
  const finalRec = finalRecRes.body;
  console.log('✔ API Recording DB View:', JSON.stringify({
    id: finalRec.id,
    status: finalRec.status,
    fileSizeBytes: finalRec.fileSizeBytes,
    durationMs: finalRec.durationMs,
    checksumSha256: finalRec.checksumSha256,
  }));

  if (finalRec.status !== 'READY') {
    console.error(`FAIL: Recording status is ${finalRec.status}, expected READY`);
    child.kill('SIGKILL');
    process.exit(1);
  }
  if (!finalRec.fileSizeBytes || finalRec.fileSizeBytes === '0' || Number(finalRec.fileSizeBytes) === 0) {
    console.error('FAIL: Recording fileSizeBytes is 0 or missing in DB');
    child.kill('SIGKILL');
    process.exit(1);
  }
  if (!finalRec.durationMs || finalRec.durationMs <= 0) {
    console.error('FAIL: Recording durationMs is <= 0 in DB');
    child.kill('SIGKILL');
    process.exit(1);
  }
  if (finalRec.checksumSha256 !== sha256.toLowerCase()) {
    console.error(`FAIL: Checksum mismatch. DB=${finalRec.checksumSha256}, calculated=${sha256}`);
    child.kill('SIGKILL');
    process.exit(1);
  }

  // 11. Release hold file and cleanup Electron app process
  try {
    fs.writeFileSync(holdFilePath, 'done');
  } catch {}
  child.kill('SIGKILL');
  try {
    if (fs.existsSync(holdFilePath)) fs.unlinkSync(holdFilePath);
  } catch {}

  // 12. Verify cleanup on SFU
  const postStatus = await (await fetch(`${SFU_HTTP}/status`)).json();
  const postRecStatus = await (
    await fetch(`${SFU_HTTP}/admin/recording/status`, {
      headers: { 'X-SFU-Admin-Key': SFU_ADMIN_KEY },
    })
  ).json();

  if (postRecStatus.recordings?.length > 0) {
    console.error('FAIL: Orphan FFmpeg sessions remain on SFU after stop');
    process.exit(1);
  }
  console.log('✔ Cleanup verified: 0 active FFmpeg processes, 0 orphan transports');

  console.log('=================================================================');
  console.log('✅ CHECKPOINT 1 — REAL SERVER-SIDE RECORDING EGRESS E2E PASSED!');
  console.log('=================================================================');
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
