import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { MeController } from './me.controller';
import { OrgService } from './org.service';

@Module({
  controllers: [MeController, EmployeesController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
