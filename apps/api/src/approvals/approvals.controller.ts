import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseVacationId } from '../vacations/vacation-id';
import type { VacationView } from '../vacations/vacation.mapper';
import { ApprovalsService, type ApprovalItem } from './approvals.service';
import { DecisionDto } from './dto/decision.dto';

/** Экран согласующего и решение (RULES §4; architecture §7). */
@Controller()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('approvals')
  pending(@CurrentUser() user: AuthUser): Promise<ApprovalItem[]> {
    return this.approvals.pending(user);
  }

  @Post('vacations/:id/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: DecisionDto,
  ): Promise<VacationView> {
    return this.approvals.decide(
      user,
      parseVacationId(id),
      'approve',
      body?.comment,
    );
  }

  @Post('vacations/:id/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: DecisionDto,
  ): Promise<VacationView> {
    return this.approvals.decide(
      user,
      parseVacationId(id),
      'reject',
      body?.comment,
    );
  }
}
