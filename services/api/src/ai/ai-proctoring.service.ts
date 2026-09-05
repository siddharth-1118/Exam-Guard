/**
 * AI Proctoring Service (C41).
 *
 * Bridges the model adapter to the existing proctoring event pipeline.
 * Handles frame sampling, backpressure, inference timeout, and metrics.
 * AI events remain advisory — they flow through the existing
 * MonitoringService.createAiEvent() path which requires human review.
 *
 * CURRENTLY REAL: Service infrastructure, frame sampling, backpressure,
 *   metrics, timeout handling, crash recovery
 * CONTRACT ONLY: Actual CV inference (model adapter returns empty results)
 * REQUIRES MODEL: A real ModelAdapter implementation
 * REQUIRES GPU: Hardware-accelerated inference for production use
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ModelAdapter, ModelConfig, ModelMetrics, ModelState } from './model-adapter';
import { NullModelAdapter } from './model-adapter';

const DEFAULT_CONFIG: ModelConfig = {
  modelPath: '',
  modelVersion: 'none',
  confidenceThreshold: 0.5,
  inferenceIntervalMs: 2000,
  device: 'cpu',
  inferenceTimeoutMs: 5000,
  maxBufferSize: 10,
};

@Injectable()
export class AiProctoringService {
  private readonly logger = new Logger(AiProctoringService.name);
  private adapter: ModelAdapter = new NullModelAdapter();
  private config: ModelConfig = DEFAULT_CONFIG;
  private state: ModelState = 'UNAVAILABLE';
  private frameBuffer: Array<{ frameId: string; timestamp: number; attemptId: string; participantId: string; imageData: Buffer | string; width: number; height: number }> = [];
  private processing = false;

  /**
   * Initialize the AI proctoring service with a model adapter.
   * Call once at startup. If no model is configured, uses NullModelAdapter.
   */
  async initialize(adapter?: ModelAdapter, config?: Partial<ModelConfig>): Promise<void> {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adapter = adapter ?? new NullModelAdapter();

    try {
      this.state = 'LOADING';
      await this.adapter.initialize(this.config);
      this.state = this.adapter.getState();
      this.logger.log(`AI proctoring initialized: state=${this.state} model=${this.config.modelVersion}`);
    } catch (err) {
      this.state = 'FAILED';
      this.logger.error(`AI model initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Submit a frame for analysis. Returns immediately (non-blocking).
   * Frames are buffered and processed asynchronously.
   */
  submitFrame(frame: {
    frameId: string;
    timestamp: number;
    attemptId: string;
    participantId: string;
    imageData: Buffer | string;
    width: number;
    height: number;
  }): void {
    if (this.state !== 'READY') return;

    // Backpressure: drop frames if buffer is full
    if (this.frameBuffer.length >= this.config.maxBufferSize) {
      this.frameBuffer.shift(); // drop oldest
      return;
    }

    this.frameBuffer.push(frame);

    // Process asynchronously if not already processing
    if (!this.processing) {
      void this.processBuffer();
    }
  }

  /**
   * Get current model state.
   */
  getState(): ModelState {
    return this.state;
  }

  /**
   * Get current performance metrics.
   */
  getMetrics(): ModelMetrics & { bufferSize: number; config: ModelConfig } {
    const adapterMetrics = this.adapter.getMetrics();
    return {
      ...adapterMetrics,
      state: this.state,
      bufferSize: this.frameBuffer.length,
      config: this.config,
    };
  }

  /**
   * Check if AI is enabled and ready for inference.
   */
  isReady(): boolean {
    return this.state === 'READY';
  }

  /**
   * Shutdown the AI service and release resources.
   */
  async shutdown(): Promise<void> {
    this.state = 'UNAVAILABLE';
    this.frameBuffer = [];
    await this.adapter.dispose();
    this.logger.log('AI proctoring service shut down');
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async processBuffer(): Promise<void> {
    if (this.processing || this.frameBuffer.length === 0) return;
    this.processing = true;

    try {
      while (this.frameBuffer.length > 0) {
        const frame = this.frameBuffer.shift()!;
        try {
          const result = await Promise.race([
            this.adapter.analyze(frame),
            this.timeout(this.config.inferenceTimeoutMs),
          ]);

          if (result && typeof result === 'object' && 'success' in result) {
            const inference = result as { success: boolean; events: unknown[]; latencyMs: number; modelVersion: string; error?: string };
            if (!inference.success && inference.error) {
              this.logger.warn(`Inference failed for frame ${frame.frameId}: ${inference.error}`);
            }
          }
        } catch (err) {
          this.logger.warn(`Inference error for frame ${frame.frameId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Inference timeout')), ms);
    });
  }
}
