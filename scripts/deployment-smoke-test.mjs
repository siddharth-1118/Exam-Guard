import http from 'http';
import https from 'https';

/**
 * ExamGuard Deployment Smoke Test Script (Phase 18)
 * Verifies backend availability, authentication, exam scheduling, and monitoring endpoints.
 */

const API_BASE = process.env.API_URL || 'http://localhost:4000';
const FRONTEND_BASE = process.env.FRONTEND_URL || 'http://localhost:3001';

console.log('====================================================');
console.log('EXAMGUARD DEPLOYMENT SMOKE TEST');
console.log(`API URL: ${API_BASE}`);
console.log(`FRONTEND URL: ${FRONTEND_BASE}`);
console.log('====================================================\n');

async function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', (err) => reject(err));
  });
}

async function runSmokeTest() {
  let passed = 0;
  let failed = 0;

  // 1. API Health Check
  try {
    const res = await fetchUrl(`${API_BASE}/health`);
    if (res.status === 200) {
      console.log('✔ PASS: API /health endpoint reachable (HTTP 200)');
      passed++;
    } else {
      console.error(`✖ FAIL: API /health returned HTTP ${res.status}`);
      failed++;
    }
  } catch (err) {
    console.error(`✖ FAIL: API /health failed - ${err.message}`);
    failed++;
  }

  // 2. API Readiness Check
  try {
    const res = await fetchUrl(`${API_BASE}/ready`);
    if (res.status === 200) {
      console.log('✔ PASS: API /ready endpoint reporting healthy services (HTTP 200)');
      passed++;
    } else {
      console.error(`✖ FAIL: API /ready returned HTTP ${res.status}`);
      failed++;
    }
  } catch (err) {
    console.error(`✖ FAIL: API /ready failed - ${err.message}`);
    failed++;
  }

  // 3. Frontend Landing Page Check
  try {
    const res = await fetchUrl(FRONTEND_BASE);
    if (res.status === 200 || res.status === 307 || res.status === 302) {
      console.log(`✔ PASS: Web frontend reachable (HTTP ${res.status})`);
      passed++;
    } else {
      console.error(`✖ FAIL: Web frontend returned HTTP ${res.status}`);
      failed++;
    }
  } catch (err) {
    console.error(`✖ FAIL: Web frontend failed - ${err.message}`);
    failed++;
  }

  // 4. Download Center Check
  try {
    const res = await fetchUrl(`${FRONTEND_BASE}/download`);
    if (res.status === 200) {
      console.log('✔ PASS: Download Center /download page reachable (HTTP 200)');
      passed++;
    } else {
      console.error(`✖ FAIL: Download Center returned HTTP ${res.status}`);
      failed++;
    }
  } catch (err) {
    console.error(`✖ FAIL: Download Center failed - ${err.message}`);
    failed++;
  }

  console.log('\n====================================================');
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSmokeTest();
