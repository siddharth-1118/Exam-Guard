import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import type { UserContext } from '../common/types';
import { QuestionsService } from './questions.service';
import { CreateBankDto, CreateQuestionDto, UpdateQuestionDto } from './dto';

@Controller('api/v1')
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  // ---- Question bank ----
  @Post('question-bank')
  @RequirePermissions('question:manage')
  createBank(@CurrentUser() user: UserContext, @Body() dto: CreateBankDto) {
    return this.questions.createBank(user, dto.name, dto.description);
  }

  @Get('question-bank')
  @RequirePermissions('question:read')
  listBanks(@CurrentUser() user: UserContext) {
    return this.questions.listBanks(user);
  }

  @Post('question-bank/:bankId/questions')
  @RequirePermissions('question:manage')
  createInBank(@CurrentUser() user: UserContext, @Param('bankId') bankId: string, @Body() dto: CreateQuestionDto) {
    return this.questions.createQuestion(user, dto, bankId);
  }

  @Get('question-bank/:bankId/questions')
  @RequirePermissions('question:read')
  listInBank(@CurrentUser() user: UserContext, @Param('bankId') bankId: string) {
    return this.questions.listQuestions(user, bankId);
  }

  // ---- Standalone questions ----
  @Post('questions')
  @RequirePermissions('question:manage')
  create(@CurrentUser() user: UserContext, @Body() dto: CreateQuestionDto) {
    return this.questions.createQuestion(user, dto);
  }

  @Get('questions')
  @RequirePermissions('question:read')
  list(@CurrentUser() user: UserContext) {
    return this.questions.listQuestions(user);
  }

  @Patch('questions/:id')
  @RequirePermissions('question:manage')
  update(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: UpdateQuestionDto) {
    return this.questions.updateQuestion(user, id, dto);
  }

  @Delete('questions/:id')
  @RequirePermissions('question:manage')
  delete(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.questions.deleteQuestion(user, id);
  }
}