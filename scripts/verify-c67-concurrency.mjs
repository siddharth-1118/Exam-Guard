var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/verify-c67-concurrency.ts
var import_client = require("@prisma/client");
var import_perf_hooks = __toESM(require("perf_hooks"));
var import_auth = require("@examguard/auth");
var API_BASE = "http://localhost:4000";
var DATABASE_URL = process.env.DATABASE_URL || "postgresql://examguard:examguard@localhost:5433/examguard?schema=public";
var prisma = new import_client.PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
async function postJson(url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const start = import_perf_hooks.default.performance.now();
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const end = import_perf_hooks.default.performance.now();
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
    }
    return { status: res.status, ok: res.ok, json, durationMs: end - start };
  } catch (err) {
    const end = import_perf_hooks.default.performance.now();
    return { status: 0, ok: false, json: null, error: err.message, durationMs: end - start };
  }
}
async function getJson(url, token) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const start = import_perf_hooks.default.performance.now();
  try {
    const res = await fetch(url, { method: "GET", headers });
    const end = import_perf_hooks.default.performance.now();
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
    }
    return { status: res.status, ok: res.ok, json, durationMs: end - start };
  } catch (err) {
    const end = import_perf_hooks.default.performance.now();
    return { status: 0, ok: false, json: null, error: err.message, durationMs: end - start };
  }
}
async function testConcurrencyLevel(count, examId, orgId) {
  console.log(`
--- Testing Concurrency Level: N = ${count} Concurrent Students ---`);
  const latencies = [];
  let successfulStudents = 0;
  let failedStudents = 0;
  const attempts = [];
  const studentTokens = [];
  const jwtSecret = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
  const role = await prisma.role.findUnique({ where: { name: "STUDENT" } });
  for (let i = 0; i < count; i++) {
    const email = `conc_student_${i}@northstar.edu`;
    const code = `NS-CONC-${String(i).padStart(3, "0")}`;
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          firstName: "ConcStudent",
          lastName: `${i}`,
          passwordHash: "$2b$10$wT.48006w/y.e/w.e/w.e/w.e/w.e/w.e/w.e/w.e/w.e/w.e/w",
          isActive: true
        }
      });
    }
    if (role) {
      await prisma.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: orgId, userId: user.id } },
        update: { roleId: role.id, isActive: true },
        create: { organizationId: orgId, userId: user.id, roleId: role.id }
      });
    }
    const student = await prisma.student.upsert({
      where: { userId: user.id },
      update: { organizationId: orgId, studentCode: code },
      create: { userId: user.id, organizationId: orgId, studentCode: code }
    });
    await prisma.examAssignment.upsert({
      where: { examId_studentId: { examId, studentId: student.id } },
      update: {},
      create: { examId, studentId: student.id }
    });
    await prisma.examAttempt.deleteMany({ where: { studentId: student.id, examId } });
    const token = await (0, import_auth.signAccessToken)(
      { sub: user.id, email, orgId, role: "STUDENT" },
      jwtSecret,
      3600
    );
    studentTokens.push({ token, email, userId: user.id });
  }
  const startPromises = studentTokens.map(async (item) => {
    const res = await postJson(`${API_BASE}/api/v1/attempts`, {
      examId,
      consent: { identityVerified: true, consentGiven: true }
    }, item.token);
    latencies.push(res.durationMs);
    if (res.ok && res.json?.attempt) {
      successfulStudents++;
      attempts.push(res.json.attempt.id);
      const mediaTokenRes = await postJson(`${API_BASE}/api/v1/media/token`, {
        attemptId: res.json.attempt.id
      }, item.token);
      latencies.push(mediaTokenRes.durationMs);
    } else {
      console.log(`\u274C Attempt start failed for ${item.email}: status=${res.status}`, res.json || res.error);
      failedStudents++;
    }
  });
  await Promise.all(startPromises);
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const memoryUsageMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const sfuStatus = await getJson("http://127.0.0.1:4010/status");
  console.log(`Results for N = ${count}:`);
  console.log(`  Successful Students: ${successfulStudents}/${count}`);
  console.log(`  Failed Students:     ${failedStudents}`);
  console.log(`  API Latency p50:      ${p50.toFixed(1)} ms`);
  console.log(`  API Latency p95:      ${p95.toFixed(1)} ms`);
  console.log(`  API Latency p99:      ${p99.toFixed(1)} ms`);
  console.log(`  Node Process Memory:  ${memoryUsageMB} MB`);
  console.log(`  SFU Active Rooms:     ${sfuStatus.json?.metrics?.rooms ?? 0}`);
  for (const attemptId of attempts) {
    try {
      await prisma.examAttempt.delete({ where: { id: attemptId } });
    } catch {
    }
  }
  return {
    count,
    successfulStudents,
    failedStudents,
    p50,
    p95,
    p99,
    memoryUsageMB,
    sfuRooms: sfuStatus.json?.metrics?.rooms ?? 0
  };
}
async function runC67Concurrency() {
  console.log("=== STARTING C67 MULTI-STUDENT CONCURRENCY BENCHMARK ===");
  try {
    const exam = await prisma.exam.findFirst({ where: { name: { contains: "Midterm" } } });
    if (!exam) throw new Error("Seeded exam not found");
    const levels = [2, 5, 10, 25, 50, 100];
    const summary = [];
    for (const N of levels) {
      const res = await testConcurrencyLevel(N, exam.id, exam.organizationId);
      summary.push(res);
      if (res.failedStudents > N * 0.5) {
        console.log(`\u26A0\uFE0F Concurrency bottleneck encountered at N = ${N}. Stopping scale.`);
        break;
      }
    }
    console.log("\n=== FINAL CONCURRENCY BENCHMARK SUMMARY ===");
    console.table(summary);
  } catch (err) {
    console.error("\u274C C67 BENCHMARK FAILED:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}
runC67Concurrency();
