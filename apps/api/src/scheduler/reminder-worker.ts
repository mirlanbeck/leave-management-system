import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { APP_ENV, isDemoMode } from '../config/app-config';
import { ReminderScheduler } from './reminder-scheduler';

/** Интервал прохода в обычном режиме (DECISIONS 2026-10-22 9:35). */
export const SCHEDULER_INTERVAL_MS = 60_000;

/**
 * Запуск планировщика (RULES §9-4): проход при старте; в обычном режиме далее раз в минуту
 * цепочкой setTimeout, проходы не накладываются. В демо-режиме часы стоят, поэтому
 * периодического прохода нет: он выполняется после каждой установки часов (AFTER_CLOCK_SET).
 * В тестах подменяется (test-app.ts), проходы вызываются явно через ReminderScheduler.pass().
 */
@Injectable()
export class ReminderWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReminderWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly scheduler: ReminderScheduler,
    @Inject(APP_ENV) private readonly env: NodeJS.ProcessEnv,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.running = this.pass();
    await this.running;
    this.running = undefined;
    if (!isDemoMode(this.env)) this.schedule();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.pass().finally(() => {
        this.running = undefined;
        this.schedule();
      });
    }, SCHEDULER_INTERVAL_MS);
  }

  private async pass(): Promise<void> {
    try {
      await this.scheduler.pass();
    } catch (error) {
      this.logger.error(
        `Проход планировщика не выполнен: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
