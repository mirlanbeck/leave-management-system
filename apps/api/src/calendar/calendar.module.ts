import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { OrgModule } from '../org/org.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

/** Календарь (architecture §4): read-model по `calendarScope`; об изменениях сообщает `GET /events` (§9). */
@Module({
  imports: [OrgModule, BalanceModule],
  controllers: [CalendarController],
  providers: [CalendarService],
})
export class CalendarModule {}
