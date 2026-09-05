/**
 * Internal admin controller for recording egress (Phase 5B).
 * Called by the SFU when recording finalization completes or fails.
 * Protected by the shared SFU admin key — NOT user authentication.
 * These routes are never reachable by browsers or media clients.
 */
import { Body, Controller, ForbiddenException, Headers, Post, Param } from '@nestjs/common';
import { Public } from '../common/decorators';
import { AppConfig } from '../common/config';
import { RecordingsService } from './recordings.service';
import { FinalizeRecordingDto } from './dto';

@Controller('api/v1/recordings/admin')
@Public()
export class RecordingAdminController {
  constructor(
    private readonly recordings: RecordingsService,
    private readonly config: AppConfig,
  ) {}

  /**
   * SFU calls this after successfully producing a recording file.
   * Verifies admin key, then finalizes the recording via the service.
   */
  @Post(':id/finalize')
  async adminFinalize(
    @Headers('x-sfu-admin-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: FinalizeRecordingDto,
  ) {
    this.assertAdmin(adminKey);
    return this.recordings.adminFinalize(id, dto);
  }

  /** SFU calls this when recording fails (empty media, storage error, etc.). */
  @Post(':id/fail')
  async adminFail(
    @Headers('x-sfu-admin-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    this.assertAdmin(adminKey);
    return this.recordings.adminFail(id, body.reason ?? 'unknown');
  }

  private assertAdmin(adminKey: string | undefined): void {
    if (adminKey !== this.config.sfuAdminKey) {
      throw new ForbiddenException('Invalid admin key');
    }
  }
}
