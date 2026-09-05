import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { MediaService } from './media.service';
import { MediaGateway } from './media.gateway';
import { MediaSweeperService } from './media.sweeper';
import { MediaPresenceService } from './media.presence';
import { CreateMediaSessionDto, ListExamSessionsQuery, SubscriberTokenDto } from './dto';

@Controller('api/v1/media/sessions')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly gateway: MediaGateway,
    private readonly sweeper: MediaSweeperService,
    private readonly presence: MediaPresenceService,
  ) {}

  /**
   * Dev diagnostics (Phase 4D): realtime resource + sweeper state. Metadata
   * only — counts and lifecycle state, never media or credentials. Readable
   * by org admins / super admins (audit:read). Declared before ':id'.
   */
  @Get('diagnostics')
  @RequirePermissions('audit:read')
  diagnostics() {
    return {
      gateway: this.gateway.stats,
      sweeper: this.sweeper.getStatus(),
      presence: this.presence.status(),
    };
  }

  /** Student: create-or-reuse the publisher session for their OWN active attempt. */
  @Post()
  @RequirePermissions('media:publish')
  create(@CurrentUser() user: UserContext, @Body() dto: CreateMediaSessionDto) {
    return this.media.createForStudent(user, dto.attemptId);
  }

  /** Owner student or authorized monitor/org watcher. */
  @Get(':id')
  @RequirePermissions('attempt:read')
  get(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.media.getById(user, id);
  }

  /** Owner student: idempotent end of their session. */
  @Post(':id/end')
  @RequirePermissions('media:publish')
  end(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.media.endById(user, id);
  }

  /** Monitor: discovery for an exam they are assigned to (metadata only). */
  @Get()
  @RequirePermissions('media:subscribe')
  list(@CurrentUser() user: UserContext, @Query() query: ListExamSessionsQuery) {
    return this.media.listForExam(user, query.examId);
  }
}

/** POST /api/v1/media/token — short-lived SFU publisher credential (Phase 4B). */
@Controller('api/v1/media')
export class MediaTokenController {
  constructor(private readonly media: MediaService) {}

  @Post('token')
  @RequirePermissions('media:publish')
  token(@CurrentUser() user: UserContext, @Body() dto: CreateMediaSessionDto) {
    return this.media.issuePublisherToken(user, dto.attemptId);
  }

  /** Monitor: short-lived subscriber credential (Phase 4C). */
  @Post('subscriber-token')
  @RequirePermissions('media:subscribe')
  subscriberToken(@CurrentUser() user: UserContext, @Body() dto: SubscriberTokenDto) {
    return this.media.issueSubscriberToken(user, dto);
  }
}
