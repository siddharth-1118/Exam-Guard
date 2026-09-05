import { Body, Controller, Delete, Get, Param, Post, Query, StreamableFile } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { RecordingsService } from './recordings.service';
import { CreateRecordingDto, FinalizeRecordingDto, ListRecordingsQuery } from './dto';

/**
 * Recording & Evidence API (Phase 5). All routes are permission-gated:
 *  - recording:manage (org admin / super admin) — lifecycle (create/start/
 *    finalize/fail/delete). These are server/egress-facing operations.
 *  - recording:read (org admin, exam manager, monitor, student) — metadata
 *    and download, with per-role visibility enforced inside the service.
 */
@Controller('api/v1/recordings')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  /** Open a recording session for an attempt (PENDING). */
  @Post()
  @RequirePermissions('recording:manage')
  create(@CurrentUser() user: UserContext, @Body() dto: CreateRecordingDto) {
    return this.recordings.create(user, dto);
  }

  /** PENDING → RECORDING. */
  @Post(':id/start')
  @RequirePermissions('recording:manage')
  start(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.recordings.start(user, id);
  }

  /** RECORDING → FINALIZING → READY (storage verification required). */
  @Post(':id/finalize')
  @RequirePermissions('recording:manage')
  finalize(
    @CurrentUser() user: UserContext,
    @Param('id') id: string,
    @Body() dto: FinalizeRecordingDto,
  ) {
    return this.recordings.finalize(user, id, dto);
  }

  /** Org-scoped listing with per-role visibility. */
  @Get()
  @RequirePermissions('recording:read')
  list(@CurrentUser() user: UserContext, @Query() query: ListRecordingsQuery) {
    return this.recordings.list(user, query);
  }

  /**
   * Authorized download: streams the object (local driver) or returns a
   * short-lived presigned URL (S3 driver). Every access is audited.
   */
  @Get(':id/download')
  @RequirePermissions('recording:read')
  async download(@CurrentUser() user: UserContext, @Param('id') id: string) {
    const result = await this.recordings.download(user, id);
    if (result.url) {
      return { url: result.url, expiresInSeconds: 300, kind: result.recording.kind };
    }
    return new StreamableFile(result.stream as never, {
      type: result.contentType,
      disposition: `attachment; filename="recording-${id}.webm"`,
    });
  }

  /** Metadata lookup (tenant + ownership isolated). */
  @Get(':id')
  @RequirePermissions('recording:read')
  get(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.recordings.getById(user, id);
  }

  /** Explicit deletion (retention-aware; never deletes active-attempt evidence). */
  @Delete(':id')
  @RequirePermissions('recording:manage')
  remove(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.recordings.remove(user, id);
  }
}