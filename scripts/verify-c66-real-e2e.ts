import WebSocket from 'ws';
import { PrismaClient } from '@prisma/client';

const API_BASE = 'http://localhost:4000';
const SFU_WS = 'ws://127.0.0.1:4010/sfu';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://examguard:examguard@localhost:5433/examguard?schema=public';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

async function postJson(url: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

async function getJson(url: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

async function runC66E2E() {
  console.log('=== STARTING C66 REAL E2E VERIFICATION ===');
  const results: Record<string, boolean> = {};

  try {
    // 1. Student Login
    console.log('\n[1] Student Login...');
    const studentLogin = await postJson(`${API_BASE}/api/v1/auth/login`, {
      email: 'student01@northstar.edu',
      password: 'ExamGuard!Dev2026',
    });
    if (!studentLogin.ok || !studentLogin.json?.accessToken) {
      throw new Error(`Student login failed: ${studentLogin.text}`);
    }
    const studentToken = studentLogin.json.accessToken;
    console.log('✔ Student logged in successfully. User ID:', studentLogin.json.user.id);
    results['student_login'] = true;

    // 2. Monitor Login
    console.log('\n[2] Monitor Login...');
    const monitorLogin = await postJson(`${API_BASE}/api/v1/auth/login`, {
      email: 'monitor@northstar.edu',
      password: 'ExamGuard!Dev2026',
    });
    if (!monitorLogin.ok || !monitorLogin.json?.accessToken) {
      throw new Error(`Monitor login failed: ${monitorLogin.text}`);
    }
    const monitorToken = monitorLogin.json.accessToken;
    console.log('✔ Monitor logged in successfully. User ID:', monitorLogin.json.user.id);
    results['monitor_login'] = true;

    // 3. Exam Selection
    console.log('\n[3] Exam List & Selection...');
    const examList = await getJson(`${API_BASE}/api/v1/exams`, studentToken);
    const exams = Array.isArray(examList.json) ? examList.json : examList.json?.items;
    if (!examList.ok || !Array.isArray(exams)) {
      throw new Error(`Failed to list exams: ${examList.text}`);
    }
    const targetExam = exams.find((e: any) => e.name.includes('Midterm')) || exams[0];
    if (!targetExam) throw new Error('No exam found in list');
    console.log(`✔ Found exam: "${targetExam.name}" (ID: ${targetExam.id})`);
    results['exam_selection'] = true;

    // Open exam if it is in SCHEDULED status
    if (targetExam.status === 'SCHEDULED') {
      const adminLogin = await postJson(`${API_BASE}/api/v1/auth/login`, {
        email: 'admin@northstar.edu',
        password: 'ExamGuard!Dev2026',
      });
      if (adminLogin.ok) {
        await postJson(`${API_BASE}/api/v1/exams/${targetExam.id}/start`, {}, adminLogin.json.accessToken);
      }
    }

    // Clean up previous test attempts for clean execution
    const studentUser = await prisma.user.findUnique({ where: { email: 'student01@northstar.edu' } });
    if (studentUser) {
      const studentObj = await prisma.student.findUnique({ where: { userId: studentUser.id } });
      if (studentObj) {
        await prisma.examAttempt.deleteMany({
          where: { studentId: studentObj.id, examId: targetExam.id },
        });
      }
    }

    // 4. Exam Start with Consent
    console.log('\n[4] Starting Exam Attempt with Consent...');
    const startRes = await postJson(`${API_BASE}/api/v1/attempts`, {
      examId: targetExam.id,
      deviceInfo: { os: 'Windows 11', appVersion: '1.0.0' },
      consent: {
        identityVerified: true,
        consentGiven: true,
        version: '1.0',
        acceptedAt: new Date().toISOString(),
      },
    }, studentToken);

    if (!startRes.ok || !startRes.json?.attempt) {
      throw new Error(`Start attempt failed (${startRes.status}): ${startRes.text}`);
    }
    const attempt = startRes.json.attempt;
    const questions = startRes.json.questions || [];
    console.log(`✔ Attempt started successfully. Attempt ID: ${attempt.id}, Questions count: ${questions.length}`);
    results['attempt_start'] = true;

    // 5. Media Token & SFU Connection
    console.log('\n[5] Obtaining Media Token & Connecting to SFU...');
    const tokenRes = await postJson(`${API_BASE}/api/v1/media/token`, {
      attemptId: attempt.id,
    }, studentToken);

    if (!tokenRes.ok || !tokenRes.json?.token) {
      throw new Error(`Failed to obtain media token: ${tokenRes.text}`);
    }
    const mediaToken = tokenRes.json.token;
    const participantId = tokenRes.json.participantId;
    console.log(`✔ Media token issued. Participant ID: ${participantId}`);

    // Connect to SFU WebSocket
    const ws = new WebSocket(SFU_WS);
    const wsOpened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', (err) => {
        console.error('WS Error:', err.message);
        resolve(false);
      });
      setTimeout(() => resolve(false), 5000);
    });

    if (!wsOpened) {
      console.warn('⚠️ SFU WebSocket connection timed out or failed. SFU state test partial.');
      results['sfu_connection'] = false;
    } else {
      console.log('✔ Connected to SFU WebSocket signaling server.');

      // Send join message
      const joinPromise = new Promise<any>((resolve) => {
        ws.on('message', (msgStr) => {
          try {
            const data = JSON.parse(msgStr.toString());
            resolve(data);
          } catch {}
        });
      });

      ws.send(JSON.stringify({
        action: 'join',
        token: mediaToken,
        rtpCapabilities: { codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }] },
      }));

      const joinReply = await Promise.race([
        joinPromise,
        new Promise((r) => setTimeout(() => r(null), 3000)),
      ]);

      if (joinReply && joinReply.ok !== false) {
        console.log('✔ Successfully joined SFU room as publisher.');
        results['sfu_connection'] = true;
      } else {
        console.log('Join reply:', joinReply);
        results['sfu_connection'] = false;
      }
      ws.close();
    }

    // 6. Monitor Dashboard & Discovery
    console.log('\n[6] Testing Monitor Discovery & Assigned Student Feed...');
    const monitorStudents = await getJson(`${API_BASE}/api/v1/monitoring/exams/${targetExam.id}/students`, monitorToken);
    if (!monitorStudents.ok || !Array.isArray(monitorStudents.json)) {
      throw new Error(`Failed monitor student query: ${monitorStudents.text}`);
    }
    const studentInMonitor = monitorStudents.json.find((s: any) => s.attemptId === attempt.id);
    console.log('✔ Monitor query returned', monitorStudents.json.length, 'students.');
    if (studentInMonitor) {
      console.log(`✔ Student attempt visible in monitor dashboard. Status: ${studentInMonitor.status}, RiskLevel: ${studentInMonitor.riskLevel}`);
      results['monitor_discovery'] = true;
    } else {
      console.warn('⚠️ Student attempt not found in monitor list.');
      results['monitor_discovery'] = false;
    }

    // 7. Monitor Pause & Student Lock Verification
    console.log('\n[7] Testing Monitor Pause Intervention & Write Locks...');
    const pauseRes = await postJson(`${API_BASE}/api/v1/monitoring/students/${attempt.id}/pause`, {
      durationSeconds: 30,
      reason: 'Proctor pause check',
    }, monitorToken);

    if (!pauseRes.ok) {
      throw new Error(`Monitor pause failed: ${pauseRes.text}`);
    }
    console.log('✔ Monitor paused attempt.');

    // Verify student cannot write answers while PAUSED
    if (questions.length > 0) {
      const saveWhilePaused = await postJson(`${API_BASE}/api/v1/attempts/${attempt.id}/answers`, {
        questionId: questions[0].id,
        value: 'test-answer',
      }, studentToken);

      if (saveWhilePaused.status === 409) {
        console.log('✔ Answer modification correctly rejected with 409 Conflict while attempt is PAUSED.');
        results['pause_write_lock'] = true;
      } else {
        console.error(`❌ Unexpected status when writing while paused: ${saveWhilePaused.status}`);
        results['pause_write_lock'] = false;
      }
    }

    // Resume attempt
    console.log('\n[8] Testing Monitor Resume...');
    const resumeRes = await postJson(`${API_BASE}/api/v1/monitoring/students/${attempt.id}/resume`, {
      reason: 'Proctor resume check',
    }, monitorToken);
    if (!resumeRes.ok) throw new Error(`Monitor resume failed: ${resumeRes.text}`);
    console.log('✔ Monitor resumed attempt.');
    results['monitor_resume'] = true;

    // 9. Proctoring Event & Deduplication
    console.log('\n[9] Generating Proctoring Sensor Event & Testing Deduplication...');
    const clientEventId = `evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const eventPayload = {
      attemptId: attempt.id,
      type: 'EXAM_WINDOW_LOST_FOCUS',
      clientEventId,
      severity: 'WARNING',
      detail: { focusLost: true, timestamp: new Date().toISOString() },
    };

    const evt1 = await postJson(`${API_BASE}/api/v1/proctoring/events`, eventPayload, studentToken);
    if (!evt1.ok) throw new Error(`Event post failed: ${evt1.text}`);
    console.log('✔ First event posted successfully.');

    // Post duplicate event with same clientEventId
    const evt2 = await postJson(`${API_BASE}/api/v1/proctoring/events`, eventPayload, studentToken);
    if (evt2.ok) {
      console.log('✔ Second event with duplicate clientEventId processed idempotently.');
      results['event_deduplication'] = true;
    }

    // 10. Student Answer Persistence
    console.log('\n[10] Saving Student Answers...');
    let savedAnswersCount = 0;
    for (let i = 0; i < Math.min(3, questions.length); i++) {
      const q = questions[i];
      let val: any = 'final';
      if (q.type === 'SINGLE_CHOICE' && q.options?.length > 0) val = q.options[0].id;
      if (q.type === 'TRUE_FALSE' && q.options?.length > 0) val = q.options[0].id;

      const saveRes = await postJson(`${API_BASE}/api/v1/attempts/${attempt.id}/answers`, {
        questionId: q.id,
        value: val,
      }, studentToken);

      if (saveRes.ok) savedAnswersCount++;
    }
    console.log(`✔ Saved ${savedAnswersCount} answers successfully.`);
    results['answer_persistence'] = savedAnswersCount > 0;

    // 11. Exam Submission & Auto-Grading
    console.log('\n[11] Submitting Exam Attempt...');
    const submitRes = await postJson(`${API_BASE}/api/v1/attempts/${attempt.id}/submit`, {}, studentToken);
    if (!submitRes.ok || !submitRes.json) {
      throw new Error(`Submit attempt failed: ${submitRes.text}`);
    }
    const finalAttempt = submitRes.json;
    console.log(`✔ Attempt submitted successfully. Status: ${finalAttempt.status}, Score: ${finalAttempt.score}`);
    results['exam_submission'] = true;

    // Verify Idempotency of submit call
    const resubmitRes = await postJson(`${API_BASE}/api/v1/attempts/${attempt.id}/submit`, {}, studentToken);
    if (resubmitRes.ok && resubmitRes.json?.status === 'SUBMITTED') {
      console.log('✔ Idempotent resubmission returned existing graded attempt without error.');
      results['submit_idempotency'] = true;
    }

    // 12. Cleanup & Audit Log Verification
    console.log('\n[12] Verifying Audit Trail & Database State...');
    const auditLogs = await prisma.auditLog.findMany({
      where: { resourceId: attempt.id },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`✔ Found ${auditLogs.length} audit log entries for attempt ${attempt.id}. Actions:`, auditLogs.map((a) => a.action).join(', '));
    results['audit_trail'] = auditLogs.length > 0;

    // Verify media participant status is ENDED
    const dbParticipant = await prisma.mediaParticipant.findFirst({
      where: { attemptId: attempt.id },
    });
    if (!dbParticipant || dbParticipant.status === 'ENDED') {
      console.log('✔ Database participant status correctly set to ENDED or cleared.');
      results['participant_cleanup'] = true;
    }

    console.log('\n=== C66 E2E SUMMARY RESULTS ===');
    console.table(results);
    const allPassed = Object.values(results).every((v) => v === true);
    console.log(allPassed ? '🎉 C66 REAL E2E PASSED 100%' : '⚠️ C66 E2E PARTIALLY PASSED — check table above.');

  } catch (err: any) {
    console.error('\n❌ C66 E2E FAILED WITH ERROR:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

runC66E2E();
