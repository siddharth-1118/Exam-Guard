import { CvDetectionEngine, FrameAnalysisInput } from './detector';

describe('CvDetectionEngine', () => {
  let engine: CvDetectionEngine;

  beforeEach(() => {
    engine = new CvDetectionEngine();
  });

  it('should detect CAMERA_BLOCKED when meanBrightness is low', () => {
    const input: FrameAnalysisInput = {
      attemptId: 'att-1',
      timestampMs: 1000,
      facesDetected: 0,
      meanBrightness: 5,
    };

    const results = engine.analyzeFrame(input);
    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('CAMERA_BLOCKED');
    expect(results[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('should detect FACE_MISSING when 0 faces are present', () => {
    const input: FrameAnalysisInput = {
      attemptId: 'att-1',
      timestampMs: 2000,
      facesDetected: 0,
      meanBrightness: 120,
    };

    const results = engine.analyzeFrame(input);
    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('FACE_MISSING');
  });

  it('should detect MULTIPLE_FACES when >1 faces are present', () => {
    const input: FrameAnalysisInput = {
      attemptId: 'att-1',
      timestampMs: 3000,
      facesDetected: 2,
      meanBrightness: 120,
    };

    const results = engine.analyzeFrame(input);
    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('MULTIPLE_FACES');
  });

  it('should detect LOOKING_AWAY when head yaw angle exceeds 30 degrees', () => {
    const input: FrameAnalysisInput = {
      attemptId: 'att-1',
      timestampMs: 4000,
      facesDetected: 1,
      headYawAngleDeg: 45,
      meanBrightness: 120,
    };

    const results = engine.analyzeFrame(input);
    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('LOOKING_AWAY');
    expect(results[0].confidence).toBeGreaterThan(0.7);
  });

  it('should detect PHONE_DETECTED when YOLO finds a cell phone', () => {
    const input: FrameAnalysisInput = {
      attemptId: 'att-1',
      timestampMs: 5000,
      facesDetected: 1,
      detectedObjects: [{ label: 'cell phone', confidence: 0.88 }],
      meanBrightness: 120,
    };

    const results = engine.analyzeFrame(input);
    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('PHONE_DETECTED');
    expect(results[0].confidence).toBe(0.88);
  });
});
