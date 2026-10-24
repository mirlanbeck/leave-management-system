import { Module } from '@nestjs/common';
import { ClockModule } from './clock/clock.module';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [AppConfigModule, PrismaModule, ClockModule, HealthModule],
})
export class AppModule {}
