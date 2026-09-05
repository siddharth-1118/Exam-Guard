/**
 * Attempt-terminal media cleanup (Phase 4D hardening).
 *
 * When an attempt reaches SUBMITTED / AUTO_SUBMITTED / TERMINATED the API must
 * tear the publisher's realtime resources down SERVER-SIDE — even if the
 * student desktop is gone, crashed, or simply never sends a leave. The attempt
 * services already end the MediaParticipant row (guarded updateMany); this
 * listener makes sure the live planes follow:
 *
 *   1. MediaGateway — closes any live publisher control socket for the attempt
 *      (close 4002, no reconnect-grace rearm), so the client learns at once;
 *   2. SFU — evicts every participant row's room (transports, producers, WS),
 *      idempotent (404 = already gone), so no zombie publisher can keep
 *      sending RTP after the exam ended.
 *
 * Never depends on the Electron client sending a final cleanup request.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MediaGateway } from './media.gateway';
import { MediaService } from './media.service';
import { MediaPresenceService } from './media.presence';

const TERMINAL_CLOSE_CODE = 4002;

interface AttemptEventPayload {
  attemptId?: string;
  auto?: boolean;
  reason?: string;
}

@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger(MediaCleanupService.name);

  constructor(
    private readonly gateway: MediaGateway,
    private readonly media: MediaService,
    private readonly presence: MediaPresenceService,
  ) {}

  @OnEvent('student.submitted', { suppressErrors: true })
  async onSubmitted(payload: AttemptEventPayload): Promise<void> {
    const attemptId = typeof payload?.attemptId === 'string' ? payload.attemptId : null;
    if (!attemptId) return;
    await this.closeAttemptMedia(attemptId, payload?.auto ? 'attempt.auto-submit' : 'attempt.submit');
  }

  @OnEvent('student.terminated', { suppressErrors: true })
  async onTerminated(payload: AttemptEventPayload): Promise<void> {
    const attemptId = typeof payload?.attemptId === 'string' ? payload.attemptId : null;
    if (!attemptId) return;
    await this.closeAttemptMedia(attemptId, 'attempt.terminate');
  }

  private async closeAttemptMedia(attemptId: string, cause: string): Promise<void> {
    // 1. Control plane: close any live publisher socket for this attempt.
    const closed = this.gateway.forceClosePublishersForAttempt(
      attemptId,
      TERMINAL_CLOSE_CODE,
      cause,
    );

    // 2. Media plane: evict every participant row's SFU room (idempotent).
    const rows = await this.media.findParticipantsByAttempt(attemptId);
    let evicted = 0;
    for (const row of rows) {
      const ok = await this.media.evictSfuRoom(row.id, cause);
      if (ok) evicted += 1;
      // 3. Ephemeral presence: remove the Redis key + ownership lease.
      await this.presence.removePresence(row.id, row.organizationId).catch(() => undefined);
    }

    if (closed > 0 || evicted > 0) {
      const orgId = rows[0]?.organizationId ?? '';
      if (orgId) {
        await this.media.auditSystem(orgId, 'media.session.ended', attemptId, {
          cause,
          connectionsClosed: closed,
          sfuRoomsEvicted: evicted,
          participantCount: rows.length,
          serverInitiated: true,
        });
      }
      this.logger.log(
        `attempt ${attemptId.slice(0, 8)} ${cause}: gateway-closed=${closed} sfu-evicted=${evicted}`,
      );
    }
  }
}
