import { Module } from '@nestjs/common';
import { AiProctoringService } from './ai-proctoring.service';

@Module({
  providers: [AiProctoringService],
  exports: [AiProctoringService],
})
export class AiModule {}
