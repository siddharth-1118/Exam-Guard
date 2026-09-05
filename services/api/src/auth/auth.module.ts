import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { IdentityService } from '../common/identity.service';
import { AppConfig } from '../common/config';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, MfaService, IdentityService, AppConfig, PrismaService],
  exports: [IdentityService, MfaService],
})
export class AuthModule {}