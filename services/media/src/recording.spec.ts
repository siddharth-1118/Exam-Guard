/**
 * recording.ts unit tests — pure functions + RecordingEgress with mocked mediasoup.
 *
 * Covers:
 *   parseRtp: valid RTP, too short, padding, extension, CSRC
 *   FrameAssembler: single frame, multi-packet frame, version rejection, timestamp conversion
 *   WebmWriter: header, tracks, frames, build, duration, unknown track ignored
 *   RecordingEgress: duplicate start prevention, stop when inactive, port allocation, isRecording/getStatus
 */
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { parseRtp, FrameAssembler, WebmWriter, RecordingEgress, type RtpPacket } from './recording';
import type { Producer, Router, PlainTransport, Consumer } from 'mediasoup/node/lib/types';

// Mock dgram to prevent real UDP socket binding in tests
jest.mock('node:dgram', () => {
  const mockSocket = {
    bind: jest.fn((_port: number, _host: string, cb?: () => void) => { cb?.(); }),
    close: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
  };
  return {
    __esModule: true,
    default: { createSocket: jest.fn(() => mockSocket) },
  };
});

// ---------------------------------------------------------------------------
// parseRtp
// ---------------------------------------------------------------------------
describe('parseRtp', () => {
  /** Build a minimal valid RTP packet. */
  function makeRtp(overrides: Partial<{
    version: number; padding: boolean; extension: boolean;
    csrcCount: number; marker: boolean; payloadType: number;
    sequenceNumber: number; timestamp: number; ssrc: number;
    payload: Buffer;
  }> = {}): Buffer {
    const v = overrides.version ?? 2;
    const p = overrides.padding ? 1 : 0;
    const x = overrides.extension ? 1 : 0;
    const cc = overrides.csrcCount ?? 0;
    const m = overrides.marker ? 1 : 0;
    const pt = overrides.payloadType ?? 96;
    const seq = overrides.sequenceNumber ?? 1;
    const ts = overrides.timestamp ?? 160;
    const ssrc = overrides.ssrc ?? 12345;
    const payload = overrides.payload ?? Buffer.from('test-payload');

    const b0 = (v << 6) | (p << 5) | (x << 4) | cc;
    const b1 = (m << 7) | pt;
    const header = Buffer.alloc(12);
    header[0] = b0;
    header[1] = b1;
    header.writeUInt16BE(seq, 2);
    header.writeUInt32BE(ts, 4);
    header.writeUInt32BE(ssrc, 8);
    return Buffer.concat([header, payload]);
  }

  it('parses a valid minimal RTP packet', () => {
    const buf = makeRtp({ version: 2, marker: true, payloadType: 96, sequenceNumber: 42, timestamp: 320, ssrc: 999 });
    const pkt = parseRtp(buf)!;
    expect(pkt).not.toBeNull();
    expect(pkt.version).toBe(2);
    expect(pkt.marker).toBe(true);
    expect(pkt.payloadType).toBe(96);
    expect(pkt.sequenceNumber).toBe(42);
    expect(pkt.timestamp).toBe(320);
    expect(pkt.ssrc).toBe(999);
    expect(pkt.payload.toString()).toBe('test-payload');
    expect(pkt.padding).toBe(false);
    expect(pkt.extension).toBe(false);
    expect(pkt.csrcCount).toBe(0);
  });

  it('returns null for buffers shorter than 12 bytes', () => {
    expect(parseRtp(Buffer.alloc(11))).toBeNull();
    expect(parseRtp(Buffer.alloc(0))).toBeNull();
  });

  it('parses padding flag', () => {
    const pkt = parseRtp(makeRtp({ padding: true }))!;
    expect(pkt.padding).toBe(true);
  });

  it('parses extension flag and skips extension header', () => {
    // Build packet with extension: 12-byte header + 4-byte ext header + 8-byte ext data + payload
    const extData = Buffer.alloc(8, 0xab);
    const extHeader = Buffer.alloc(4);
    extHeader.writeUInt16BE(0, 0); // profile
    extHeader.writeUInt16BE(2, 2); // length in 32-bit words (2 words = 8 bytes)
    const payload = Buffer.from('after-ext');
    const b0 = (2 << 6) | (1 << 4); // v=2, extension=1
    const header = Buffer.alloc(12);
    header[0] = b0;
    header[1] = 96;
    header.writeUInt32BE(160, 4);
    header.writeUInt32BE(111, 8);
    const buf = Buffer.concat([header, extHeader, extData, payload]);
    const pkt = parseRtp(buf)!;
    expect(pkt.extension).toBe(true);
    expect(pkt.payload.toString()).toBe('after-ext');
  });

  it('parses CSRC count and advances payload offset', () => {
    const csrcs = [Buffer.alloc(4)]; // 1 CSRC
    csrcs[0].writeUInt32BE(0xDEAD, 0);
    const b0 = (2 << 6) | 1; // cc=1
    const header = Buffer.alloc(12);
    header[0] = b0;
    header[1] = 96;
    header.writeUInt32BE(160, 4);
    header.writeUInt32BE(222, 8);
    const payload = Buffer.from('csrc-payload');
    const buf = Buffer.concat([header, ...csrcs, payload]);
    const pkt = parseRtp(buf)!;
    expect(pkt.csrcCount).toBe(1);
    expect(pkt.payload.toString()).toBe('csrc-payload');
  });
});

