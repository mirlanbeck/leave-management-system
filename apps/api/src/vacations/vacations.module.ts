import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { OrgModule } from '../org/org.module';
import { VacationsController } from './vacations.controller';
import { VacationsService } from './vacations.service';

@Module({
  imports: [OrgModule, BalanceModule],
  controllers: [VacationsController],
  providers: [VacationsService],
  exports: [VacationsService],
})
export class VacationsModule {}
