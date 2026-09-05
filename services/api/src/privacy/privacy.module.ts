import { Module } from '@nestjs/common';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [PrivacyController],
  providers: [PrivacyService, PrismaService],
})
export class PrivacyModule {}
