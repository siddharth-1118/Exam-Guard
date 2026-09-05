#!/usr/bin/env node
/**
 * ExamGuard Authenticated Capacity Load Test (C20)
 *
 * Measures throughput, latency percentiles (p50/p95/p99), and classifies
 * every response by HTTP status category. SYNTHETIC — no real media.
 *
 * Usage:
 *   node scripts/load-test.mjs --concurrency=50 --duration=30s
 *   node scripts/load-test.mjs --concurrency=10 --duration=10s --dry-run
 *   node scripts/load-test.mjs --staged           # runs 10,25,50,100 sequentially
 *
 * Options:
 *   --concurrency=N   Concurrent workers (default: 20)
 *   --duration=Ns     Test duration (default: 30s)
 *   --url=URL         API base URL (default: http://localhost:4000)
 *   --dry-run         Print plan without executing
 *   --staged          Run 10, 25, 50, 100 concurrency levels sequentially
 *   --help            Show this help
 *
 * Output: JSON report to stdout. SYNTHETIC label included.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=') || true];
    }),
);

if (args.help) {
  console.log(`Usage: node scripts/load-test.mjs [options]
  --concurrency=N   Concurrent workers (default: 20)
  --duration=Ns     Duration (default: 30s)
  --url=URL         API base URL (default: http://localhost:4000)
  --dry-run         Print plan, don't execute
  --staged          Run 10, 25, 50, 100 levels sequentially`);
  process.exit(0);
}

const CONCURRENCY = Math.max(1, parseInt(args.concurrency ?? '20', 10) || 20);
const DURATION_SEC = Math.max(1, parseInt(String(args.duration ?? '30').replace(/s$/i, ''), 10) || 30);
const BASE_URL = String(args.url ?? 'http://localhost:4000').replace(/\/$/, '');
const DRY_RUN = args['dry-run'] === true;
const STAGED = args.staged === true;
const STAGED_LEVELS = [10, 25, 50, 100];

// Credentials from the dev seed (DEV ONLY — never in production)
const LOGIN_EMAIL = 'admin@northstar.edu';
const LOGIN_PASSWORD = 'ExamGuard!Dev2026';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseDurationMs(val) {
  const s = String(val).replace(/s$/i, '');
  return Math.max(1000, parseInt(s, 10) * 1000 || 30_000);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function timedFetch(url, opts = {}) {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timeout);
    const body = await res.text().catch(() => '');
    return { status: res.status, ms: performance.now() - start, body };
  } catch (err) {
    return { status: 0, ms: performance.now() - start, error: String(err.message ?? err) };
  }
}

/** Classify a response into a category for the report. */
function classify(status, error) {
  if (error) return 'network';
  if (status === 200 || status === 201) return 'ok';
  if (status === 204) return 'ok';
  if (status === 301 || status === 302 || status === 304) return 'redirect';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500) return 'server_error';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function authenticate() {
  const res = await timedFetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  if (res.status !== 200) {
    throw new Error(`Auth failed (${res.status}): ${res.body?.slice(0, 200)}`);
  }
  const data = JSON.parse(res.body);
  return data.accessToken ?? data.access_token ?? data.token;
}

// ---------------------------------------------------------------------------
// Workloads — read-heavy, no side effects, no duplicates
// ---------------------------------------------------------------------------
async function workloadHealth() {
  return timedFetch(`${BASE_URL}/health`);
}

async function workloadReady() {
  return timedFetch(`${BASE_URL}/ready`);
}

