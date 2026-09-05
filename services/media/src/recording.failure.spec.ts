/**
 * C22 Failure-Injection Tests — Recording Egress
 *
 * Tests failure modes that CAN be tested locally with mocks. Each test
 * documents: EXPECTED STATE, RECOVERY MECHANISM, DATA LOSS, USER IMPACT.
 *
 * Requires production infrastructure (NOT testable locally):
 *   - API restart during exam (requires live API + DB)
 *   - Redis restart during exam (requires live Redis)
 *   - Database connection interruption (requires live DB)
 *   - Student desktop network interruption (requires real Electron)
 *   - Monitor network interruption (requires real browser)
 *
 * These are documented in the "production-only" describe block at the bottom.
 */
import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import * as fs from 'node:fs/promises';
import { RecordingEgress, type RecordingEgressConfig } from './recording';
import type { Producer, Router, PlainTransport, Consumer } from 'mediasoup/node/lib/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('node:dgram', () => {
  const mockSocket = {
    bind: jest.fn((_port: number, _host: string, cb?: () => void) => { cb?.(); }),
    close: jest.fn(),
    on: jest.fn(),
  };
  return { __esModule: true, default: { createSocket: jest.fn(() => mockSocket) } };
});

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    mkdir: jest.fn(actual.mkdir),
    stat: jest.fn(actual.stat),
    readFile: jest.fn(actual.readFile),
    writeFile: jest.fn(actual.writeFile),
    unlink: jest.fn(actual.unlink),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeProducer(kind: 'audio' | 'video', appKind: string): Producer {
  return { id: `prod-${appKind}`, kind, appData: { kind: appKind } } as unknown as Producer;
}

function makeRouter(overrides: Partial<{ createPlainTransport: jest.Mock }> = {}): Router {
  return {
    createPlainTransport: overrides.createPlainTransport ?? jest.fn().mockResolvedValue({
      id: 'transport-1',
      connect: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue({
        id: 'consumer-1',
        resume: jest.fn().mockResolvedValue(undefined),
        requestKeyFrame: jest.fn().mockResolvedValue(undefined),
        close: jest.fn(),
      }),
      close: jest.fn(),
    }),
    rtpCapabilities: { codecs: [] },
  } as unknown as Router;
}

const CONFIG: RecordingEgressConfig = {
  storageDir: '/tmp/test-rec',
  apiUrl: 'http://localhost:4000',
  sfuAdminKey: 'test-key',
};

