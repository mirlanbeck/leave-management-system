import { Module } from '@nestjs/common';
import { ClockModule } from './clock/clock.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [ClockModule, PrismaModule, HealthModule],
})
export class AppModule {}
