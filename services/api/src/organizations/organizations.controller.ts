import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { OrganizationsService } from './organizations.service';

class UpdateOrgDto {
  name?: string;
  plan?: string;
  status?: string;
}

@Controller('api/v1/organizations')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  @RequirePermissions('org:read')
  list(@CurrentUser() user: UserContext) {
    return this.orgs.list(user);
  }

  @Post()
  @RequirePermissions('system:manage')
  create(@CurrentUser() user: UserContext, @Body('name') name: string) {
    return this.orgs.create(user, name);
  }

  @Patch(':id')
  @RequirePermissions('org:manage')
  update(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: UpdateOrgDto) {
    return this.orgs.update(user, id, dto);
  }
}