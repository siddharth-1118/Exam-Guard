import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthGuard } from './common/guards/auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { CustomThrottlerGuard } from './common/guards/custom-throttler.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { StudentsModule } from './students/students.module';
import { MonitorsModule } from './monitors/monitors.module';
import { QuestionsModule } from './questions/questions.module';
import { ExamsModule } from './exams/exams.module';
import { AttemptsModule } from './attempts/attempts.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { MediaModule } from './media/media.module';
import { AuditModule } from './audit/audit.module';
import { ReportsModule } from './reports/reports.module';
import { HealthModule } from './health/health.module';
import { RecordingsModule } from './recordings/recordings.module';
import { PrivacyModule } from './privacy/privacy.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.RATE_LIMIT_LIMIT ?? 120) }]),
    PrismaModule,
    CommonModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    StudentsModule,
    MonitorsModule,
    QuestionsModule,
    ExamsModule,
    AttemptsModule,
    MonitoringModule,
    MediaModule,
    AuditModule,
    ReportsModule,
    RecordingsModule,
    PrivacyModule,
    MetricsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: CustomThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}