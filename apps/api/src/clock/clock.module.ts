import { Global, Module } from '@nestjs/common';
import { APP_ENV, isDemoMode } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { Clock, SystemClock } from './clock';
import { DbClock } from './db-clock';

/**
 * Без DEMO_MODE=true — системные часы, сохранённое значение игнорируется (RULES §9-2).
 * С флагом — часы из БД.
 */
@Global()
@Module({
  providers: [
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
