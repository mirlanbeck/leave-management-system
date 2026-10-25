import { Global, Module } from '@nestjs/common';
import { APP_ENV, isDemoMode } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { AFTER_CLOCK_SET, noopAfterClockSet } from './after-clock-set';
import { Clock, SystemClock } from './clock';
import { ClockController } from './clock.controller';
import { DbClock } from './db-clock';

/**
 * Без DEMO_MODE=true — системные часы, сохранённое значение игнорируется (RULES §9-2).
 * С флагом — часы из БД. GET/PUT /clock без флага дают 404 (DemoOnlyGuard).
 */
@Global()
@Module({
  controllers: [ClockController],
  providers: [
    { provide: AFTER_CLOCK_SET, useValue: noopAfterClockSet },
    {
      provide: Clock,
      inject: [APP_ENV, PrismaService],
      useFactory: (env: NodeJS.ProcessEnv, prisma: PrismaService): Clock =>
        isDemoMode(env) ? new DbClock(prisma) : new SystemClock(),
    },
  ],
  exports: [Clock],
})
export class ClockModule {}
