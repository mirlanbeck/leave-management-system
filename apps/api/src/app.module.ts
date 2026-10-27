import { Module } from '@nestjs/common';
import { ApprovalsModule } from './approvals/approvals.module';
import { AuthModule } from './auth/auth.module';
import { BalanceModule } from './balance/balance.module';
import { ClockModule } from './clock/clock.module';
import { CommonModule } from './common/common.module';
import { AppConfigModule } from './config/config.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { OrgModule } from './org/org.module';
import { PrismaModule } from './prisma/prisma.module';
import { VacationsModule } from './vacations/vacations.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    CommonModule,
    ClockModule,
    AuthModule,
    OrgModule,
    BalanceModule,
    VacationsModule,
    ApprovalsModule,
    EventsModule,
    MailModule,
    HealthModule,
  ],
})
export class AppModule {}
