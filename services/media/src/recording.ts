/**
 * Recording egress: taps mediasoup producers via PlainTransport + Consumer,
 * captures RTP packets over local UDP, and outputs a valid playable WebM/MP4
 * recording file using FFmpeg (with fallback to in-process WebM writer).
 *
 * Flow per producer:
 *   producer → PlainTransport (UDP) → FFmpeg (or in-process WebM) → storage → READY
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import dgram from 'node:dgram';
import type { Consumer, Producer, Router, PlainTransport } from 'mediasoup/node/lib/types';
import { Logger } from './logger';
import { FfmpegRecordingWorker, FfmpegTrackInfo } from './ffmpeg';

// ---------------------------------------------------------------------------
// Minimal WebM (Matroska) muxer fallback — writes valid WebM files from raw VP8/Opus
// frames. Only the fields required for playback are emitted.
// ---------------------------------------------------------------------------

const EBML = {
  EBMLHeader: 0x1a45dfa3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  SegmentInfo: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  ClusterTimestamp: 0xe7,
  SimpleBlock: 0xa3,
};

export class WebmWriter {
  private readonly buffers: Buffer[] = [];
  private trackNumber = 0;
  private lastTimestampMs = 0;
  private readonly trackMap = new Map<string, number>();

  addVideoTrack(appKind: string, width = 640, height = 480): number {
    this.trackNumber += 1;
    this.trackMap.set(appKind, this.trackNumber);
    const trackEntry = this.buildTrackEntry(this.trackNumber, 'video', 'V_VP8', (buf) => buf, width, height);
    this.buffers.push(trackEntry);
    return this.trackNumber;
  }

  addAudioTrack(appKind: string, sampleRate = 48000, channels = 2): number {
    this.trackNumber += 1;
    this.trackMap.set(appKind, this.trackNumber);
    const trackEntry = this.buildTrackEntry(this.trackNumber, 'audio', 'A_OPUS', (buf) => {
      const head = Buffer.alloc(19);
      head.write('OpusHead', 0, 'ascii');
      head[8] = 1;
      head[9] = channels;
      head.writeUInt16LE(3840, 10);
      head.writeUInt32LE(sampleRate, 12);
      head.writeUInt16LE(0, 16);
      head[18] = 0;
      return Buffer.concat([buf, head]);
    }, 0, 0, sampleRate, channels);
    this.buffers.push(trackEntry);
    return this.trackNumber;
  }

  writeFrame(appKind: string, payload: Buffer, timestampMs: number, isKeyframe: boolean): void {
    const trackNum = this.trackMap.get(appKind);
    if (!trackNum) return;
    this.lastTimestampMs = Math.max(this.lastTimestampMs, timestampMs);

    const timecode = timestampMs & 0x7fff;
    const flags = isKeyframe ? 0x80 : 0x00;
    const trackNumBuf = this.encodeVint(trackNum);
    const header = Buffer.alloc(trackNumBuf.length + 2 + 1);
    trackNumBuf.copy(header, 0);
    header.writeInt16BE(timecode, trackNumBuf.length);
    header[trackNumBuf.length + 2] = flags;

    const blockData = Buffer.concat([header, payload]);
    const simpleBlock = this.wrapElement(EBML.SimpleBlock, blockData);
    this.buffers.push(simpleBlock);
  }

  build(): Buffer {
    const tracksData = Buffer.concat(this.buffers);
    const tracks = this.wrapElement(EBML.Tracks, tracksData);
    const info = this.buildSegmentInfo(this.lastTimestampMs);
    const segmentData = Buffer.concat([info, tracks]);
    const segment = this.wrapElement(EBML.Segment, segmentData);
    const header = this.buildEbmlHeader();
    return Buffer.concat([header, segment]);
  }

  getDurationMs(): number {
    return this.lastTimestampMs;
  }

  private buildEbmlHeader(): Buffer {
    const docType = this.wrapElement(EBML.DocType, Buffer.from('webm'));
    const docTypeVer = this.wrapUint(EBML.DocTypeVersion, 4);
    const docTypeReadVer = this.wrapUint(EBML.DocTypeReadVersion, 2);
    return this.wrapElement(EBML.EBMLHeader, Buffer.concat([docType, docTypeVer, docTypeReadVer]));
  }

  private buildSegmentInfo(durationMs: number): Buffer {
    const timecodeScale = this.wrapUint(EBML.TimecodeScale, 1_000_000);
    const muxingApp = this.wrapString(EBML.MuxingApp, 'ExamGuard');
    const writingApp = this.wrapString(EBML.WritingApp, 'ExamGuard');
    const duration = this.wrapFloat(EBML.Duration, durationMs);
    return this.wrapElement(EBML.SegmentInfo, Buffer.concat([timecodeScale, muxingApp, writingApp, duration]));
  }

  private buildTrackEntry(
    num: number, type: 'video' | 'audio', codecId: string,
    codecPrivateFn: (buf: Buffer) => Buffer,
    width: number, height: number,
    sampleRate?: number, channels?: number,
  ): Buffer {
    const trackNum = this.wrapUint(EBML.TrackNumber, num);
    const trackUid = this.wrapUint(EBML.TrackUID, num);
    const trackType = this.wrapUint(EBML.TrackType, type === 'video' ? 1 : 2);
    const codecID = this.wrapString(EBML.CodecID, codecId);
    const parts = [trackNum, trackUid, trackType, codecID];

    if (type === 'video') {
      const pixelW = this.wrapUint(EBML.PixelWidth, width);
      const pixelH = this.wrapUint(EBML.PixelHeight, height);
      parts.push(this.wrapElement(EBML.Video, Buffer.concat([pixelW, pixelH])));
    } else {
      const freq = this.wrapFloat(EBML.SamplingFrequency, sampleRate ?? 48000);
      const ch = this.wrapUint(EBML.Channels, channels ?? 2);
      parts.push(this.wrapElement(EBML.Audio, Buffer.concat([freq, ch])));
    }

    if (codecId === 'A_OPUS') {
      const cp = codecPrivateFn(Buffer.alloc(0));
      parts.push(this.wrapElement(EBML.CodecPrivate, cp));
    }

    return this.wrapElement(EBML.TrackEntry, Buffer.concat(parts));
  }

  private wrapElement(id: number, data: Buffer): Buffer {
    const idBuf = this.writeId(id);
    const sizeBuf = this.writeSize(data.length);
    return Buffer.concat([idBuf, sizeBuf, data]);
  }

  private wrapUint(id: number, value: number): Buffer {
    if (value < 0x80) return this.wrapElement(id, Buffer.of(value));
    if (value < 0x4000) return this.wrapElement(id, Buffer.of((value >> 8) | 0x80, value & 0xff));
    if (value < 0x200000) return this.wrapElement(id, Buffer.of((value >> 16) | 0xc0, (value >> 8) & 0xff, value & 0xff));
    return this.wrapElement(id, Buffer.of((value >> 24) | 0xe0, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff));
  }

  private wrapFloat(id: number, value: number): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(value, 0);
    return this.wrapElement(id, buf);
  }

  private wrapString(id: number, value: string): Buffer {
    return this.wrapElement(id, Buffer.from(value, 'ascii'));
  }

  private writeId(id: number): Buffer {
    if (id < 0x100) return Buffer.of(id);
    if (id < 0x10000) return Buffer.of((id >> 8) & 0xff, id & 0xff);
    if (id < 0x1000000) return Buffer.of((id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff);
    return Buffer.of((id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff);
  }

  private writeSize(size: number): Buffer {
    return this.encodeVint(size);
  }

  private encodeVint(value: number): Buffer {
    if (value < 0x7f) return Buffer.of(value | 0x80);
    if (value < 0x3fff) return Buffer.of((value >> 8) | 0x40, value & 0xff);
    if (value < 0x1fffff) return Buffer.of((value >> 16) | 0x20, (value >> 8) & 0xff, value & 0xff);
    return Buffer.of((value >> 24) | 0x10, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
  }
}

// ---------------------------------------------------------------------------
// RTP Packet Parser & Assembler
// ---------------------------------------------------------------------------

export interface RtpPacket {
  version: number;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
}

export function parseRtp(buf: Buffer): RtpPacket | null {
  if (buf.length < 12) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const padding = ((b0 >> 5) & 1) === 1;
  const extension = ((b0 >> 4) & 1) === 1;
  return {
    version: (b0 >> 6) & 0x3,
    padding,
    extension,
    csrcCount: b0 & 0x0f,
    marker: ((b1 >> 7) & 1) === 1,
    payloadType: b1 & 0x7f,
    sequenceNumber: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    payload: (() => {
      let offset = 12 + (b0 & 0x0f) * 4;
      if (extension && buf.length > offset + 4) {
        const extLen = buf.readUInt16BE(offset + 2) * 4 + 4;
        offset += extLen;
      }
      return buf.slice(offset);
    })()
  };
}

export class FrameAssembler {
  private buffer: Buffer[] = [];
  private readonly clockRate: number;
  private baseTimestamp = -1;

  constructor(clockRate: number) {
    this.clockRate = clockRate;
  }

  feed(pkt: RtpPacket): Buffer | null {
    if (pkt.version !== 2) return null;
    if (this.baseTimestamp < 0) this.baseTimestamp = pkt.timestamp;

    this.buffer.push(pkt.payload);
    if (pkt.marker) {
      const frame = Buffer.concat(this.buffer);
      this.buffer = [];
      return frame;
    }
    return null;
  }

  timestampToMs(rtpTimestamp: number): number {
    if (this.baseTimestamp < 0) return 0;
    const diff = rtpTimestamp - this.baseTimestamp;
    const wrapped = diff < 0 ? diff + 0x100000000 : diff;
    return Math.round((wrapped / this.clockRate) * 1000);
  }
}

// ---------------------------------------------------------------------------
// Recording Session Types
// ---------------------------------------------------------------------------

interface RecordingSession {
  recordingId: string;
  participantId: string;
  storageKey: string;
  transport: PlainTransport;
  consumer: Consumer;
  socket: dgram.Socket;
  assembler: FrameAssembler;
  writer: WebmWriter;
  appKind: string;
  startedAt: number;
  packetsReceived: number;
  framesWritten: number;
}

export interface RecordingEgressConfig {
  storageDir: string;
  apiUrl: string;
  sfuAdminKey: string;
}

interface ActiveRecording {
  recordingId: string;
  participantId: string;
  storageKey: string;
  sessions: RecordingSession[];
  startedAt: number;
  isFfmpeg?: boolean;
}

export class RecordingEgress {
  private readonly active = new Map<string, ActiveRecording>();
  private readonly ffmpegWorker = new FfmpegRecordingWorker();
  private portCounter = 49152;

  constructor(private readonly config: RecordingEgressConfig) {}

  /**
   * Starts recording for all producers of a participant using FFmpeg
   * (or falling back to in-process WebM writer).
   */
  async startRecording(
    router: Router,
    participantId: string,
    recordingId: string,
    storageKey: string,
    producers: Map<string, Producer>,
  ): Promise<void> {
    if (this.active.has(participantId)) {
      Logger.warn(`recording already active for ${participantId.slice(0, 8)}`);
      return;
    }

    Logger.info(`[recording] startRecording requested for participant ${participantId.slice(0, 8)}, producers=${producers.size}`);
    const rawPath = join(this.config.storageDir, ...storageKey.split('/'));
    const filePath = rawPath.endsWith('.webm') ? rawPath : `${rawPath}.webm`;
    const isFfmpegAvailable = await this.ffmpegWorker.isAvailable();
    Logger.info(`[recording] isFfmpegAvailable=${isFfmpegAvailable}, filePath=${filePath}`);

    if (isFfmpegAvailable) {
      const tracks: FfmpegTrackInfo[] = [];
      const trackSpecs: { producer: Producer; ffmpegPort: number; payloadType: number; clockRate: number; appKind: string }[] = [];
      let videoCount = 0;
      let audioCount = 0;

      for (const [producerId, producer] of producers) {
        const appData = producer.appData as { kind?: string };
        const appKind = (appData.kind as string) ?? (producer.kind === 'audio' ? 'microphone' : 'camera');
        const ffmpegPort = this.portCounter;
        this.portCounter += 2;
        const payloadType = producer.kind === 'video' ? 96 + videoCount++ : 111 + audioCount++;
        const clockRate = producer.kind === 'audio' ? 48000 : 90000;

        tracks.push({
          appKind,
          kind: producer.kind as 'audio' | 'video',
          payloadType,
          clockRate,
          port: ffmpegPort,
        });

        trackSpecs.push({ producer, ffmpegPort, payloadType, clockRate, appKind });
      }

      Logger.info(`[recording] Spawning FFmpeg with ${tracks.length} tracks...`);
      const transports: PlainTransport[] = [];
      const consumers: Consumer[] = [];
      const ffmpegSession = await this.ffmpegWorker.startRecordingSession(
        participantId,
        recordingId,
        filePath,
        tracks,
        transports,
        consumers,
      );
      Logger.info(`[recording] FFmpeg startRecordingSession result: pid=${ffmpegSession?.pid}`);

      if (ffmpegSession) {
        for (const spec of trackSpecs) {
          Logger.info(`[recording] Creating PlainTransport for producer ${spec.producer.id} (kind=${spec.producer.kind})...`);
          const transport = await router.createPlainTransport({
            listenIp: { ip: '127.0.0.1', announcedIp: undefined },
            rtcpMux: false,
          });

          await transport.connect({
            ip: '127.0.0.1',
            port: spec.ffmpegPort,
            rtcpPort: spec.ffmpegPort + 1,
          });
          Logger.info(`[recording] PlainTransport connected to port ${spec.ffmpegPort} (RTCP: ${spec.ffmpegPort + 1})`);

          const consumer = await transport.consume({
            producerId: spec.producer.id,
            rtpCapabilities: router.rtpCapabilities,
            paused: false,
          });

          await consumer.resume().catch(() => {});
          if (spec.producer.kind === 'video') {
            await consumer.requestKeyFrame().catch(() => {});
            Logger.info(`[recording] Keyframe requested for video producer ${spec.producer.id}`);
          }

          Logger.info(`[recording] Consumer created for producer ${spec.producer.id}`);

          ffmpegSession.transports.push(transport);
          ffmpegSession.consumers.push(consumer);
        }

        this.active.set(participantId, {
          recordingId,
          participantId,
          storageKey,
          sessions: [],
          startedAt: Date.now(),
          isFfmpeg: true,
        });
        Logger.info(`FFmpeg recording started for ${participantId.slice(0, 8)} (${tracks.length} tracks)`);
        return;
      }
    }

    // Fallback in-process WebM writer path
    const sessions: RecordingSession[] = [];
    const writer = new WebmWriter();

    for (const [producerId, producer] of producers) {
      const appData = producer.appData as { kind?: string };
      const appKind = (appData.kind as string) ?? (producer.kind === 'audio' ? 'microphone' : 'camera');

      if (producer.kind === 'video') {
        writer.addVideoTrack(appKind);
      } else {
        writer.addAudioTrack(appKind);
      }

      const port = this.portCounter++;
      const transport = await router.createPlainTransport({
        listenIp: { ip: '127.0.0.1', announcedIp: undefined },
        port,
      });

      await transport.connect({ ip: '127.0.0.1', port });

      const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false,
      });

      const socket = dgram.createSocket('udp4');
      const clockRate = producer.kind === 'audio' ? 48000 : 90000;
      const assembler = new FrameAssembler(clockRate);

      await new Promise<void>((resolve) => socket.bind(port, '127.0.0.1', resolve));

      let packetsReceived = 0;
      let framesWritten = 0;

      socket.on('message', (msg: Buffer) => {
        const pkt = parseRtp(msg);
        if (!pkt) return;
        packetsReceived++;
        const frame = assembler.feed(pkt);
        if (frame) {
          const ts = assembler.timestampToMs(pkt.timestamp);
          const isKeyframe = producer.kind === 'video' ? (frame[0] & 0x01) === 0 : true;
          writer.writeFrame(appKind, frame, ts, isKeyframe);
          framesWritten++;
        }
      });

      sessions.push({
        recordingId,
        participantId,
        storageKey,
        transport,
        consumer,
        socket,
        assembler,
        writer,
        appKind,
        startedAt: Date.now(),
        packetsReceived,
        framesWritten,
      });
    }

    this.active.set(participantId, {
      recordingId,
      participantId,
      storageKey,
      sessions,
      startedAt: Date.now(),
      isFfmpeg: false,
    });

    Logger.info(`In-process WebM recording started for ${participantId.slice(0, 8)} (${sessions.length} tracks)`);
  }

  /**
   * Stops recording, computes SHA-256 digest, verifies output file, and calls API finalize.
   */
  async stopRecording(
    participantId: string,
  ): Promise<{ success: boolean; sizeBytes?: number; durationMs?: number; checksumSha256?: string; error?: string }> {
    const rec = this.active.get(participantId);
    if (!rec) {
      Logger.warn(`no active recording for ${participantId.slice(0, 8)}`);
      return { success: false, error: 'no active recording' };
    }
    this.active.delete(participantId);

    const rawPath = join(this.config.storageDir, ...rec.storageKey.split('/'));
    const filePath = rawPath.endsWith('.webm') ? rawPath : `${rawPath}.webm`;
    let durationMs = Date.now() - rec.startedAt;
    let lastError: string | undefined;

    if (rec.isFfmpeg) {
      const res = await this.ffmpegWorker.stopRecordingSession(participantId);
      durationMs = res.durationMs || durationMs;
      if (!res.success && res.error) {
        lastError = res.error;
      }
    } else {
      for (const session of rec.sessions) {
        try { session.socket.close(); } catch {}
        try { session.consumer.close(); } catch {}
        try { session.transport.close(); } catch {}
      }

      const webmBuffer = rec.sessions[0]?.writer.build() ?? Buffer.alloc(0);
      durationMs = rec.sessions[0]?.writer.getDurationMs() ?? durationMs;

      if (webmBuffer.length > 0) {
        try {
          await mkdir(dirname(filePath), { recursive: true });
          const { writeFile: writeFs } = await import('node:fs/promises');
          await writeFs(filePath, webmBuffer);
        } catch (err) {
          lastError = `file write failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        lastError = 'no media frames captured';
      }
    }

    // Verify written file
    let info: { size: number };
    try {
      info = await stat(filePath);
    } catch {
      lastError = lastError ?? 'recording file not found on disk';
      await this.finalizeFailed(rec.recordingId, lastError);
      return { success: false, error: lastError };
    }

    if (info.size === 0) {
      lastError = lastError ?? 'written file is empty';
      await this.finalizeFailed(rec.recordingId, lastError);
      return { success: false, error: lastError };
    }

    // Compute SHA-256 checksum
    let checksum: string;
    try {
      const fileBuf = await readFile(filePath);
      checksum = createHash('sha256').update(fileBuf).digest('hex');
    } catch (err) {
      lastError = `failed to compute checksum: ${err instanceof Error ? err.message : String(err)}`;
      await this.finalizeFailed(rec.recordingId, lastError);
      return { success: false, error: lastError };
    }

    // Call API to finalize recording
    try {
      const finalizeUrl = `${this.config.apiUrl}/api/v1/recordings/admin/${rec.recordingId}/finalize`;
      const res = await fetch(finalizeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sfu-admin-key': this.config.sfuAdminKey,
        },
        body: JSON.stringify({
          sizeBytes: info.size,
          durationMs,
          checksumSha256: checksum,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastError = `API finalize returned ${res.status}: ${body}`;
        Logger.error(lastError);
        return { success: false, sizeBytes: info.size, durationMs, checksumSha256: checksum, error: lastError };
      }
    } catch (err) {
      lastError = `API finalize failed: ${err instanceof Error ? err.message : String(err)}`;
      Logger.error(lastError);
      return { success: false, sizeBytes: info.size, durationMs, checksumSha256: checksum, error: lastError };
    }

    Logger.info(
      `recording stopped: ${rec.recordingId.slice(0, 8)} — ${info.size} bytes, ${durationMs}ms, ` +
      `sha256=${checksum.slice(0, 16)}…`,
    );

    return { success: true, sizeBytes: info.size, durationMs, checksumSha256: checksum };
  }

  /** Server shutdown hook: stops all active recording sessions cleanly. */
  async close(): Promise<void> {
    await this.ffmpegWorker.stopAllSessions().catch(() => {});
    const activeParticipantIds = Array.from(this.active.keys());
    for (const pid of activeParticipantIds) {
      await this.stopRecording(pid).catch(() => {});
    }
  }

  private async finalizeFailed(recordingId: string, reason: string): Promise<void> {
    try {
      const url = `${this.config.apiUrl}/api/v1/recordings/admin/${recordingId}/fail`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sfu-admin-key': this.config.sfuAdminKey,
        },
        body: JSON.stringify({ reason }),
      });
    } catch (err) {
      Logger.error(`failed to report recording failure: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  isRecording(participantId: string): boolean {
    return this.active.has(participantId) || this.ffmpegWorker.isRecording(participantId);
  }

  getStatus(): Array<{ participantId: string; recordingId: string; tracks: number; durationMs: number }> {
    return Array.from(this.active.values()).map((r) => ({
      participantId: r.participantId,
      recordingId: r.recordingId,
      tracks: r.sessions.length,
      durationMs: Date.now() - r.startedAt,
    }));
  }
}