// ---------------------------------------------------------------------------
// Failure injection tests
// ---------------------------------------------------------------------------
describe('C22 — Failure injection: recording egress', () => {
  let egress: RecordingEgress;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    // Mock FFmpeg as unavailable → forces WebM fallback path
    egress = new RecordingEgress(CONFIG);
    jest.spyOn((egress as any).ffmpegWorker, 'isAvailable').mockResolvedValue(false);
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  // -------------------------------------------------------------------------
  // 1. Publisher disconnect during recording
  // -------------------------------------------------------------------------
  describe('1. Publisher disconnect during recording', () => {
    /*
     * EXPECTED STATE: Recording transitions to FAILED (file not found on disk).
     * RECOVERY MECHANISM: finalizeFailed() calls API /fail endpoint.
     * DATA LOSS: Recording data lost (media not captured to disk).
     * USER IMPACT: Exam evidence missing for that track.
     */
    it('stopRecording after socket close → FAILED with error, resources cleaned up', async () => {
      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);
      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);
      expect(egress.isRecording('part-1')).toBe(true);

      // Simulate: socket was closed (publisher disconnected), file was never written
      const { unlink: realUnlink } = jest.requireActual('node:fs/promises') as typeof fs;
      jest.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const result = await egress.stopRecording('part-1');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(egress.isRecording('part-1')).toBe(false);
      expect(egress.getStatus()).toHaveLength(0);

      // Verify finalizeFailed was called
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/admin/rec-1/fail'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Storage failure during finalization
  // -------------------------------------------------------------------------
  describe('2. Storage failure during finalization', () => {
    /*
     * EXPECTED STATE: Recording transitions to FAILED, no partial READY.
     * RECOVERY MECHANISM: finalizeFailed() reports failure to API.
     * DATA LOSS: Object missing from storage.
     * USER IMPACT: Recording not accessible.
     */
    it('file not found on disk → FAILED, calls /fail endpoint', async () => {
      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);
      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);

      jest.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const result = await egress.stopRecording('part-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/admin/rec-1/fail'),
        expect.any(Object),
      );
    });

    it('empty file (0 bytes) → FAILED', async () => {
      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);
      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);

      jest.spyOn(fs, 'stat').mockResolvedValueOnce({ size: 0 } as any);

      const result = await egress.stopRecording('part-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('checksum read failure → FAILED', async () => {
      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);
      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);

      jest.spyOn(fs, 'stat').mockResolvedValueOnce({ size: 100 } as any);
      jest.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('EIO'));

      const result = await egress.stopRecording('part-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('checksum');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Attempt termination while recording is active
  // -------------------------------------------------------------------------
  describe('3. Attempt termination while recording is active', () => {
    /*
     * EXPECTED STATE: Recording stops, transitions based on file availability.
     * RECOVERY MECHANISM: Server-initiated teardown calls stopRecording().
     * DATA LOSS: Partial recording may exist.
     * USER IMPAT: Exam session ends cleanly.
     */
    it('close() stops all active recordings and cleans up', async () => {
      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);
      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);
      await egress.startRecording(router, 'part-2', 'rec-2', 'org/recordings/rec-2/camera', producers);
      expect(egress.getStatus()).toHaveLength(2);

      // Mock stat to succeed (file exists)
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 50 } as any);

      await egress.close();
      expect(egress.getStatus()).toHaveLength(0);
    });

    it('stopRecording is idempotent — calling twice returns error on second call', async () => {
      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);
      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);

      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 50 } as any);
      const r1 = await egress.stopRecording('part-1');
      expect(r1.success).toBe(true);

      const r2 = await egress.stopRecording('part-1');
      expect(r2.success).toBe(false);
      expect(r2.error).toContain('no active recording');
    });
  });

  // -------------------------------------------------------------------------
  // 4. FFmpeg crash (non-zero exit)
  // -------------------------------------------------------------------------
  describe('4. FFmpeg crash (non-zero exit)', () => {
    /*
     * EXPECTED STATE: Recording transitions to FAILED.
     * RECOVERY MECHANISM: FFmpeg worker reports failure, finalizeFailed called.
     * DATA LOSS: Recording data lost (FFmpeg output corrupt or missing).
     * USER IMPACT: Exam evidence missing.
     */
    it('FFmpeg worker reports failure → FAILED, finalizeFailed called', async () => {
      // Use the FFmpeg path (not WebM fallback)
      jest.spyOn((egress as any).ffmpegWorker, 'isAvailable').mockResolvedValue(true);
      const mockSession = {
        recordingId: 'rec-1', participantId: 'part-1', pid: 1234,
        transports: [], consumers: [], startedAt: Date.now(), errorOutput: ['codec error'],
      };
      jest.spyOn((egress as any).ffmpegWorker, 'startRecordingSession').mockResolvedValue(mockSession);
      jest.spyOn((egress as any).ffmpegWorker, 'stopRecordingSession').mockResolvedValue({
        success: false, durationMs: 1000, error: 'FFmpeg exited with code 1',
      });
      jest.spyOn((egress as any).ffmpegWorker, 'isRecording').mockReturnValue(false);

      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);
      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);

      // FFmpeg crashed → output file doesn't exist
      jest.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const result = await egress.stopRecording('part-1');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/admin/rec-1/fail'),
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. Duplicate startRecording call
  // -------------------------------------------------------------------------
  describe('5. Duplicate startRecording call', () => {
    /*
     * EXPECTED STATE: Second call is a no-op. Single recording active.
     * RECOVERY MECHANISM: Idempotent guard in startRecording().
     * DATA LOSS: None.
     * USER IMPACT: None.
     */
    it('second startRecording for same participant is a no-op', async () => {
      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);

      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);
      const createCount = (router.createPlainTransport as jest.Mock).mock.calls.length;

      // Second call with different recordingId — should be ignored
      await egress.startRecording(router, 'part-1', 'rec-2', 'org/recordings/rec-2/camera', producers);
      expect((router.createPlainTransport as jest.Mock).mock.calls.length).toBe(createCount);
      expect(egress.getStatus()).toHaveLength(1);
      expect(egress.getStatus()[0].recordingId).toBe('rec-1');
    });

    it('two different participants can record simultaneously', async () => {
      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);

      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);
      await egress.startRecording(router, 'part-2', 'rec-2', 'org/recordings/rec-2/camera', producers);
      expect(egress.getStatus()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // 6. API finalize failure (network error or non-200)
  // -------------------------------------------------------------------------
  describe('6. API finalize failure', () => {
    /*
     * EXPECTED STATE: Recording stopped locally, but API transition may not
     * have happened. Error returned to caller.
     * RECOVERY MECHANISM: Caller can retry or the sweeper will eventually
     * clean up orphaned state.
     * DATA LOSS: Object exists on disk but metadata may not be READY.
     * USER IMPACT: Recording may need manual intervention.
     */
    it('API returns non-200 → error with size/checksum info', async () => {
      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);
      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);

      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 200 } as any);
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('real-bytes'));
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('server error') });

      const result = await egress.stopRecording('part-1');
      expect(result.success).toBe(false);
      expect(result.sizeBytes).toBe(200);
      expect(result.checksumSha256).toBeDefined();
      expect(result.error).toContain('500');
    });

    it('API network failure → error with checksum info preserved', async () => {
      const router = makeRouter();
      const producers = new Map([['p1', makeProducer('video', 'camera')]]);
      await egress.startRecording(router, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);

      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 100 } as any);
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('data'));
      (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await egress.stopRecording('part-1');
      expect(result.success).toBe(false);
      expect(result.checksumSha256).toBeDefined();
      expect(result.error).toContain('finalize failed');
    });
  });
});

