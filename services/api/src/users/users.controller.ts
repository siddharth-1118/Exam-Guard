import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermissions, CurrentUser } from '../common/decorators';
import type { UserContext } from '../common/types';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto } from './dto';

@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('user:read')
  list(@CurrentUser() user: UserContext) {
    return this.users.list(user);
  }

  @Post()
  @RequirePermissions('user:manage')
  create(@CurrentUser() user: UserContext, @Body() dto: CreateUserDto) {
    return this.users.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions('user:manage')
  update(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(user, id, dto);
  }
}