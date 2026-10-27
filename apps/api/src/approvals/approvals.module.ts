import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { EventsModule } from '../events/events.module';
import { OrgModule } from '../org/org.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

/** Согласование (architecture §4): экран согласующего, решение, списание. */
@Module({
  imports: [OrgModule, BalanceModule, EventsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
})
export class ApprovalsModule {}
