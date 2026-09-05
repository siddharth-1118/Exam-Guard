import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { ExamsService } from './exams.service';
import {
  AssignMonitorsDto,
  AssignStudentsDto,
  CreateExamDto,
  LinkQuestionsDto,
  UpdateExamDto,
} from './dto';

@Controller('api/v1/exams')
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Post()
  @RequirePermissions('exam:create')
  create(@CurrentUser() user: UserContext, @Body() dto: CreateExamDto) {
    return this.exams.create(user, dto);
  }

  @Get()
  @RequirePermissions('exam:read')
  list(@CurrentUser() user: UserContext) {
    return this.exams.list(user);
  }

  @Get(':id')
  @RequirePermissions('exam:read')
  findOne(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.exams.findOne(user, id);
  }

  @Patch(':id')
  @RequirePermissions('exam:update')
  update(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: UpdateExamDto) {
    return this.exams.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('exam:delete')
  remove(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.exams.remove(user, id);
  }

  @Post(':id/questions')
  @RequirePermissions('question:manage')
  linkQuestions(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: LinkQuestionsDto) {
    return this.exams.linkQuestions(user, id, dto);
  }

  @Post(':id/students')
  @RequirePermissions('exam:assign')
  assignStudents(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: AssignStudentsDto) {
    return this.exams.assignStudents(user, id, dto);
  }

  @Post(':id/monitors')
  @RequirePermissions('exam:assign')
  assignMonitors(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: AssignMonitorsDto) {
    return this.exams.assignMonitors(user, id, dto);
  }

  @Patch(':id/settings')
  @RequirePermissions('exam:update')
  updateSettings(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: UpdateExamDto) {
    return this.exams.update(user, id, dto);
  }

  @Get(':id/results')
  @RequirePermissions('report:read')
  results(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.exams.results(user, id);
  }

  @Get(':id/proctoring')
  @RequirePermissions('proctor:monitor')
  proctoring(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.exams.proctoringSummary(user, id);
  }

  @Post(':id/start')
  @RequirePermissions('exam:update')
  start(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.exams.changeStatus(user, id, 'OPEN');
  }

  @Post(':id/end')
  @RequirePermissions('exam:update')
  end(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.exams.changeStatus(user, id, 'CLOSED');
  }
}