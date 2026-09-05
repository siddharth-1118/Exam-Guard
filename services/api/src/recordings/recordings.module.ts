import { Module } from '@nestjs/common';
import { AppConfig } from '../common/config';
import { RecordingsController } from './recordings.controller';
import { RecordingAdminController } from './recordings-admin.controller';
import { RecordingsService } from './recordings.service';
import { RecordingStorage, createRecordingStorage } from './storage';
import { RetentionSweeper } from './retention.sweeper';

@Module({
  controllers: [RecordingsController, RecordingAdminController],
  providers: [
    RecordingsService,
    RetentionSweeper,
    {
      provide: RecordingStorage,
      useFactory: (config: AppConfig) => createRecordingStorage(config),
      inject: [AppConfig],
    },
  ],
  exports: [RecordingsService, RecordingStorage, RetentionSweeper],
})
export class RecordingsModule {}