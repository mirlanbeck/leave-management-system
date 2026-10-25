import { Controller, Get, Query } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseApiDate } from '../common/api-date';
import { BalanceService, type BalanceView } from './balance.service';

@Controller('me/balance')
export class BalanceController {
  constructor(private readonly balance: BalanceService) {}

  /** Остаток на сегодня и «доступно на дату on» (RULES §3-10). */
  @Get()
  get(
    @CurrentUser() user: AuthUser,
    @Query('on') on?: string,
  ): Promise<BalanceView> {
    return this.balance.view(
      user,
      on === undefined ? undefined : parseApiDate(on, 'on'),
    );
  }
}
