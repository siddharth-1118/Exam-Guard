import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { AttemptsService } from './attempts.service';
import { RegradeAttemptDto, SaveAnswerDto, StartAttemptDto } from './dto';

@Controller('api/v1/attempts')
export class AttemptsController {
  constructor(private readonly attempts: AttemptsService) {}

  @Post()
  @RequirePermissions('attempt:start')
  start(@CurrentUser() user: UserContext, @Body() dto: StartAttemptDto) {
    return this.attempts.start(user, dto);
  }

  @Get(':id')
  @RequirePermissions('attempt:read')
  get(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.attempts.getAttempt(user, id);
  }

  @Post(':id/answers')
  @RequirePermissions('attempt:submit')
  saveAnswer(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: SaveAnswerDto) {
    return this.attempts.saveAnswer(user, id, dto);
  }

  @Post(':id/heartbeat')
  @RequirePermissions('attempt:submit')
  heartbeat(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.attempts.heartbeat(user, id);
  }

  @Post(':id/submit')
  @RequirePermissions('attempt:submit')
  submit(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.attempts.submit(user, id);
  }

  @Post(':id/regrade')
  @RequirePermissions('attempt:grade')
  regrade(
    @CurrentUser() user: UserContext,
    @Param('id') id: string,
    @Body() dto: RegradeAttemptDto,
  ) {
    return this.attempts.regrade(user, id, dto);
  }
}