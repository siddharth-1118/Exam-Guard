import { Module } from '@nestjs/common';
import { AppConfig } from '../common/config';
import { RecordingsController } from './recordings.controller';
import { RecordingAdminController } from './recordings-admin.controller';
import { RecordingsService } from './recordings.service';
import { RecordingStorage, createRecordingStorage } from './storage';

@Module({
  controllers: [RecordingsController, RecordingAdminController],
  providers: [
    RecordingsService,
    {
      provide: RecordingStorage,
      useFactory: (config: AppConfig) => createRecordingStorage(config),
      inject: [AppConfig],
    },
  ],
})
export class RecordingsModule {}