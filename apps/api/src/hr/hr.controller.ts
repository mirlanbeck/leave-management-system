import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseApiDate } from '../common/api-date';
import { parsePathId } from '../common/path-id';
import { HireDateDto } from './dto/hire-date.dto';
import { HrBalancesQuery } from './dto/hr-balances.query';
import { HrService, type HrBalanceRow } from './hr.service';

@Controller()
export class HrController {
  constructor(private readonly hr: HrService) {}

  /** Остатки по сотрудникам (RULES §7-2): только HR, все сотрудники, остаток на сегодня. */
  @Get('hr/balances')
  balances(
    @CurrentUser() user: AuthUser,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- query нужен только для проверки «лишних параметров нет»
    @Query() _query: HrBalancesQuery,
  ): Promise<HrBalanceRow[]> {
    return this.hr.balances(user);
  }

  /** Смена даты выхода (RULES §6-1): только HR, в любую сторону; порядок проверок - architecture §8. */
  @Patch('employees/:id/hire-date')
  changeHireDate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: HireDateDto,
  ): Promise<HrBalanceRow> {
    const hireDate = parseApiDate(body.hireDate, 'hireDate');
    return this.hr.changeHireDate(user, parsePathId(id), hireDate);
  }
}
