/**
 * Production Smoke Test (C71.5)
 * Verifies API health, readiness, media status, and auth endpoint availability.
 * Reads endpoints from environment variables: API_URL (default http://localhost:4000) and MEDIA_URL (default http://localhost:4010).
 * Never prints secrets, passwords, or tokens in test output.
 */

const API_URL = (process.env.API_URL || 'http://localhost:4000').replace(/\/+$/, '');
const MEDIA_URL = (process.env.MEDIA_URL || 'http://localhost:4010').replace(/\/+$/, '');

async function checkUrl(name, url, expectedStatus = 200) {
  console.log(`[Smoke Test] Checking ${name}: ${url}...`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.status !== expectedStatus) {
      throw new Error(`Expected HTTP ${expectedStatus}, received HTTP ${res.status}`);
    }
    const data = await res.json().catch(() => ({}));
    console.log(`  └─ [OK] HTTP ${res.status}`, JSON.stringify(data));
    return true;
  } catch (err) {
    console.error(`  └─ [FAIL] ${name} check failed: ${err.message}`);
    return false;
  }
}

async function checkAuthEndpoint() {
  console.log(`[Smoke Test] Checking Auth Endpoint: ${API_URL}/api/v1/auth/login...`);
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'smoke-test-probe@examguard.invalid', password: 'InvalidProbePassword123!' }),
      signal: AbortSignal.timeout(10000),
    });
    // Expected 401 Unauthorized for invalid credentials proves the endpoint & DB lookup are responding
    if (res.status === 401 || res.status === 400 || res.status === 429) {
      console.log(`  └─ [OK] Auth endpoint responded cleanly with HTTP ${res.status}`);
      return true;
    }
    throw new Error(`Unexpected status HTTP ${res.status}`);
  } catch (err) {
    console.error(`  └─ [FAIL] Auth endpoint check failed: ${err.message}`);
    return false;
  }
}

async function runSmokeTest() {
  console.log('=== ExamGuard Production Smoke Test ===');
  console.log(`Target API: ${API_URL}`);
  console.log(`Target Media: ${MEDIA_URL}\n`);

  const results = [];
  results.push(await checkUrl('API Liveness', `${API_URL}/health`));
  results.push(await checkUrl('API Readiness', `${API_URL}/ready`));
  results.push(await checkUrl('Media Status', `${MEDIA_URL}/status`));
  results.push(await checkAuthEndpoint());

  const passed = results.every(Boolean);
  console.log('\n=======================================');
  if (passed) {
    console.log('SMOKE TEST RESULT: PASS (All checks passed)');
    process.exit(0);
  } else {
    console.error('SMOKE TEST RESULT: FAIL (One or more checks failed)');
    process.exit(1);
  }
}

runSmokeTest();
