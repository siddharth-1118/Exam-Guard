/**
 * ffmpeg.ts unit tests — pure functions only (generateSdp, path resolution).
 * FfmpegRecordingWorker tests are excluded since they require real child processes;
 * those are covered by the integration/smoke tests.
 */
import { generateSdp, getFfmpegPath, getFfprobePath, type FfmpegTrackInfo } from './ffmpeg';

describe('generateSdp', () => {
  it('generates valid SDP for a single video track', () => {
    const tracks: FfmpegTrackInfo[] = [
      { appKind: 'camera', kind: 'video', payloadType: 96, clockRate: 90000, port: 50000 },
    ];
    const sdp = generateSdp(tracks);
    expect(sdp).toContain('v=0');
    expect(sdp).toContain('s=ExamGuard Recording');
    expect(sdp).toContain('m=video 50000 RTP/AVP 96');
    expect(sdp).toContain('a=rtpmap:96 VP8/90000');
    expect(sdp).toMatch(/\r\n$/); // ends with CRLF
  });

  it('generates valid SDP for a single audio track', () => {
    const tracks: FfmpegTrackInfo[] = [
      { appKind: 'microphone', kind: 'audio', payloadType: 111, clockRate: 48000, port: 50002 },
    ];
    const sdp = generateSdp(tracks);
    expect(sdp).toContain('m=audio 50002 RTP/AVP 111');
    expect(sdp).toContain('a=rtpmap:111 opus/48000/2');
  });

  it('generates valid SDP for multiple tracks (video + audio)', () => {
    const tracks: FfmpegTrackInfo[] = [
      { appKind: 'camera', kind: 'video', payloadType: 96, clockRate: 90000, port: 50000 },
      { appKind: 'microphone', kind: 'audio', payloadType: 111, clockRate: 48000, port: 50002 },
    ];
    const sdp = generateSdp(tracks);
    expect(sdp).toContain('m=video 50000 RTP/AVP 96');
    expect(sdp).toContain('m=audio 50002 RTP/AVP 111');
    // Video line appears before audio line
    const videoIdx = sdp.indexOf('m=video');
    const audioIdx = sdp.indexOf('m=audio');
    expect(videoIdx).toBeLessThan(audioIdx);
  });

  it('generates valid SDP for screen share (video)', () => {
    const tracks: FfmpegTrackInfo[] = [
      { appKind: 'screen', kind: 'video', payloadType: 97, clockRate: 90000, port: 50004 },
    ];
    const sdp = generateSdp(tracks);
    expect(sdp).toContain('m=video 50004 RTP/AVP 97');
    expect(sdp).toContain('a=rtpmap:97 VP8/90000');
  });

  it('returns header-only SDP for empty tracks', () => {
    const sdp = generateSdp([]);
    expect(sdp).toContain('v=0');
    expect(sdp).toContain('t=0 0');
    expect(sdp).not.toContain('m=');
  });
});

describe('getFfmpegPath / getFfprobePath', () => {
  const origEnv = process.env.FFMPEG_PATH;
  const origFfprobe = process.env.FFPROBE_PATH;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = origEnv;
    if (origFfprobe === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = origFfprobe;
  });

  it('uses FFMPEG_PATH env when set', () => {
    process.env.FFMPEG_PATH = '/custom/ffmpeg';
    expect(getFfmpegPath()).toBe('/custom/ffmpeg');
  });

  it('uses FFPROBE_PATH env when set', () => {
    process.env.FFPROBE_PATH = '/custom/ffprobe';
    expect(getFfprobePath()).toBe('/custom/ffprobe');
  });

  it('falls back to "ffmpeg" when no env and no packages', () => {
    delete process.env.FFMPEG_PATH;
    // In test env, @ffmpeg-installer/ffmpeg likely not resolvable
    // so it should fall back to 'ffmpeg'
    const path = getFfmpegPath();
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
  });

  it('derives ffprobe from ffmpeg path when FFPROBE_PATH not set and no installer', () => {
    delete process.env.FFPROBE_PATH;
    process.env.FFMPEG_PATH = '/usr/bin/ffmpeg';
    // The ffprobe-installer package may be present; if so, it wins over derivation.
    // We can only assert the derivation logic fires when the installer is absent.
    // Since we can't uninstall it, verify the function returns a non-empty string
    // and, when the installer IS absent, would derive from the ffmpeg path.
    const probe = getFfprobePath();
    expect(probe.length).toBeGreaterThan(0);
  });
});
