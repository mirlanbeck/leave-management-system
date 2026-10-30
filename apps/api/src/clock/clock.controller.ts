import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { parseApiDate } from '../common/api-date';
import { ApiError, MESSAGES } from '../common/problem';
import { APP_ENV } from '../config/app-config';
import { EventBus } from '../events/event-bus';
import { AFTER_CLOCK_SET, type AfterClockSet } from './after-clock-set';
import { Clock } from './clock';
import { companyLocalToInstant } from './company-time';
import { companyTz } from './company-tz';
import { DbClock } from './db-clock';
import { SetClockDto } from './dto/set-clock.dto';

export interface ClockView {
  now: string;
  frozen: boolean;
}

/** Без DEMO_MODE маршрута нет: 404 даёт DemoOnlyMiddleware (ClockModule, RULES §9-2). */
@Controller('clock')
export class ClockController {
  constructor(
    private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: NodeJS.ProcessEnv,
    @Inject(AFTER_CLOCK_SET) private readonly afterSet: AfterClockSet,
    private readonly events: EventBus,
  ) {}

  @Get()
  get(): Promise<ClockView> {
    return this.view();
  }

  /** Дата и время в поясе компании, сервер переводит в момент UTC (RULES §9-3). */
  @Put()
  async set(@Body() dto: SetClockDto): Promise<ClockView> {
    // годы 2000–2100, как у всех дат API (аудит 3, F-4)
    const date = parseApiDate(dto.date, 'date');
    const instant = companyLocalToInstant(date, dto.time, companyTz(this.env));
    if (!instant) {
      throw new ApiError(400, 'VALIDATION_FAILED', MESSAGES.VALIDATION_FAILED, {
        fields: { time: ['такой даты или времени нет в поясе компании'] },
      });
    }
    if (!(this.clock instanceof DbClock)) {
      throw new Error('в демо-режиме ожидались часы из БД');
    }
    await this.clock.set(instant);
    await this.afterSet(instant);
    // RULES §10-2: после прохода планировщика все открытые вкладки перечитываются целиком
    this.events.publish({ type: 'clock.changed' });
    return this.view();
  }

  private async view(): Promise<ClockView> {
    return { now: (await this.clock.now()).toISOString(), frozen: true };
  }
}
