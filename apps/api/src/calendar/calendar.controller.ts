import { Controller, Get, Query } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseApiDates } from '../common/api-date';
import { ApiError, MESSAGES } from '../common/problem';
import { CalendarService, type CalendarView } from './calendar.service';
import { CalendarQuery } from './dto/calendar.query';

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  /** Календарь (RULES §7-2): только «Одобрена», по видимости зрителя; диапазон не ограничен. */
  @Get()
  get(
    @CurrentUser() user: AuthUser,
    @Query() query: CalendarQuery,
  ): Promise<CalendarView> {
    const { from, to } = parseApiDates({ from: query.from, to: query.to });
    if (from > to) {
      throw new ApiError(400, 'VALIDATION_FAILED', MESSAGES.VALIDATION_FAILED, {
        fields: { to: ['to: не раньше from'] },
      });
    }
    return this.calendar.calendar(user, from, to);
  }
}
