import { LocalOnnxModelAdapter } from './model-adapter';
import type { FrameAnalysisInput } from './detector';

describe('Checkpoint 68 — Real AI Proctoring Model Integration', () => {
  let adapter: LocalOnnxModelAdapter;

  beforeEach(() => {
    adapter = new LocalOnnxModelAdapter();
  });

  it('loads model and transitions to ready status', async () => {
    expect(adapter.getStatus()).toBe('uninitialized');
    const ok = await adapter.load();
    expect(ok).toBe(true);
    expect(adapter.getStatus()).toBe('ready');
    expect(adapter.getMetadata().name).toContain('ONNX');
  });

  it('detects PHONE_DETECTED from frame object detections', async () => {
    await adapter.load();
    const frame: FrameAnalysisInput = {
      attemptId: 'att-1',
      timestampMs: 1000,
      facesDetected: 1,
      detectedObjects: [{ label: 'cell phone', confidence: 0.88 }],
    };

    const results = await adapter.infer(frame);
    expect(results.length).toBe(1);
    expect(results[0].eventType).toBe('PHONE_DETECTED');
    expect(results[0].confidence).toBe(0.88);
  });

  it('detects MULTIPLE_FACES when face count > 1', async () => {
    await adapter.load();
    const frame: FrameAnalysisInput = {
      attemptId: 'att-1',
      timestampMs: 2000,
      facesDetected: 2,
    };

    const results = await adapter.infer(frame);
    expect(results.some((r) => r.eventType === 'MULTIPLE_FACES')).toBe(true);
  });

  it('detects LOOKING_AWAY when head yaw angle exceeds 30 degrees', async () => {
    await adapter.load();
    const frame: FrameAnalysisInput = {
      attemptId: 'att-1',
      timestampMs: 3000,
      facesDetected: 1,
      headYawAngleDeg: 35,
    };

    const results = await adapter.infer(frame);
    expect(results.some((r) => r.eventType === 'LOOKING_AWAY')).toBe(true);
  });

  it('filters out low-confidence object detections below 0.5', async () => {
    await adapter.load();
    const frame: FrameAnalysisInput = {
      attemptId: 'att-1',
      timestampMs: 4000,
      facesDetected: 1,
      detectedObjects: [{ label: 'book', confidence: 0.35 }],
    };

    const results = await adapter.infer(frame);
    expect(results.length).toBe(0);
  });

  it('returns empty results gracefully when uninitialized or unloaded', async () => {
    const frame: FrameAnalysisInput = {
      attemptId: 'att-1',
      timestampMs: 5000,
      facesDetected: 0,
    };

    const results = await adapter.infer(frame);
    expect(results.length).toBe(0);
  });

  it('tracks load time and inference performance metrics', async () => {
    await adapter.load();
    await adapter.infer({ attemptId: 'att-1', timestampMs: 1, facesDetected: 1 });
    await adapter.infer({ attemptId: 'att-1', timestampMs: 2, facesDetected: 1 });

    const metrics = adapter.getMetrics();
    expect(metrics.inferenceCount).toBe(2);
    expect(metrics.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
