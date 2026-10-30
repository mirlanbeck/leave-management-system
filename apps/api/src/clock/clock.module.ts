import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_ENV, isDemoMode } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { EventsModule } from '../events/events.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { Clock, SystemClock } from './clock';
import { ClockController } from './clock.controller';
import { DbClock } from './db-clock';
import { DemoOnlyMiddleware } from './demo-only.middleware';

/**
 * Без DEMO_MODE=true — системные часы, сохранённое значение игнорируется (RULES §9-2).
 * С флагом — часы из БД. GET/PUT /clock без флага дают 404 для всех, в том числе
 * без токена (DemoOnlyMiddleware идёт раньше guard'ов).
 * После PUT /clock — проход планировщика (AFTER_CLOCK_SET из SchedulerModule, RULES §9-4),
 * затем событие `clock.changed` для SSE (RULES §10-2).
 */
@Global()
@Module({
  imports: [SchedulerModule, EventsModule],
  controllers: [ClockController],
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
export class ClockModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DemoOnlyMiddleware).forRoutes(ClockController);
  }
}
