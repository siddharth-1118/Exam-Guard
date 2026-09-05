/**
 * ExamGuard FFmpeg Recording Egress Worker.
 *
 * Spawns server-side FFmpeg processes using array-based child_process.spawn
 * to record RTP media streams directly from mediasoup PlainTransports.
 * Validates output recordings using ffprobe.
 */
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { writeFile, unlink, stat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Consumer, PlainTransport } from 'mediasoup/node/lib/types';
import { Logger } from './logger';

export interface FfmpegTrackInfo {
  appKind: string;
  kind: 'audio' | 'video';
  payloadType: number;
  ssrc?: number;
  clockRate: number;
  port: number;
}

export interface FfmpegProcessSession {
  recordingId: string;
  participantId: string;
  outputPath: string;
  sdpPath: string;
  process: ChildProcess;
  pid: number | undefined;
  transports: PlainTransport[];
  consumers: Consumer[];
  startedAt: number;
  errorOutput: string[];
}

export interface MediaProbeResult {
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  formatName?: string;
}

/** Resolves the system or embedded FFmpeg binary path. */
export function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    if (ffmpegInstaller && typeof ffmpegInstaller.path === 'string' && ffmpegInstaller.path.length > 0) {
      return ffmpegInstaller.path;
    }
  } catch {
    // fallback
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static');
    if (typeof ffmpegStatic === 'string' && ffmpegStatic.length > 0) {
      return ffmpegStatic;
    }
  } catch {
    // fallback
  }
  return 'ffmpeg';
}

/** Resolves the system or paired ffprobe binary path. */
export function getFfprobePath(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
    if (ffprobeInstaller && typeof ffprobeInstaller.path === 'string' && ffprobeInstaller.path.length > 0) {
      return ffprobeInstaller.path;
    }
  } catch {
    // fallback
  }
  const ffmpeg = getFfmpegPath();
  if (ffmpeg.includes('ffmpeg')) {
    const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    return probe;
  }
  return 'ffprobe';
}

/** Generates SDP string for FFmpeg RTP input streams. */
export function generateSdp(tracks: FfmpegTrackInfo[]): string {
  const lines: string[] = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=ExamGuard Recording',
    'c=IN IP4 127.0.0.1',
    't=0 0',
  ];

  for (const track of tracks) {
    if (track.kind === 'video') {
      lines.push(`m=video ${track.port} RTP/AVP ${track.payloadType}`);
      lines.push(`a=rtpmap:${track.payloadType} VP8/${track.clockRate}`);
    } else {
      lines.push(`m=audio ${track.port} RTP/AVP ${track.payloadType}`);
      lines.push(`a=rtpmap:${track.payloadType} opus/${track.clockRate}/2`);
    }
  }

  return lines.join('\r\n') + '\r\n';
}

export class FfmpegRecordingWorker {
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly active = new Map<string, FfmpegProcessSession>(); // participantId -> session

  constructor() {
    this.ffmpegPath = getFfmpegPath();
    this.ffprobePath = getFfprobePath();
    Logger.info(`FFmpeg recording worker initialized: ffmpeg=${this.ffmpegPath}, ffprobe=${this.ffprobePath}`);
  }

  /** Checks if FFmpeg binary is executable on host. */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(this.ffmpegPath, ['-version']);
        proc.on('error', () => resolve(false));
        proc.on('close', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Spawns an FFmpeg child process listening on SDP UDP ports.
   */
  async startRecordingSession(
    participantId: string,
    recordingId: string,
    outputPath: string,
    tracks: FfmpegTrackInfo[],
    transports: PlainTransport[],
    consumers: Consumer[],
  ): Promise<FfmpegProcessSession | null> {
    const sdpContent = generateSdp(tracks);
    const sdpPath = `${outputPath}.sdp`;

    try {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(sdpPath, sdpContent, 'utf-8');
    } catch (err) {
      Logger.error(`Failed to write SDP file: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    // Secure array-based arguments (NO shell string execution!)
    const args: string[] = [
      '-loglevel', 'warning',
      '-protocol_whitelist', 'file,crypto,data,udp,rtp',
      '-analyzeduration', '3000000',
      '-probesize', '5000000',
      '-max_delay', '500000',
      '-fflags', '+nobuffer+genpts+flush_packets',
      '-i', sdpPath,
      '-s', '640x480',
      '-map', '0',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-max_interleave_delta', '0',
      '-f', 'matroska',
      '-y',
      outputPath,
    ];

    Logger.info(`Spawning FFmpeg for participant ${participantId.slice(0, 8)} -> ${outputPath}`);

    let proc: ChildProcess;
    try {
      proc = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      Logger.error(`FFmpeg spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      await unlink(sdpPath).catch(() => {});
      return null;
    }

    const errorOutput: string[] = [];
    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (
          line &&
          !line.includes('circular_buffer_size') &&
          !line.includes('setting jitter buffer size') &&
          !line.startsWith('[udp @') &&
          !line.startsWith('[rtp @')
        ) {
          Logger.info(`[ffmpeg-stderr:${participantId.slice(0, 8)}] ${line}`);
          errorOutput.push(line);
        }
      });
    }

