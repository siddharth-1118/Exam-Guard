import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IdentityService } from '../common/identity.service';
import { AppConfig } from '../common/config';

@Module({
  controllers: [AuthController],
  providers: [AuthService, IdentityService, AppConfig],
  exports: [IdentityService],
})
export class AuthModule {}