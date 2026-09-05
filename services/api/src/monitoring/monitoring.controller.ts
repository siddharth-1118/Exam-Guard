import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { MonitoringService } from './monitoring.service';
import {
  FlagStudentDto,
  PauseExamDto,
  ResumeExamDto,
  SendMessageDto,
  TerminateExamDto,
} from './dto';

@Controller('api/v1/monitoring')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('exams')
  @RequirePermissions('proctor:monitor')
  exams(@CurrentUser() user: UserContext) {
    return this.monitoring.listExams(user);
  }

  @Get('exams/:examId/students')
  @RequirePermissions('proctor:monitor')
  examStudents(@CurrentUser() user: UserContext, @Param('examId') examId: string) {
    return this.monitoring.examStudents(user, examId);
  }

  @Get('students/:id')
  @RequirePermissions('proctor:monitor')
  studentDetail(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.monitoring.studentDetail(user, id);
  }

  @Post('students/:id/pause')
  @RequirePermissions('proctor:intervene')
  pause(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: PauseExamDto) {
    return this.monitoring.pause(user, id, dto);
  }

  @Post('students/:id/resume')
  @RequirePermissions('proctor:intervene')
  resume(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: ResumeExamDto) {
    return this.monitoring.resume(user, id, dto);
  }

  @Post('students/:id/terminate')
  @RequirePermissions('proctor:intervene')
  terminate(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: TerminateExamDto) {
    return this.monitoring.terminate(user, id, dto);
  }

  @Post('students/:id/message')
  @RequirePermissions('proctor:intervene')
  message(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: SendMessageDto) {
    return this.monitoring.sendMessage(user, id, dto);
  }

  @Post('students/:id/flag')
  @RequirePermissions('proctor:intervene')
  flag(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: FlagStudentDto) {
    return this.monitoring.flag(user, id, dto);
  }
}