import { Module } from '@nestjs/common';
import { AFTER_CLOCK_SET, type AfterClockSet } from '../clock/after-clock-set';
import { ReminderScheduler } from './reminder-scheduler';
import { ReminderWorker } from './reminder-worker';

/**
 * Планировщик напоминаний (architecture §10): проход при старте, раз в минуту в обычном режиме
 * и после каждой установки демо-часов — через AFTER_CLOCK_SET для ClockController (RULES §9-4).
 */
@Module({
  providers: [
    ReminderScheduler,
    ReminderWorker,
    {
      provide: AFTER_CLOCK_SET,
      inject: [ReminderScheduler],
      useFactory:
        (scheduler: ReminderScheduler): AfterClockSet =>
        async () => {
          await scheduler.pass();
        },
    },
  ],
  exports: [ReminderScheduler, AFTER_CLOCK_SET],
})
export class SchedulerModule {}
