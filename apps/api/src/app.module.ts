import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ClockModule } from './clock/clock.module';
import { CommonModule } from './common/common.module';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { OrgModule } from './org/org.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    CommonModule,
    ClockModule,
    AuthModule,
    OrgModule,
    HealthModule,
  ],
})
export class AppModule {}
