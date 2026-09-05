import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { StudentsService } from './students.service';
import { BulkImportStudentsDto, CreateStudentDto, UpdateStudentDto } from './dto';

@Controller('api/v1/students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  @RequirePermissions('student:read')
  list(@CurrentUser() user: UserContext) {
    return this.students.list(user);
  }

  @Post()
  @RequirePermissions('student:manage')
  create(@CurrentUser() user: UserContext, @Body() dto: CreateStudentDto) {
    return this.students.create(user, dto);
  }

  @Post('import')
  @RequirePermissions('student:manage')
  bulkImport(@CurrentUser() user: UserContext, @Body() dto: BulkImportStudentsDto) {
    return this.students.bulkImport(user, dto.students);
  }

  @Patch(':id')
  @RequirePermissions('student:manage')
  update(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: UpdateStudentDto) {
    return this.students.update(user, id, dto);
  }
}