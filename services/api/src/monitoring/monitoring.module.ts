import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { EventsController } from './events.controller';
import { MonitoringService } from './monitoring.service';

@Module({
  controllers: [MonitoringController, EventsController],
  providers: [MonitoringService],
})
export class MonitoringModule {}