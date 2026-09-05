/**
 * GDPR Data Export & Controller (C38).
 *
 * Implements the right to data export (Art. 20) and right to erasure (Art. 17)
 * for student accounts. Every operation is authorization-gated and audited.
 */
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { PrivacyService } from './privacy.service';
import { RequestDeletionDto } from './dto';

@Controller('api/v1/privacy')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /**
   * GET /privacy/export/:studentId — Export all personal data for a student.
   * Students can export their own data; admins can export any student in their org.
   */
  @Get('export/:studentId')
  @RequirePermissions('privacy:export')
  async exportData(
    @CurrentUser() user: UserContext,
    @Param('studentId') studentId: string,
  ) {
    return this.privacy.exportStudentData(user, studentId);
  }

  /**
   * POST /privacy/delete/:studentId — Request account/data deletion.
   * Performs anonymization (preserves audit logs for legal compliance).
   * Students can delete their own account; admins can delete in their org.
   */
  @Post('delete/:studentId')
  @RequirePermissions('privacy:delete')
  async requestDeletion(
    @CurrentUser() user: UserContext,
    @Param('studentId') studentId: string,
    @Body() dto: RequestDeletionDto,
  ) {
    return this.privacy.requestDeletion(user, studentId, dto.reason);
  }
}
