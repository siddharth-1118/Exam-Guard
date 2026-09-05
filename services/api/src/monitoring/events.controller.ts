import { Body, Controller, Param, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { MonitoringService } from './monitoring.service';
import { CreateAiEventDto, CreateProctoringEventDto, ReviewAiEventDto, UpdateMediaSessionDto } from './dto';

/**
 * Event ingest:
 * - /api/v1/proctoring/events  ← student client sensor events (Phase 3 desktop)
 * - /api/v1/ai/events          ← services/ai-proctoring (Phase 5; contract implemented now)
 */
@Controller('api/v1')
export class EventsController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Post('proctoring/events')
  @RequirePermissions('attempt:submit')
  proctoringEvent(@CurrentUser() user: UserContext, @Body() dto: CreateProctoringEventDto) {
    return this.monitoring.createProctoringEvent(user, dto);
  }

  @Post('ai/events')
  @RequirePermissions('proctor:monitor')
  aiEvent(@CurrentUser() user: UserContext, @Body() dto: CreateAiEventDto) {
    return this.monitoring.createAiEvent(user, dto);
  }

  @Post('ai/events/:id/review')
  @RequirePermissions('proctor:intervene')
  review(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: ReviewAiEventDto) {
    return this.monitoring.reviewAiEvent(user, id, dto.status);
  }

  @Post('proctoring/sessions')
  @RequirePermissions('attempt:submit')
  updateMediaSession(@CurrentUser() user: UserContext, @Body() dto: UpdateMediaSessionDto) {
    return this.monitoring.updateMediaSession(user, dto);
  }
}