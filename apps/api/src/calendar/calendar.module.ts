import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { OrgModule } from '../org/org.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

/** Календарь без SSE (architecture §4): read-model по `calendarScope`; поток событий - S8. */
@Module({
  imports: [OrgModule, BalanceModule],
  controllers: [CalendarController],
  providers: [CalendarService],
})
export class CalendarModule {}
