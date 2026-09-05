/**
 * AI Model Adapter Boundary (C41).
 *
 * This module defines the clean interface between ExamGuard's proctoring
 * infrastructure and a real computer-vision model. It is NOT an inference
 * implementation — it is the contract that a real model must satisfy.
 *
 * CURRENTLY REAL: Interface/contract only
 * CONACT ONLY: All methods below
 * REQUIRES MODEL: Actual CV inference (face detection, phone detection, etc.)
 * REQUIRES GPU: Hardware-accelerated inference for production use
 *
 * The adapter must remain advisory — AI events are PENDING until human review.
 * AI cannot directly terminate an exam.
 */

/**
 * A single frame analyzed by the model.
 */
export interface FrameInput {
  /** Unique frame identifier for tracking. */
  frameId: string;
  /** Timestamp when the frame was captured (ms since epoch). */
  timestamp: number;
  /** The attempt this frame belongs to. */
  attemptId: string;
  /** The participant (student) this frame is from. */
  participantId: string;
  /** Raw image data (Buffer or base64). The adapter decides the format. */
  imageData: Buffer | string;
  /** Width of the frame in pixels. */
  width: number;
  /** Height of the frame in pixels. */
  height: number;
}

/**
 * A single detection event from the model.
 */
export interface DetectionEvent {
  /** Event type matching the AiEventType enum. */
  eventType: string;
  /** Confidence score between 0.0 and 1.0. */
  confidence: number;
  /** Optional bounding box or region of interest. */
  region?: { x: number; y: number; width: number; height: number };
  /** Optional reference to stored evidence (screenshot/clip). */
  evidenceRef?: string;
}

/**
 * Result of analyzing a single frame.
 */
export interface InferenceResult {
  /** Whether the model successfully analyzed the frame. */
  success: boolean;
  /** Detection events (empty array if nothing detected). */
  events: DetectionEvent[];
  /** Inference latency in milliseconds. */
  latencyMs: number;
  /** Model version that produced this result. */
  modelVersion: string;
  /** Error message if success is false. */
  error?: string;
}

/**
 * Model lifecycle states.
 */
export type ModelState = 'LOADING' | 'READY' | 'FAILED' | 'UNAVAILABLE';

/**
 * Model configuration.
 */
export interface ModelConfig {
  /** Path to the model file (ONNX, TensorFlow, etc.). */
  modelPath: string;
  /** Model version string. */
  modelVersion: string;
  /** Minimum confidence threshold for reporting events. */
  confidenceThreshold: number;
  /** Maximum inference interval between frames (ms). */
  inferenceIntervalMs: number;
  /** Device to run inference on: 'cpu', 'gpu', or 'auto'. */
  device: 'cpu' | 'gpu' | 'auto';
  /** Timeout for a single inference call (ms). */
  inferenceTimeoutMs: number;
  /** Maximum number of frames to buffer before dropping. */
  maxBufferSize: number;
}

/**
 * Model performance metrics.
 */
export interface ModelMetrics {
  /** Current model state. */
  state: ModelState;
  /** Total frames processed. */
  framesProcessed: number;
  /** Frames dropped due to backpressure. */
  framesDropped: number;
  /** Total inference latency (ms). */
  totalLatencyMs: number;
  /** Average inference latency (ms). */
  averageLatencyMs: number;
  /** Number of inference errors. */
  errorCount: number;
  /** Last error message, if any. */
  lastError: string | null;
  /** Timestamp of last successful inference. */
  lastInferenceAt: string | null;
}

/**
 * The model adapter interface that a real CV model must implement.
 *
 * Example implementations:
 * - ONNX Runtime adapter (face detection, phone detection)
 * - TensorFlow.js adapter (browser-based inference)
 * - External API adapter (cloud vision services)
 *
 * The adapter is stateless with respect to exam state — it only
 * processes frames and returns detections. The proctoring service
 * handles risk scoring, alert generation, and human review.
 */
export interface ModelAdapter {
  /** Initialize the model (load weights, warm up). */
  initialize(config: ModelConfig): Promise<void>;

  /** Get current model state. */
  getState(): ModelState;

  /** Analyze a single frame and return detections. */
  analyze(frame: FrameInput): Promise<InferenceResult>;

  /** Get current performance metrics. */
  getMetrics(): ModelMetrics;

  /** Release model resources (called on shutdown). */
  dispose(): Promise<void>;
}

/**
 * No-op adapter used when AI is disabled or no model is available.
 * Returns empty detections — no false positives, no crashes.
 */
export class NullModelAdapter implements ModelAdapter {
  private state: ModelState = 'UNAVAILABLE';
  private metrics: ModelMetrics = {
    state: 'UNAVAILABLE',
    framesProcessed: 0,
    framesDropped: 0,
    totalLatencyMs: 0,
    averageLatencyMs: 0,
    errorCount: 0,
    lastError: null,
    lastInferenceAt: null,
  };

  async initialize(_config: ModelConfig): Promise<void> {
    this.state = 'UNAVAILABLE';
    this.metrics.state = 'UNAVAILABLE';
  }

  getState(): ModelState {
    return this.state;
  }

  async analyze(frame: FrameInput): Promise<InferenceResult> {
    this.metrics.framesProcessed++;
    return {
      success: true,
      events: [],
      latencyMs: 0,
      modelVersion: 'null',
    };
  }

  getMetrics(): ModelMetrics {
    return { ...this.metrics };
  }

  async dispose(): Promise<void> {
    this.state = 'UNAVAILABLE';
  }
}