async function workloadListExams(token) {
  return timedFetch(`${BASE_URL}/api/v1/exams`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function workloadListRecordings(token) {
  return timedFetch(`${BASE_URL}/api/v1/recordings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function workloadAuditLog(token) {
  return timedFetch(`${BASE_URL}/api/v1/audit?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Each worker picks workloads weighted toward reads. */
const WORKLOADS = [
  { name: 'health', weight: 2, fn: () => workloadHealth() },
  { name: 'ready', weight: 1, fn: () => workloadReady() },
  { name: 'list-exams', weight: 3, fn: (t) => workloadListExams(t) },
  { name: 'list-recordings', weight: 3, fn: (t) => workloadListRecordings(t) },
  { name: 'audit-log', weight: 1, fn: (t) => workloadAuditLog(t) },
];

function pickWorkload() {
  const total = WORKLOADS.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const w of WORKLOADS) { r -= w.weight; if (r <= 0) return w; }
  return WORKLOADS[WORKLOADS.length - 1];
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
async function worker(id, token, deadline, results) {
  while (Date.now() < deadline) {
    const wl = pickWorkload();
    const res = await wl.fn(token);
    const cat = classify(res.status, res.error);
    results.push({ name: wl.name, category: cat, status: res.status, ms: res.ms, worker: id });
  }
}

// ---------------------------------------------------------------------------
// Run a single concurrency level
// ---------------------------------------------------------------------------
async function runLevel(concurrency, durationMs) {
  let token;
  try {
    token = await authenticate();
  } catch (err) {
    return { error: `Auth failed: ${err.message}` };
  }

  const results = [];
  const deadline = Date.now() + durationMs;
  const wallStart = performance.now();
  const workers = Array.from({ length: concurrency }, (_, i) => worker(i, token, deadline, results));
  await Promise.all(workers);
  const wallMs = performance.now() - wallStart;

  // Compute stats
  const latencies = results.map(r => r.ms).sort((a, b) => a - b);

  // Category counts
  const categories = {};
  for (const r of results) {
    categories[r.category] = (categories[r.category] || 0) + 1;
  }

  // Per-workload stats
  const byName = {};
  for (const r of results) {
    if (!byName[r.name]) byName[r.name] = { count: 0, categories: {}, latencies: [] };
    byName[r.name].count++;
    byName[r.name].categories[r.category] = (byName[r.name].categories[r.category] || 0) + 1;
    byName[r.name].latencies.push(r.ms);
  }
  for (const stats of Object.values(byName)) {
    stats.latencies.sort((a, b) => a - b);
    stats.p50 = Math.round(percentile(stats.latencies, 50));
    stats.p95 = Math.round(percentile(stats.latencies, 95));
    stats.p99 = Math.round(percentile(stats.latencies, 99));
    delete stats.latencies;
  }

  return {
    concurrency,
    durationMs,
    durationSec: Math.round(wallMs / 1000),
    totalRequests: results.length,
    throughputRps: +(results.length / (wallMs / 1000)).toFixed(1),
    categories,
    latencyMs: {
      min: latencies.length > 0 ? Math.round(latencies[0]) : 0,
      p50: Math.round(percentile(latencies, 50)),
      p95: Math.round(percentile(latencies, 95)),
      p99: Math.round(percentile(latencies, 99)),
      max: latencies.length > 0 ? Math.round(latencies[latencies.length - 1]) : 0,
      mean: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    },
    byWorkload: byName,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const durationMs = parseDurationMs(DURATION_SEC);

  if (DRY_RUN) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      synthetic: true,
      label: 'SYNTHETIC — No real media connections. API/control-plane only.',
      physicalMediaLoadTesting: 'BLOCKED — requires multi-machine environment with webcams.',
      config: STAGED
        ? { levels: STAGED_LEVELS, durationSec: DURATION_SEC, url: BASE_URL }
        : { concurrency: CONCURRENCY, durationSec: DURATION_SEC, url: BASE_URL },
      workloads: WORKLOADS.map(w => ({ name: w.name, weight: w.weight })),
    }, null, 2));
    process.exit(0);
  }

  const levels = STAGED ? STAGED_LEVELS : [CONCURRENCY];
  const allResults = [];

  for (const level of levels) {
    process.stderr.write(`Running ${level} concurrent clients for ${DURATION_SEC}s...\n`);
    const result = await runLevel(level, durationMs);
    allResults.push(result);
    // Brief cooldown between levels to let rate limiter reset
    if (levels.indexOf(level) < levels.length - 1) {
      process.stderr.write(`  Cooling down 5s...\n`);
      await sleep(5_000);
    }
  }

  const report = {
    synthetic: true,
    label: 'SYNTHETIC — No real media connections. API/control-plane only.',
    physicalMediaLoadTesting: 'BLOCKED — requires multi-machine environment with ≥10 webcams.',
    apiRateLimit: '120 requests/minute per IP (ThrottlerModule)',
    methodology: 'Each worker authenticates once, then loops through weighted read workloads. Responses classified by HTTP status category.',
    results: allResults,
    timestamp: new Date().toISOString(),
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err.message ?? err) }));
  process.exit(1);
});
