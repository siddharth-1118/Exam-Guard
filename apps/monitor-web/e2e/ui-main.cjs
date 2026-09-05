/**
 * Phase 4C.2 E2E harness — drives the REAL Monitor Web application (Next.js,
 * served by `next start`) inside Electron/Chromium through its actual DOM:
 * login form → assigned exams → monitoring board → student detail live-media
 * panel → audio enable → student switching → terminate action.
 *
 * The orchestrating script (scripts/monitor-live-view-e2e.mjs) samples the SFU
 * between the markers this process prints. Only the real UI is driven — no
 * direct API/SFU calls happen here for the positive media path.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

// Per-run isolation: the E2E must never share cookies/cache with previous
// runs (a leftover session redirects past login into a stale board, and can
// masquerade as "the page navigated on its own").
if (process.env.EXAMGUARD_E2E_USER_DATA) {
  app.setPath('userData', process.env.EXAMGUARD_E2E_USER_DATA);
}

// Autoplay policy: the focused student's audio element must be able to start
// without a physical user gesture (the E2E drives the UI programmatically).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const UI_BASE = process.env.E2E_UI_URL || 'http://127.0.0.1:3210';
const EMAIL = process.env.E2E_MONITOR_EMAIL || '';
const PASSWORD = process.env.E2E_MONITOR_PASSWORD || '';
const EXAM_NAME = process.env.E2E_EXAM_NAME || '';
const STUDENT_A = process.env.E2E_STUDENT_A_CODE || '';
const STUDENT_B = process.env.E2E_STUDENT_B_CODE || '';

if (!EMAIL || !PASSWORD || !EXAM_NAME || !STUDENT_A || !STUDENT_B) {
  console.error('UI_FAIL missing env (E2E_MONITOR_EMAIL/_PASSWORD/E2E_EXAM_NAME/E2E_STUDENT_A_CODE/E2E_STUDENT_B_CODE)');
  app.exit(1);
}

function marker(line) {
  console.log(`[ui] ${line}`);
}

async function main() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  // Navigation ground truth (production Next logs no requests) — used to
  // diagnose any unexpected page movement during the E2E.
  win.webContents.on('did-start-navigation', (ev, url, isInPlace, isMainFrame) => {
    if (isMainFrame) marker(`NAV→ ${url} (inplace=${isInPlace})`);
  });
  win.webContents.on('did-navigate', (_e, url) => marker(`NAV-OK ${url}`));
  win.webContents.on('did-navigate-in-page', (_e, url) => marker(`NAV-INPAGE ${url}`));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => marker(`NAV-FAIL ${code} ${desc} ${url}`));
  win.webContents.on('render-process-gone', (_e, details) => marker(`RENDERER-GONE ${JSON.stringify(details)}`));

  const fail = (msg) => {
    marker(`UI_FAIL ${msg}`);
    console.error(`UI_FAIL ${msg}`);
    app.exit(1);
  };
  const js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code, true);
    } catch (err) {
      fail(`page script error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  win.webContents.on('console-message', (_e, _l, message) => {
    if (typeof message === 'string' && message.startsWith('EG_CLICK ')) marker(message);
  });
  const waitFor = async (what, code, timeoutMs = 30_000, intervalMs = 350) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await js(code);
      if (v) return v;
      if (Date.now() > deadline) {
        const dump = await js(`JSON.stringify({ href: location.href, body: (document.body.innerText || '').slice(0, 600) })`).catch(() => null);
        marker(`UI_STATE_AT_TIMEOUT ${what} ${dump}`);
        fail(`timed out waiting for ${what}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------------
  // 1. Real login form
  // -------------------------------------------------------------------------
  marker('UI_START');
  await win.loadURL(`${UI_BASE}/login`);
  await waitFor('login form', `Boolean(document.querySelector('input[type=email]')) && Boolean(document.querySelector('button[type=submit]'))`, 45_000);
  // Identify what the page itself clicks (diagnostic for stray navigation).
  await js(`(() => {
    if (window.__egClickCapture) return;
    window.__egClickCapture = true;
    document.addEventListener('click', (e) => {
      const t = e.target;
      const d = { tag: t?.tagName, text: (t?.textContent || '').slice(0, 40), href: t?.getAttribute?.('href') ?? null, cls: String(t?.className ?? '').slice(0, 40) };
      console.log('EG_CLICK ' + JSON.stringify(d));
    }, true);
  })()`);
  const loginSubmitted = await js(`(() => {
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    set('input[type=email]', ${JSON.stringify(EMAIL)});
    set('input[type=password]', ${JSON.stringify(PASSWORD)});
    const form = document.querySelector('form');
    if (!form) return 'no-form';
    if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return 'requestSubmit'; }
    const btn = document.querySelector('button[type=submit]');
    if (btn) { btn.click(); return 'click'; }
    return 'no-button';
  })()`);
  marker(`UI_LOGIN_SUBMIT ${JSON.stringify(loginSubmitted)}`);
  // Hydration race: submitting before React hydrates lets the native form
  // reload the page instead of running the SPA login. Detect the React
  // handler by waiting for its loading spinner (or an error paragraph) after
  // each submit, and re-submit until the authenticated redirect happens.
  let loggedIn = false;
  for (let attempt = 1; attempt <= 6 && !loggedIn; attempt += 1) {
    const r = await js(`(() => {
      // A pre-hydration submit reloads the page and wipes the form, so the
      // fields are re-filled before every submit attempt.
      const set = (sel, v) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      set('input[type=email]', ${JSON.stringify(EMAIL)});
      set('input[type=password]', ${JSON.stringify(PASSWORD)});
      const form = document.querySelector('form');
      if (!form) return 'no-form';
      form.requestSubmit();
      return 'submitted';
    })()`).catch(() => 'js-error');
    const deadline = Date.now() + 10_000;
    let phase = null;
    while (Date.now() < deadline) {
      const nav = await js(`location.pathname.startsWith('/monitor/exams')`);
      if (nav) { loggedIn = true; break; }
      const spinner = await js(`Boolean(document.querySelector('button[type=submit] .animate-spin'))`);
      const errText = await js(`(() => {
        const p = document.querySelector('p.text-red-400');
        return p ? (p.textContent || '').slice(0, 200) : null;
      })()`);
      if (errText) {
        marker(`UI_LOGIN_ERROR ${JSON.stringify(errText)}`);
        fail(`login error: ${errText}`);
        return;
      }
      if (spinner) phase = 'react-handler-active';
      await sleep(400);
    }
    marker(`UI_LOGIN_ATTEMPT ${attempt} ${JSON.stringify(r)} ${phase ?? 'no-react-handler'}`);
  }
  if (!loggedIn) fail('login did not redirect after repeated submits');
  marker('UI_LOGIN_OK');

  // -------------------------------------------------------------------------
  // 2. Assigned exams → monitoring board
  // -------------------------------------------------------------------------
  await waitFor(
    'exam card for the target exam',
    `(() => {
      const anchors = [...document.querySelectorAll('a')];
      return anchors.some((a) => {
        if (!a.textContent.includes('Open monitoring board')) return false;
        let n = a.parentElement;
        while (n && n !== document.body) {
          if ((n.innerText || '').includes(${JSON.stringify(EXAM_NAME)})) return true;
          n = n.parentElement;
        }
        return false;
      });
    })()`,
    30_000,
  );
  await js(`(() => {
    const anchors = [...document.querySelectorAll('a')];
    const a = anchors.find((x) => {
      if (!x.textContent.includes('Open monitoring board')) return false;
      let n = x.parentElement;
      while (n && n !== document.body) {
        if ((n.innerText || '').includes(${JSON.stringify(EXAM_NAME)})) return true;
        n = n.parentElement;
      }
      return false;
    });
    if (!a) return false;
    a.click();
    return true;
  })()`);
  await waitFor(
    `monitoring board with student ${STUDENT_A}`,
    `(() => {
      const anchors = [...document.querySelectorAll('a')];
      return anchors.some((a) => (a.textContent || '').includes(${JSON.stringify(STUDENT_A)}));
    })()`,
    30_000,
  );
  marker('UI_BOARD_OK');

  // -------------------------------------------------------------------------
  // 3. Student A: live media (camera + screen decode, mic muted → enabled)
  // -------------------------------------------------------------------------
  const openStudent = async (code) => {
    await js(`(() => {
      const a = [...document.querySelectorAll('a')].find((x) => (x.textContent || '').includes(${JSON.stringify(code)}));
      if (!a) return false;
      a.click();
      return true;
    })()`);
    await waitFor(
      `student detail ${code} loaded`,
      `Boolean(document.querySelector('video[data-kind=camera]'))`,
      40_000,
    );
  };
  const decodeCheck = `async (el) => {
    if (!el || !el.srcObject || el.readyState < 2) return false;
    try {
      await el.play();
      const c = document.createElement('canvas');
      const w = Math.min(el.videoWidth || 320, 320);
      const h = Math.min(el.videoHeight || 180, 180);
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.drawImage(el, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 12 || d[i + 1] > 12 || d[i + 2] > 12) { lit += 1; if (lit > 24) break; }
      }
      return lit > 24;
    } catch { return false; }
  }`;
  const waitDecoded = async (kind, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = 'no-element';
    for (;;) {
      const el = await js(`document.querySelector('video[data-kind=${JSON.stringify(kind)}]') !== null`);
      if (el) {
        const ok = await js(`(${decodeCheck})(document.querySelector('video[data-kind=${JSON.stringify(kind)}]'))`);
        if (ok === true) return true;
        last = 'not-decoding';
      }
      if (Date.now() > deadline) {
        marker(`UI_DECODE_TIMEOUT ${kind} (${last})`);
        return false;
      }
      await sleep(350);
    }
  };

  await openStudent(STUDENT_A);
  // Live panel must reach the connected state with camera+screen decoding.
  const liveState = await waitFor(
    'live panel connected state',
    `(() => {
      const chips = [...document.querySelectorAll('span')];
      const chip = chips.find((s) => /^\\s*●\\s*live\\s*$/.test(s.textContent || ''));
      return Boolean(chip);
    })()`,
    40_000,
  );
  const cameraFrames = await waitDecoded('camera');
  const screenFrames = await waitDecoded('screen');
  const micLive = await waitFor(
    'microphone tile live + Enable audio button',
    `Boolean(document.querySelector('audio[data-kind=microphone]')) && Boolean([...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Enable audio')))`,
    30_000,
  );
  const mutedDefault = await js(`Boolean(document.querySelector('audio[data-kind=microphone]')) && document.querySelector('audio[data-kind=microphone]').muted === true`);
  // Enable the focused student's audio explicitly.
  await js(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Enable audio'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await waitFor('audio unmuted after enable', `document.querySelector('audio[data-kind=microphone]').muted === false`, 15_000);
  const audioEnabled = await js(`document.querySelector('audio[data-kind=microphone]').muted === false`);
  if (!liveState || !cameraFrames || !screenFrames || !micLive || !mutedDefault || !audioEnabled) {
    fail(`A live view incomplete ${JSON.stringify({ liveState, cameraFrames, screenFrames, micLive, mutedDefault, audioEnabled })}`);
    return;
  }
  marker(`UI_A_LIVE ${JSON.stringify({ cameraFrames, screenFrames, micLive, mutedDefault, audioEnabled })}`);

  // Hold here while the orchestrator samples SFU consumer bytes (A active).
  await sleep(7_000);

  // -------------------------------------------------------------------------
  // 4. Switch to student B (active attempt, no media session) — A must clean up
  // -------------------------------------------------------------------------
  await js(`history.back()`);
  await waitFor(
    `board again (${STUDENT_B} tile)`,
    `(() => [...document.querySelectorAll('a')].some((a) => (a.textContent || '').includes(${JSON.stringify(STUDENT_B)})))()`,
    30_000,
  );
  await openStudent(STUDENT_B);
  // B has no secure-desktop media session: the panel must show a settled,
  // human-readable "feed unavailable" state — not an endless connecting loop.
  const bSettled = await waitFor(
    'B feed unavailable state settled',
    `(() => {
      const chips = [...document.querySelectorAll('span')];
      const liveChip = chips.find((s) => /^\\s*●\\s*live\\s*$/.test(s.textContent || ''));
      if (liveChip) return false;
      const body = document.body.innerText || '';
      const settled = body.includes('live feed unavailable') || body.includes('feed unavailable') || body.includes('cannot start a media session');
      const disconnected = chips.some((s) => /disconnected|failed/.test(s.textContent || ''));
      return settled || disconnected;
    })()`,
    40_000,
  );
  marker(`UI_B_OPEN ${JSON.stringify({ settled: bSettled })}`);
  await sleep(2_000);

  // -------------------------------------------------------------------------
  // 5. Back to A — fresh subscription, no accumulation, audio muted again
  // -------------------------------------------------------------------------
  await js(`history.back()`);
  await waitFor(
    `board again (${STUDENT_A} tile)`,
    `(() => [...document.querySelectorAll('a')].some((a) => (a.textContent || '').includes(${JSON.stringify(STUDENT_A)})))()`,
    30_000,
  );
  await openStudent(STUDENT_A);
  await waitFor(
    'A live again after re-selection',
    `(() => [...document.querySelectorAll('span')].some((s) => /^\\s*●\\s*live\\s*$/.test(s.textContent || '')))()`,
    40_000,
  );
  const cameraFrames2 = await waitDecoded('camera');
  const mutedAgain = await js(`Boolean(document.querySelector('audio[data-kind=microphone]')) && document.querySelector('audio[data-kind=microphone]').muted === true`);
  if (!cameraFrames2 || !mutedAgain) {
    fail(`A re-subscribe incomplete ${JSON.stringify({ cameraFrames2, mutedAgain })}`);
    return;
  }
  marker(`UI_A_LIVE_2 ${JSON.stringify({ cameraFrames: cameraFrames2, audioMutedAgain: mutedAgain })}`);
  await sleep(4_000);

  // -------------------------------------------------------------------------
  // 6. Terminate student A from the real UI (modal action)
  // -------------------------------------------------------------------------
  // Fires a full pointer/mouse/click sequence on the first enabled button
  // matching `match` and returns a small diagnostic; repeated by clickButton
  // until the modal (a role=dialog element) actually appears.
  const fireClick = `(match) => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes(match) && !x.disabled);
    if (!b) return 'no-button:' + match;
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
    b.click();
    return 'clicked:' + b.textContent.trim().slice(0, 24);
  }`;
  const clickButton = async (match, what, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await js(`(${fireClick})(${JSON.stringify(match)})`);
      const opened = await js(`Boolean(document.querySelector('[role=dialog]'))`);
      if (opened) return { last, opened: true };
      if (Date.now() > deadline) {
        marker(`UI_CLICK_TIMEOUT ${what} (${String(last)})`);
        return { last, opened: false };
      }
      await sleep(800);
    }
  };
  const opened = await clickButton('⛔ Terminate', 'terminate modal open');
  if (!opened.opened) fail(`terminate modal did not open (${String(opened.last)})`);
  // The modal can only be interacted with if we are still on the student page;
  // if the page moved (unexpected navigation) re-enter and retry once.
  for (let retry = 0; retry < 2; retry += 1) {
    const onStudent = await js(`location.pathname.startsWith('/monitor/students/')`);
    if (onStudent) break;
    marker(`UI_TERMINATE_REENTER ${retry}`);
    await js(`history.back()`);
    await waitFor(`board again (${STUDENT_A} tile)`, `(() => [...document.querySelectorAll('a')].some((a) => (a.textContent || '').includes(${JSON.stringify(STUDENT_A)})))()`, 20_000);
    await openStudent(STUDENT_A);
    await waitFor('A live again for terminate', `(() => [...document.querySelectorAll('span')].some((s) => /^\\s*●\\s*live\\s*$/.test(s.textContent || '')))()`, 40_000);
    const reopened = await clickButton('⛔ Terminate', 'terminate modal open retry');
    if (!reopened.opened) fail(`terminate modal did not open on retry (${String(reopened.last)})`);
  }
  await waitFor('terminate modal textarea', `Boolean(document.querySelector('[role=dialog] textarea'))`, 15_000);
  await js(`(() => {
    const el = document.querySelector('[role=dialog] textarea');
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Automated 4C.2 E2E termination');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await js(`(() => {
    const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => (x.textContent || '').includes('Terminate exam') && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })()`);
  // Detail polling flips the attempt to TERMINATED; the live view must end.
  for (let tries = 0; tries < 4; tries += 1) {
    if (await js(`(() => {
      const body = document.body.innerText || '';
      return body.includes('TERMINATED') && (body.includes('live feed has ended') || body.includes('live feed unavailable') || body.includes('no active media session'));
    })()`)) break;
    const onStudent = await js(`location.pathname.startsWith('/monitor/students/')`);
    if (!onStudent && tries < 3) {
      marker(`UI_TERMINATED_REENTER ${tries}`);
      await js(`history.back()`);
      await waitFor(`board again (${STUDENT_A} tile)`, `(() => [...document.querySelectorAll('a')].some((a) => (a.textContent || '').includes(${JSON.stringify(STUDENT_A)})))()`, 20_000);
      await openStudent(STUDENT_A);
    }
    await new Promise((r) => setTimeout(r, 8_000));
  }
  if (!(await js(`(() => { const body = document.body.innerText || ''; return body.includes('TERMINATED'); })()`))) {
    fail('attempt did not show TERMINATED after UI terminate');
  }
  marker('UI_TERMINATED');
  await sleep(3_000);
  marker('UI_DONE');
  app.exit(0);
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error(`UI_FAIL ${err instanceof Error ? err.stack ?? err.message : err}`);
    app.exit(1);
  });
});
