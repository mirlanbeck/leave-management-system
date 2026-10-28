import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { EventsModule } from '../events/events.module';
import { OrgModule } from '../org/org.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { VacationApprovedHook } from './vacation-approved.hook';

/** Согласование (architecture §4): экран согласующего, решение, списание, письмо о решении. */
@Module({
  imports: [OrgModule, BalanceModule, EventsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService, VacationApprovedHook],
})
export class ApprovalsModule {}
