import { Global, Module } from '@nestjs/common';
import { AppConfig } from './config';
import { IdentityService } from './identity.service';
import { EventBus } from './event-bus';

@Global()
@Module({
  providers: [AppConfig, IdentityService, EventBus],
  exports: [AppConfig, IdentityService, EventBus],
})
export class CommonModule {}