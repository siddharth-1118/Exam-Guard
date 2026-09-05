/**
 * Phase 4C E2E harness — Electron host for the monitor WebRTC subscriber.
 *
 * Runs the REAL monitor subscriber module (apps/monitor-web/src/lib/media/
 * subscriber.ts, bundled by esbuild into driver.bundle.js) inside Chromium so
 * actual WebRTC consumers exist. Network (API token fetch) happens in the
 * renderer against the live API; webSecurity is disabled ONLY in this dev
 * harness so the file:// page can reach localhost:4000 — the monitor portal
 * itself keeps the browser's security model.
 *
 * Env: EXAMGUARD_API_URL, E2E_ATTEMPT_ID, E2E_MONITOR_TOKEN (monitor access
 * token), E2E_CYCLES, E2E_PAUSE_MS.
 * Usage: electron apps/monitor-web/e2e/main.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Isolate from the student-desktop app's single-instance lock/userData.
app.setPath('userData', path.join(app.getPath('userData'), 'examguard-monitor-e2e'));

const API = process.env.EXAMGUARD_API_URL ?? 'http://localhost:4000';
const ATTEMPT_ID = process.env.E2E_ATTEMPT_ID ?? '';
const TOKEN = process.env.E2E_MONITOR_TOKEN ?? '';
const CYCLES = process.env.E2E_CYCLES ?? '1';
const PAUSE_MS = process.env.E2E_PAUSE_MS ?? '6000';
const WATCHDOG_MS = 240_000;

let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  setTimeout(() => app.exit(code), 300);
};

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    webPreferences: {
      webSecurity: false, // dev-only harness: file:// page talks to the API
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Electron ≥36: one console-message event whose first arg is the event
  // object (with .message/.level). Duplicate legacy args are not subscribed so
  // markers print exactly once.
  const forward = (event) => {
    const level = String(event?.level ?? 'log');
    let message = String(event?.message ?? '');
    // Chromium security warnings clutter the E2E stream — skip them.
    if (message.includes('Electron Security Warning')) return;
    message = message.replace(/\s+/g, ' ').trim();
    process.stdout.write(`[monitor-app] ${message}\n`);
    if (message.includes('E2E_MONITOR_FAIL')) {
      process.stderr.write(`[monitor-app] FAIL marker received: ${message}\n`);
      finish(1);
    } else if (message.includes('E2E_MONITOR_DONE')) {
      finish(0);
    }
  };
  win.webContents.on('console-message', forward);

  // Fail-safe: never leave an orphaned Electron alive.
  const watchdog = setTimeout(() => {
    process.stderr.write('[monitor-app] E2E watchdog timeout\n');
    finish(2);
  }, WATCHDOG_MS);

  win.webContents.on('did-finish-load', () => {
    setTimeout(() => win.show(), 500);
  });

  const query = new URLSearchParams({
    api: API,
    attemptId: ATTEMPT_ID,
    token: TOKEN,
    cycles: CYCLES,
    pauseMs: PAUSE_MS,
  });
  win.loadFile(path.join(__dirname, 'driver.html'), { query: Object.fromEntries(query) });

  app.on('before-quit', () => clearTimeout(watchdog));
});

app.on('window-all-closed', () => {
  app.quit();
});
