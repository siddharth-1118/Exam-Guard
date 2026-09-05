const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { createRequire } = require('module');

const mediaReq = createRequire(path.join(process.cwd(), 'services/media/package.json'));
const ffmpegPath = mediaReq('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = mediaReq('@ffprobe-installer/ffprobe').path;

async function runRecordingPipelineAudit() {
  console.log('=== REAL RECORDING PIPELINE AUDIT ===');
  console.log(`FFmpeg path: ${ffmpegPath}`);
  console.log(`FFprobe path: ${ffprobePath}`);

  const results = {
    ffmpegPath,
    ffprobePath,
    binaryAvailable: false,
    fileCreated: false,
    fileSizeBytes: 0,
    ffprobeInspected: false,
    durationMs: 0,
    hasVideo: false,
    hasAudio: false,
    sha256Digest: null,
    storageVerified: false,
    checksumMismatchHandling: false,
    missingObjectHandling: false,
    deletionHandled: false
  };

  // 1. Check binary availability
  const isAvailable = await new Promise(resolve => {
    const p = spawn(ffmpegPath, ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', code => resolve(code === 0));
  });
  results.binaryAvailable = isAvailable;
  console.log(`FFmpeg Available: ${isAvailable}`);

  if (!isAvailable) {
    console.error('FFmpeg binary not available!');
    return results;
  }

  // 2. Generate a real test recording file using FFmpeg lavfi synthetic video+audio source
  const testDir = path.join(__dirname, '../scratch/recording-test');
  fs.mkdirSync(testDir, { recursive: true });
  const outputFile = path.join(testDir, 'test-recording.mkv');

  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

  console.log('Generating real 3-second test recording via FFmpeg...');
  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x480:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
      '-c:v', 'vp8',
      '-c:a', 'libopus',
      '-f', 'matroska',
      '-y',
      outputFile
    ]);

    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });

  if (fs.existsSync(outputFile)) {
    const stat = fs.statSync(outputFile);
    results.fileCreated = true;
    results.fileSizeBytes = stat.size;
    console.log(`Output recording file created: ${stat.size} bytes`);
  }

  // 3. Inspect recording with ffprobe
  const probe = await new Promise(resolve => {
    execFile(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration,format_name:stream=codec_type',
      '-of', 'json',
      outputFile
    ], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        const parsed = JSON.parse(stdout);
        const durSec = parseFloat(parsed.format?.duration ?? '0');
        const hasVideo = parsed.streams?.some(s => s.codec_type === 'video') ?? false;
        const hasAudio = parsed.streams?.some(s => s.codec_type === 'audio') ?? false;
        resolve({ durationMs: Math.round(durSec * 1000), hasVideo, hasAudio });
      } catch {
        resolve(null);
      }
    });
  });

  if (probe) {
    results.ffprobeInspected = true;
    results.durationMs = probe.durationMs;
    results.hasVideo = probe.hasVideo;
    results.hasAudio = probe.hasAudio;
    console.log(`FFprobe results: durationMs=${probe.durationMs}, video=${probe.hasVideo}, audio=${probe.hasAudio}`);
  }

  // 4. SHA-256 Digest Computation
  const fileBuffer = fs.readFileSync(outputFile);
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  results.sha256Digest = hash;
  console.log(`SHA-256 Digest: ${hash}`);

  // 5. Verification against Storage abstraction rules
  const apiReq = createRequire(path.join(process.cwd(), 'services/api/package.json'));
  const { LocalRecordingStorage } = apiReq('./dist/src/recordings/storage');
  const storageRoot = path.join(testDir, 'storage');
  const storage = new LocalRecordingStorage(storageRoot);

  const storageKey = 'org-a/recordings/rec-123/combined';
  await storage.putObject(storageKey, fileBuffer);

  const meta = await storage.verify(storageKey, { sizeBytes: results.fileSizeBytes, checksumSha256: hash });
  if (meta && meta.sizeBytes === results.fileSizeBytes && meta.checksumSha256 === hash) {
    results.storageVerified = true;
    console.log('Storage verify succeeded with exact size & SHA-256 match!');
  }

  // 6. Verification of failure modes (checksum mismatch & missing object)
  try {
    await storage.verify(storageKey, { sizeBytes: results.fileSizeBytes, checksumSha256: '0000000000000000000000000000000000000000000000000000000000000000' });
  } catch (err) {
    if (err.name === 'StorageIntegrityError') {
      results.checksumMismatchHandling = true;
      console.log('Checksum mismatch failure correctly handled with StorageIntegrityError!');
    }
  }

  try {
    await storage.verify('org-a/recordings/non-existent/combined', { sizeBytes: 100 });
  } catch (err) {
    if (err.name === 'StorageObjectNotFoundError') {
      results.missingObjectHandling = true;
      console.log('Missing object failure correctly handled with StorageObjectNotFoundError!');
    }
  }

  // 7. Deletion test
  await storage.deleteObject(storageKey);
  const exists = await storage.exists(storageKey);
  if (!exists) {
    results.deletionHandled = true;
    console.log('Deletion verified: object removed from storage root');
  }

  // Clean up scratch files
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log('=== VERIFICATION JSON OUTPUT ===');
  console.log(JSON.stringify(results, null, 2));
}

runRecordingPipelineAudit().catch(err => {
  console.error('Audit script failed:', err);
  process.exit(1);
});