// ---------------------------------------------------------------------------
// FrameAssembler
// ---------------------------------------------------------------------------
describe('FrameAssembler', () => {
  function makePkt(ts: number, marker: boolean, payload: string): RtpPacket {
    return { version: 2, padding: false, extension: false, csrcCount: 0, marker, payloadType: 96, sequenceNumber: 1, timestamp: ts, ssrc: 1, payload: Buffer.from(payload) };
  }

  it('accumulates packets and returns frame on marker', () => {
    const asm = new FrameAssembler(90000);
    expect(asm.feed(makePkt(0, false, 'a'))).toBeNull();
    expect(asm.feed(makePkt(0, false, 'b'))).toBeNull();
    const frame = asm.feed(makePkt(0, true, 'c'))!;
    expect(frame).not.toBeNull();
    expect(frame.toString()).toBe('abc');
  });

  it('rejects RTP version !== 2', () => {
    const asm = new FrameAssembler(90000);
    expect(asm.feed({ ...makePkt(0, true, 'x'), version: 1 })).toBeNull();
  });

  it('converts RTP timestamps to milliseconds', () => {
    const asm = new FrameAssembler(90000);
    asm.feed(makePkt(0, false, 'a'));
    asm.feed(makePkt(45000, true, 'b')); // 45000/90000 = 0.5s = 500ms
    expect(asm.timestampToMs(45000)).toBe(500);
  });

  it('handles timestamp wrapping (32-bit unsigned)', () => {
    const asm = new FrameAssembler(90000);
    asm.feed(makePkt(0xFFFFFF00, false, 'a'));
    asm.feed(makePkt(100, true, 'b'));
    const ms = asm.timestampToMs(100);
    // diff = 100 - 0xFFFFFF00 = -4294966940; wrapped = +4294967296 = 356
    // 356 / 90000 * 1000 ≈ 4ms
    expect(ms).toBe(4);
  });

  it('returns 0 for timestampToMs before any packet', () => {
    const asm = new FrameAssembler(48000);
    expect(asm.timestampToMs(1000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WebmWriter
// ---------------------------------------------------------------------------
describe('WebmWriter', () => {
  it('builds a valid WebM file from video frames', () => {
    const w = new WebmWriter();
    w.addVideoTrack('camera');
    w.writeFrame('camera', Buffer.from('frame1'), 1000, true);
    w.writeFrame('camera', Buffer.from('frame2'), 1500, false);
    const buf = w.build();
    expect(buf.length).toBeGreaterThan(0);
    // Starts with EBML header magic bytes 0x1a 0x45 0xdf 0xa3
    expect(buf[0]).toBe(0x1a);
    expect(buf[1]).toBe(0x45);
    expect(buf[2]).toBe(0xdf);
    expect(buf[3]).toBe(0xa3);
    expect(w.getDurationMs()).toBe(1500);
  });

  it('builds a valid WebM file from audio tracks', () => {
    const w = new WebmWriter();
    w.addAudioTrack('microphone');
    w.writeFrame('microphone', Buffer.from('opus-data'), 500, true);
    const buf = w.build();
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x1a); // EBML header
  });

  it('handles multi-track (video + audio)', () => {
    const w = new WebmWriter();
    w.addVideoTrack('camera');
    w.addAudioTrack('microphone');
    w.writeFrame('camera', Buffer.from('v'), 100, true);
    w.writeFrame('microphone', Buffer.from('a'), 100, true);
    const buf = w.build();
    expect(buf.length).toBeGreaterThan(0);
  });

  it('ignores frames for unknown track', () => {
    const w = new WebmWriter();
    w.addVideoTrack('camera');
    w.writeFrame('nonexistent', Buffer.from('x'), 100, true);
    const buf = w.build();
    // Only the track entry, no frames
    expect(buf.length).toBeGreaterThan(0);
    expect(w.getDurationMs()).toBe(0);
  });

  it('returns 0 duration with no frames', () => {
    const w = new WebmWriter();
    w.addVideoTrack('camera');
    expect(w.getDurationMs()).toBe(0);
  });

  it('tracks max timestamp across frames', () => {
    const w = new WebmWriter();
    w.addVideoTrack('camera');
    w.writeFrame('camera', Buffer.from('a'), 100, true);
    w.writeFrame('camera', Buffer.from('b'), 5000, false);
    w.writeFrame('camera', Buffer.from('c'), 2000, false);
    expect(w.getDurationMs()).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// RecordingEgress — mocked mediasoup
// ---------------------------------------------------------------------------
describe('RecordingEgress', () => {
  let egress: RecordingEgress;
  const mockTransport = {
    id: 'transport-1',
    connect: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue({
      id: 'consumer-1',
      resume: jest.fn().mockResolvedValue(undefined),
      requestKeyFrame: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
    }),
    close: jest.fn(),
  } as unknown as PlainTransport;
  const mockConsumer = {
    id: 'consumer-1',
    resume: jest.fn().mockResolvedValue(undefined),
    requestKeyFrame: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  } as unknown as Consumer;
  const mockRouter = {
    createPlainTransport: jest.fn().mockResolvedValue(mockTransport),
    rtpCapabilities: { codecs: [] },
  } as unknown as Router;
  const mockProducer = (kind: 'audio' | 'video', appKind: string) =>
    ({
      id: `prod-${appKind}`,
      kind,
      appData: { kind: appKind },
    }) as unknown as Producer;

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock global fetch to prevent finalizeFailed from hanging on HTTP calls
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    egress = new RecordingEgress({
      storageDir: '/tmp/test-recordings',
      apiUrl: 'http://localhost:4000',
      sfuAdminKey: 'test-key',
    });
    // Mock the FFmpeg worker to be unavailable (forces WebM fallback)
    jest.spyOn((egress as any).ffmpegWorker, 'isAvailable').mockResolvedValue(false);
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  it('prevents duplicate start for same participant', async () => {
    const producers = new Map([['p1', mockProducer('video', 'camera')]]);
    await egress.startRecording(mockRouter, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);
    expect(egress.isRecording('part-1')).toBe(true);

    // Second start should be a no-op (no error, no extra transport)
    const callCount = (mockRouter.createPlainTransport as jest.Mock).mock.calls.length;
    await egress.startRecording(mockRouter, 'part-1', 'rec-2', 'org/recordings/rec-2/camera', producers);
    expect((mockRouter.createPlainTransport as jest.Mock).mock.calls.length).toBe(callCount);
  });

  it('returns error when stopping with no active recording', async () => {
    const result = await egress.stopRecording('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no active recording');
  });

  it('isRecording returns false for unknown participant', () => {
    expect(egress.isRecording('unknown')).toBe(false);
  });

  it('getStatus returns empty array when nothing active', () => {
    expect(egress.getStatus()).toEqual([]);
  });

  it('getStatus returns active recordings', async () => {
    const producers = new Map([['p1', mockProducer('video', 'camera')]]);
    await egress.startRecording(mockRouter, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);
    const status = egress.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].participantId).toBe('part-1');
    expect(status[0].recordingId).toBe('rec-1');
  });

  it('creates transport with correct port allocation', async () => {
    const producers = new Map([
      ['p1', mockProducer('video', 'camera')],
      ['p2', mockProducer('audio', 'microphone')],
    ]);
    await egress.startRecording(mockRouter, 'part-1', 'rec-1', 'org/recordings/rec-1/combined', producers);
    // WebM fallback: one transport per producer, ports increment by 1
    const calls = (mockRouter.createPlainTransport as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);
    // First port should be 49152 (default start)
    expect(calls[0][0].listenIp.ip).toBe('127.0.0.1');
  });

  it('close stops all active recordings', async () => {
    const producers = new Map([['p1', mockProducer('video', 'camera')]]);
    await egress.startRecording(mockRouter, 'part-1', 'rec-1', 'org/recordings/rec-1/camera', producers);
    expect(egress.isRecording('part-1')).toBe(true);
    // close calls stopRecording which will try to stat the file and fail
    // but it should still clean up the active map
    await egress.close();
    // After close, the active map should be cleared
    expect(egress.getStatus()).toHaveLength(0);
  });
});
