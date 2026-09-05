import { Module } from '@nestjs/common';
import { MediaController, MediaTokenController } from './media.controller';
import { MediaService } from './media.service';
import { MediaGateway } from './media.gateway';
import { MediaSweeperService } from './media.sweeper';
import { MediaCleanupService } from './media.cleanup';
import { MediaPresenceService } from './media.presence';

@Module({
  controllers: [MediaController, MediaTokenController],
  providers: [
    MediaService,
    MediaGateway,
    MediaSweeperService,
    MediaCleanupService,
    MediaPresenceService,
  ],
  exports: [MediaService, MediaGateway, MediaPresenceService],
})
export class MediaModule {}
