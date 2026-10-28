import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { EventsModule } from '../events/events.module';
import { OrgModule } from '../org/org.module';
import { HrController } from './hr.controller';
import { HrService } from './hr.service';

/** Экран HR «Остатки по сотрудникам» и смена даты выхода (architecture §4, S6c). */
@Module({
  imports: [OrgModule, BalanceModule, EventsModule],
  controllers: [HrController],
  providers: [HrService],
})
export class HrModule {}
