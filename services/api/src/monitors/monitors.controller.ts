import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { MonitorsService } from './monitors.service';
import { CreateMonitorDto } from './dto';

@Controller('api/v1/monitors')
export class MonitorsController {
  constructor(private readonly monitors: MonitorsService) {}

  @Get()
  @RequirePermissions('monitor:read')
  list(@CurrentUser() user: UserContext) {
    return this.monitors.list(user);
  }

  @Post()
  @RequirePermissions('monitor:manage')
  create(@CurrentUser() user: UserContext, @Body() dto: CreateMonitorDto) {
    return this.monitors.create(user, dto);
  }
}