    proc.on('error', (err) => {
      Logger.error(`FFmpeg process error (${participantId.slice(0, 8)}): ${err.message}`);
    });

    const session: FfmpegProcessSession = {
      recordingId,
      participantId,
      outputPath,
      sdpPath,
      process: proc,
      pid: proc.pid,
      transports,
      consumers,
      startedAt: Date.now(),
      errorOutput,
    };

    this.active.set(participantId, session);
    Logger.info(`FFmpeg process spawned (PID: ${proc.pid}) for ${participantId.slice(0, 8)}`);
    return session;
  }

  /**
   * Gracefully stops the FFmpeg process, waits for process exit, and cleans up temporary files.
   */
  async stopRecordingSession(participantId: string): Promise<{ success: boolean; durationMs: number; error?: string }> {
    const session = this.active.get(participantId);
    if (!session) return { success: false, durationMs: 0, error: 'No active FFmpeg session' };

    this.active.delete(participantId);
    let durationMs = Date.now() - session.startedAt;

    // Send 'q\r\n' to stdin for graceful muxing close
    if (session.process.stdin && !session.process.stdin.destroyed) {
      try {
        session.process.stdin.write('q\r\n');
        session.process.stdin.end();
      } catch {
        // ignore
      }
    }

    // Wait for process exit with progressive fallback (SIGTERM -> SIGKILL)
    await new Promise<void>((resolve) => {
      const termTimeout = setTimeout(() => {
        if (!session.process.killed) {
          try {
            session.process.kill('SIGTERM');
          } catch {}
        }
      }, 1500);

      const killTimeout = setTimeout(() => {
        if (!session.process.killed) {
          try {
            session.process.kill('SIGKILL');
          } catch {}
        }
        resolve();
      }, 5000);

      session.process.on('close', () => {
        clearTimeout(termTimeout);
        clearTimeout(killTimeout);
        resolve();
      });
    });

    // Clean up temporary SDP file
    await unlink(session.sdpPath).catch(() => {});

    // Close mediasoup consumers and transports
    for (const c of session.consumers) {
      try {
        c.close();
      } catch {}
    }
    for (const t of session.transports) {
      try {
        t.close();
      } catch {}
    }

    // Inspect file using ffprobe if available
    const probe = await this.probeFile(session.outputPath).catch(() => null);
    if (probe && probe.durationMs > 0) {
      durationMs = probe.durationMs;
    }

    // Check output file
    try {
      const info = await stat(session.outputPath);
      if (info.size > 0) {
        Logger.info(`FFmpeg recording stopped cleanly: ${info.size} bytes, ${durationMs}ms (PID: ${session.pid})`);
        return { success: true, durationMs };
      }
    } catch {
      // stat failed
    }

    const lastErr = session.errorOutput.pop() ?? 'Empty or missing output file';
    Logger.warn(`FFmpeg recording finalization warning: ${lastErr}`);
    return { success: false, durationMs, error: lastErr };
  }

  /**
   * Inspects a media file using ffprobe.
   */
  async probeFile(filePath: string): Promise<MediaProbeResult | null> {
    return new Promise((resolve) => {
      const args = [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name:stream=codec_type',
        '-of', 'json',
        filePath,
      ];

      execFile(this.ffprobePath, args, { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout) {
          return resolve(null);
        }
        try {
          const parsed = JSON.parse(stdout) as {
            format?: { duration?: string; format_name?: string };
            streams?: Array<{ codec_type?: string }>;
          };
          const durSec = parseFloat(parsed.format?.duration ?? '0');
          const hasVideo = parsed.streams?.some((s) => s.codec_type === 'video') ?? false;
          const hasAudio = parsed.streams?.some((s) => s.codec_type === 'audio') ?? false;

          resolve({
            durationMs: Math.round(durSec * 1000),
            hasVideo,
            hasAudio,
            formatName: parsed.format?.format_name,
          });
        } catch {
          resolve(null);
        }
      });
    });
  }

  /** Server shutdown hook: terminates all active FFmpeg child processes cleanly. */
  async stopAllSessions(): Promise<void> {
    const keys = Array.from(this.active.keys());
    for (const key of keys) {
      await this.stopRecordingSession(key).catch(() => {});
    }
  }

  /** Checks if session is active. */
  isRecording(participantId: string): boolean {
    return this.active.has(participantId);
  }
}
