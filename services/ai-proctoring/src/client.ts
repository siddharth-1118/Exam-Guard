/**
 * AI Event Dispatcher Client.
 *
 * Posts detected events to the NestJS API `POST /api/v1/ai/events` endpoint.
 */
import { DetectionResult } from './detector';

export interface AiClientConfig {
  apiUrl: string;
  authToken: string;
}

export class AiEventClient {
  constructor(private readonly config: AiClientConfig) {}

  /**
   * Posts an AI detection event to the API.
   */
  async sendAiEvent(event: DetectionResult): Promise<{ success: boolean; eventId?: string; error?: string }> {
    const url = `${this.config.apiUrl}/api/v1/ai/events`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({
          attemptId: event.attemptId,
          eventType: event.eventType,
          confidence: event.confidence,
          evidenceRef: event.evidenceRef,
          modelVersion: event.modelVersion,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return { success: false, error: `API returned ${response.status}: ${errorText}` };
      }

      const data = (await response.json()) as { id?: string };
      return { success: true, eventId: data.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Batch posts multiple detection events.
   */
  async sendBatch(events: DetectionResult[]): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    for (const event of events) {
      const res = await this.sendAiEvent(event);
      if (res.success) sent++;
      else failed++;
    }

    return { sent, failed };
  }
}
