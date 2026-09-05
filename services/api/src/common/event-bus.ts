import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  AiAlertPayload,
  MonitorActionPayload,
  RealtimeEvent,
  RealtimeEventName,
  StudentPausedPayload,
} from '@examguard/types';

/**
 * Transport-agnostic event bus (spec §34 contract).
 * In-process today (EventEmitter2). services/realtime will bind the same
 * interface to WebSockets + Redis pub/sub in Phase 4 without changing call sites.
 */
@Injectable()
export class EventBus {
  constructor(private readonly emitter: EventEmitter2) {}

  emit<T>(event: RealtimeEventName, payload: T, meta?: Partial<RealtimeEvent>): void {
    const evt: RealtimeEvent<T> = {
      event,
      payload: payload as T,
      emittedAt: new Date().toISOString(),
      ...meta,
    } as RealtimeEvent<T>;
    // Fire and forget; handlers are async-safe by design.
    void this.emitter.emitAsync('realtime', evt).catch((err) => {
      console.error('event bus handler failed', err);
    });
    // Also emit under the concrete event name for easy subscription.
    void this.emitter.emitAsync(event, payload).catch(() => undefined);
  }

  emitStudentPaused(payload: StudentPausedPayload, meta: Pick<RealtimeEvent, 'attemptId' | 'examId' | 'organizationId'>): void {
    this.emit('student.paused', payload, meta);
  }

  emitMonitorAction(payload: MonitorActionPayload, meta: Pick<RealtimeEvent, 'attemptId' | 'examId' | 'organizationId'>): void {
    this.emit('monitor.action', payload, meta);
  }

  emitAiAlert(payload: AiAlertPayload, meta: Pick<RealtimeEvent, 'attemptId' | 'examId' | 'organizationId'>): void {
    this.emit('ai.alert', payload, meta);
  }
}