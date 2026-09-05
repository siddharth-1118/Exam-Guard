import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { ReportsService } from './reports.service';

@Controller('api/v1/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  @RequirePermissions('report:read')
  dashboard(@CurrentUser() user: UserContext) {
    return this.reports.dashboard(user);
  }

  @Get('exams/:examId')
  @RequirePermissions('report:read')
  examReport(@CurrentUser() user: UserContext, @Param('examId') examId: string) {
    return this.reports.examReport(user, examId);
  }

  @Get('exams/:examId/questions')
  @RequirePermissions('report:read')
  questionReport(
    @CurrentUser() user: UserContext,
    @Param('examId') examId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.reports.questionReport(user, examId, page ? Number(page) : 1, limit ? Number(limit) : 50);
  }

  @Get('students/:studentId')
  @RequirePermissions('report:read')
  studentReport(@CurrentUser() user: UserContext, @Param('studentId') studentId: string) {
    return this.reports.studentReport(user, studentId);
  }
}