// ---------------------------------------------------------------------------
// Production-only failure modes (cannot be tested locally)
// ---------------------------------------------------------------------------
describe('C22 — Production-only failure modes (documented, not tested)', () => {
  it.skip('API restart during exam — DB state authoritative, Redis ephemeral keys expire', () => {
    // Requires: live API + PostgreSQL + Redis
    // Expected: DB state authoritative; Redis keys expire by TTL; sweeper reconciles
    // Recovery: Server restarts; sweeper reconciles on boot
    // Data loss: None (DB is source of truth)
    // User impact: Brief disconnection, auto-reconnect
  });

  it.skip('Redis restart during exam — fail-safe degraded mode', () => {
    // Requires: live Redis instance
    // Expected: Presence keys expire; ownership leases expire; fail-safe mode
    // Recovery: Redis recovers automatically; presence rebuilt on next heartbeat
    // Data loss: None (no persistent data in Redis)
    // User impact: Monitor may show stale presence briefly
  });

  it.skip('Database connection interruption — request failures', () => {
    // Requires: live PostgreSQL
    // Expected: DB queries fail; API returns 500s; no state corruption
    // Recovery: DB connection restored; API resumes
    // Data loss: In-flight transactions lost (but attempts are idempotent)
    // User impact: Temporary API unavailability
  });

  it.skip('Student desktop network interruption — reconnect grace', () => {
    // Requires: running Electron desktop app
    // Expected: Gateway detects disconnect; 45s reconnect grace; sweeper cleans up
    // Recovery: Student reconnects within grace or session ends
    // Data loss: None (attempt state preserved)
    // User impact: Reconnect prompt shown
  });

  it.skip('Monitor network interruption — subscriber detached', () => {
    // Requires: running monitor browser
    // Expected: Gateway removes subscriber; publisher unaffected
    // Recovery: Monitor reconnects independently
    // Data loss: None
    // User impact: Brief feed interruption
  });

  it.skip('SFU worker crash — all rooms destroyed', () => {
    // Requires: running mediasoup worker
    // Expected: Worker death event; process.exit(1) triggered
    // Recovery: Process manager restarts the service
    // Data loss: All active recordings fail
    // User impact: Complete media disruption
  });
});
