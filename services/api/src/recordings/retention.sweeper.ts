/**
 * Recording retention sweeper (Phase 5).
 *
 * Periodically checks for recordings whose retention period has expired
 * (retentionUntil <= NOW()) and purges them from object storage and database.
 * Active attempt recordings are strictly protected and never purged.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RecordingStorage } from './storage';

const ACTIVE_ATTEMPT_STATES = ['CREATED', 'READY', 'ACTIVE', 'PAUSED', 'DISCONNECTED'];

@Injectable()
export class RetentionSweeper {
  private readonly logger = new Logger(RetentionSweeper.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: RecordingStorage,
  ) {}

  /**
   * Sweeps expired recordings every hour (or manually triggered).
   */
  @Interval(3600_000)
  async sweepExpiredRecordings(): Promise<{ purged: number; errors: number }> {
    if (process.env.APP_ENV === 'test' || process.env.NODE_ENV === 'test') {
      return { purged: 0, errors: 0 };
    }

    const now = new Date();
    const expiredRecordings = await this.prisma.recording.findMany({
      where: {
        retentionUntil: { lte: now },
        status: { notIn: ['DELETED', 'RECORDING'] },
        attempt: {
          status: { notIn: ACTIVE_ATTEMPT_STATES as never[] },
        },
      },
      take: 100,
    });

    let purged = 0;
    let errors = 0;

    for (const recording of expiredRecordings) {
      try {
        await this.storage.deleteObject(recording.storageKey).catch(() => {});
        await this.prisma.recording.update({
          where: { id: recording.id },
          data: { status: 'DELETED' },
        });

        await this.prisma.auditLog.create({
          data: {
            organizationId: recording.organizationId,
            action: 'recording.retention-deleted',
            resourceType: 'Recording',
            resourceId: recording.id,
            detail: {
              recordingId: recording.id,
              attemptId: recording.attemptId,
              storageKey: recording.storageKey,
              retentionUntil: recording.retentionUntil?.toISOString(),
            },
          },
        });

        purged++;
        this.logger.log(`Purged expired recording ${recording.id.slice(0, 8)}`);
      } catch (err) {
        errors++;
        this.logger.error(
          `Failed to purge expired recording ${recording.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (purged > 0) {
      this.logger.log(`Retention sweep completed: ${purged} recordings purged (${errors} errors)`);
    }

    return { purged, errors };
  }
}
