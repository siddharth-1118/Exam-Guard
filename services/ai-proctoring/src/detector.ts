/**
 * ExamGuard Computer Vision Detection Engine (Phase 5).
 *
 * Processes sampled video frames and extracts suspicious behavioral / object
 * indicators:
 *  - Face missing / multiple faces / second person
 *  - Unauthorized objects (phone, book, paper)
 *  - Head pose / looking away
 *  - Camera blocked / static frame
 *
 * Emits calibrated AiEvent payloads without making autonomous pass/fail verdicts.
 */

export type AiEventType =
  | 'FACE_MISSING'
  | 'MULTIPLE_FACES'
  | 'PHONE_DETECTED'
  | 'BOOK_DETECTED'
  | 'PAPER_DETECTED'
  | 'SECOND_PERSON'
  | 'CAMERA_BLOCKED'
  | 'LOOKING_AWAY'
  | 'UNAUTHORIZED_OBJECT'
  | 'ENVIRONMENT_CHANGE'
  | 'FACE_PARTIALLY_VISIBLE';

export interface FrameAnalysisInput {
  attemptId: string;
  timestampMs: number;
  facesDetected: number;
  faceBoundingBox?: { x: number; y: number; width: number; height: number };
  headYawAngleDeg?: number; // >30 deg = looking away
  detectedObjects?: Array<{ label: string; confidence: number }>;
  meanBrightness?: number; // <10 = camera blocked
}

export interface DetectionResult {
  attemptId: string;
  eventType: AiEventType;
  confidence: number;
  evidenceRef?: string;
  modelVersion: string;
  detectedAt: string;
}

export class CvDetectionEngine {
  private readonly modelVersion = 'onnx-cv-v1.2';

  /**
   * Analyzes a single frame input and returns any triggered AI events.
   */
  analyzeFrame(input: FrameAnalysisInput): DetectionResult[] {
    const results: DetectionResult[] = [];
    const nowIso = new Date().toISOString();

    // 1. Camera blocked detection
    if (input.meanBrightness !== undefined && input.meanBrightness < 10) {
      results.push({
        attemptId: input.attemptId,
        eventType: 'CAMERA_BLOCKED',
        confidence: 0.95,
        evidenceRef: `frame_${input.timestampMs}_blocked`,
        modelVersion: this.modelVersion,
        detectedAt: nowIso,
      });
      return results; // no face analysis when camera is blocked
    }

    // 2. Face count analysis
    if (input.facesDetected === 0) {
      results.push({
        attemptId: input.attemptId,
        eventType: 'FACE_MISSING',
        confidence: 0.92,
        evidenceRef: `frame_${input.timestampMs}_noface`,
        modelVersion: this.modelVersion,
        detectedAt: nowIso,
      });
    } else if (input.facesDetected > 1) {
      results.push({
        attemptId: input.attemptId,
        eventType: 'MULTIPLE_FACES',
        confidence: Math.min(0.99, 0.85 + (input.facesDetected - 2) * 0.05),
        evidenceRef: `frame_${input.timestampMs}_multiface`,
        modelVersion: this.modelVersion,
        detectedAt: nowIso,
      });
    }

    // 3. Head pose / looking away analysis
    if (input.headYawAngleDeg !== undefined && Math.abs(input.headYawAngleDeg) > 30) {
      const confidence = Math.min(0.98, 0.70 + (Math.abs(input.headYawAngleDeg) - 30) * 0.008);
      results.push({
        attemptId: input.attemptId,
        eventType: 'LOOKING_AWAY',
        confidence: Number(confidence.toFixed(2)),
        evidenceRef: `frame_${input.timestampMs}_gaze`,
        modelVersion: this.modelVersion,
        detectedAt: nowIso,
      });
    }

    // 4. Object detection (YOLO objects)
    if (input.detectedObjects) {
      for (const obj of input.detectedObjects) {
        let eventType: AiEventType | null = null;

        if (obj.label === 'cell phone' || obj.label === 'phone') {
          eventType = 'PHONE_DETECTED';
        } else if (obj.label === 'book') {
          eventType = 'BOOK_DETECTED';
        } else if (obj.label === 'paper' || obj.label === 'document') {
          eventType = 'PAPER_DETECTED';
        } else if (obj.label === 'person' && input.facesDetected > 1) {
          eventType = 'SECOND_PERSON';
        } else if (obj.label === 'laptop' || obj.label === 'tablet') {
          eventType = 'UNAUTHORIZED_OBJECT';
        }

        if (eventType && obj.confidence >= 0.5) {
          results.push({
            attemptId: input.attemptId,
            eventType,
            confidence: Number(obj.confidence.toFixed(2)),
            evidenceRef: `frame_${input.timestampMs}_${obj.label}`,
            modelVersion: this.modelVersion,
            detectedAt: nowIso,
          });
        }
      }
    }

    return results;
  }
}
