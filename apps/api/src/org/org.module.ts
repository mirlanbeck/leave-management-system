import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { OrgService } from './org.service';

@Module({
  controllers: [MeController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
