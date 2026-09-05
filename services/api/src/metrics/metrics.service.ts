/**
 * Prometheus-compatible Metrics Service (C50).
 *
 * Exposes application metrics in Prometheus exposition format.
 * Labels are bounded and never include high-cardinality values
 * (no studentId, email, IP, recordingId, or attemptId as labels).
 */
import { Injectable } from '@nestjs/common';

interface Metric {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  value: number;
  labels?: Record<string, string>;
}

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();

  // ---- Counter methods ----

  incCounter(name: string, labels?: Record<string, string>): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  // ---- Gauge methods ----

  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.key(name, labels);
    this.gauges.set(key, value);
  }

  // ---- Histogram methods ----

  observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.key(name, labels);
    const values = this.histograms.get(key) ?? [];
    values.push(value);
    this.histograms.set(key, values);
  }

  // ---- Prometheus exposition format ----

  /**
   * Returns metrics in Prometheus exposition format.
   * See: https://prometheus.io/docs/instrumenting/exposition_formats/
   */
  serialize(): string {
    const lines: string[] = [];

    // Counters
    for (const [key, value] of this.counters) {
      const { name, labels } = this.parseKey(key);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name}${this.formatLabels(labels)} ${value}`);
    }

    // Gauges
    for (const [key, value] of this.gauges) {
      const { name, labels } = this.parseKey(key);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${this.formatLabels(labels)} ${value}`);
    }

    // Histograms
    for (const [key, values] of this.histograms) {
      const { name, labels } = this.parseKey(key);
      lines.push(`# TYPE ${name} histogram`);
      const sorted = [...values].sort((a, b) => a - b);
      const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
      let cumulative = 0;
      for (const bucket of buckets) {
        cumulative += sorted.filter((v) => v <= bucket).length;
        const bucketLabels = { ...labels, le: String(bucket) };
        lines.push(`${name}_bucket${this.formatLabels(bucketLabels)} ${cumulative}`);
      }
      cumulative += sorted.filter((v) => v > buckets[buckets.length - 1]).length;
      lines.push(`${name}_bucket${this.formatLabels({ ...labels, le: '+Inf' })} ${cumulative}`);
      const sum = values.reduce((a, b) => a + b, 0);
      lines.push(`${name}_sum${this.formatLabels(labels)} ${sum}`);
      lines.push(`${name}_count${this.formatLabels(labels)} ${values.length}`);
    }

    return lines.join('\n') + '\n';
  }

  // ---- Convenience: pre-defined ExamGuard metrics ----

  recordRequest(method: string, route: string, statusCode: number): void {
    this.incCounter('examguard_http_requests_total', {
      method,
      route: this.normalizeRoute(route),
      status: String(statusCode),
    });
  }

  recordRequestDuration(method: string, route: string, durationMs: number): void {
    this.observeHistogram('examguard_http_request_duration_seconds', durationMs / 1000, {
      method,
      route: this.normalizeRoute(route),
    });
  }

  setActiveAttempts(count: number): void {
    this.setGauge('examguard_attempts_active', count);
  }

  setMediaParticipants(count: number): void {
    this.setGauge('examguard_media_participants', count);
  }

  setRedisHealth(healthy: boolean): void {
    this.setGauge('examguard_redis_health', healthy ? 1 : 0);
  }

  recordAuthFailure(): void {
    this.incCounter('examguard_auth_failures_total');
  }

  recordMfaFailure(): void {
    this.incCounter('examguard_mfa_failures_total');
  }

  recordRecordingStarted(): void {
    this.incCounter('examguard_recordings_started_total');
  }

  recordRecordingFailed(): void {
    this.incCounter('examguard_recordings_failed_total');
  }

  observeRecordingFinalizeDuration(durationMs: number): void {
    this.observeHistogram('examguard_recording_finalize_seconds', durationMs / 1000);
  }

  setRecordingsActive(count: number): void {
    this.setGauge('examguard_recordings_active', count);
  }

  recordMediaReconnect(): void {
    this.incCounter('examguard_media_reconnects_total');
  }

  recordMediaDisconnect(): void {
    this.incCounter('examguard_media_disconnects_total');
  }

  setMediaProducers(count: number): void {
    this.setGauge('examguard_media_producers', count);
  }

  setMediaConsumers(count: number): void {
    this.setGauge('examguard_media_consumers', count);
  }

  recordSubmission(): void {
    this.incCounter('examguard_submissions_total');
  }

  recordAutoSubmission(): void {
    this.incCounter('examguard_auto_submissions_total');
  }

  recordRateLimited(): void {
    this.incCounter('examguard_rate_limited_total');
  }

  recordInferenceCount(): void {
    this.incCounter('examguard_ai_inference_total');
  }

  recordInferenceFailure(): void {
    this.incCounter('examguard_ai_inference_failures_total');
  }

  observeInferenceLatency(durationMs: number): void {
    this.observeHistogram('examguard_ai_inference_latency_seconds', durationMs / 1000);
  }

  // ---- Internal helpers ----

  private key(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return `${name}|${sorted.map(([k, v]) => `${k}=${v}`).join(',')}`;
  }

  private parseKey(key: string): { name: string; labels: Record<string, string> } {
    const pipeIdx = key.indexOf('|');
    if (pipeIdx === -1) return { name: key, labels: {} };
    const name = key.slice(0, pipeIdx);
    const labelStr = key.slice(pipeIdx + 1);
    const labels: Record<string, string> = {};
    for (const pair of labelStr.split(',')) {
      const eqIdx = pair.indexOf('=');
      labels[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
    return { name, labels };
  }

  private formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    const sorted = entries.sort(([a], [b]) => a.localeCompare(b));
    return `{${sorted.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  }

  private normalizeRoute(route: string): string {
    // Normalize parameterized routes to prevent high-cardinality labels
    return route
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
      .replace(/\/\d+/g, '/:id');
  }
}
