/**
 * ExamGuard media plane — mediasoup SFU (Phase 4B).
 *
 * Publish-only: a student desktop authenticates with a short-lived media token,
 * joins its per-participant room, and produces camera/microphone/screen tracks.
 * Monitor subscription arrives in Phase 4C.
 *
 * Run: JWT_SECRET=<shared secret> node services/media/src/index.ts
 */
import path from 'node:path';
import { loadConfig } from './config';
import { Logger } from './logger';
import { startServer } from './server';
import { SfuService } from './sfu';

// Dev convenience: inherit the repository root .env (JWT_SECRET shared with the
// API). Production deployments pass real env vars instead. Both src/ and dist/
// sit three levels under the repo root, so probe for the .env explicitly.
try {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', '.env'), // repo root from src/ or dist/
    path.resolve(process.cwd(), '.env'),
  ];
  for (const file of candidates) {
    try {
      process.loadEnvFile(file);
      break;
    } catch {
      // try next candidate
    }
  }
} catch {
  // no root .env — rely on the process environment
}

async function main(): Promise<void> {
  const config = loadConfig();
  const sfu = new SfuService(config);
  await sfu.start();
  const handle = await startServer(sfu, config);
  Logger.info('ExamGuard media service ready');

  const shutdown = (signal: string): void => {
    Logger.info(`${signal} received — shutting down`);
    void handle.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    Logger.error(`uncaught exception: ${err.stack ?? String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    Logger.error(`unhandled rejection: ${String(reason)}`);
  });
}

void main();
