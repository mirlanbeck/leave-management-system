import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { BalanceService } from '../balance/balance.service';
import { ApiError, MESSAGES } from '../common/problem';
import type { CalendarDate } from '../domain';
import { EventBus } from '../events/event-bus';
import {
  OrgService,
  type EmployeeRef,
  type RosterEntry,
} from '../org/org.service';
import { hireDateChangeError } from './hr-rules';

/** Строка экрана «Остатки по сотрудникам» (architecture §7, HrBalanceRow). */
export interface HrBalanceRow {
  employeeId: number;
  fullName: string;
  teamName: string | null;
  manager: EmployeeRef | null;
  hireDate: CalendarDate;
  /** Остаток на сегодня, кратно 0,5; может быть отрицательным (RULES §6-4). */
  balance: number;
}

const forbidden = () => new ApiError(403, 'FORBIDDEN', MESSAGES.FORBIDDEN);
const notFound = () => new ApiError(404, 'NOT_FOUND', MESSAGES.NOT_FOUND);

/**
 * Экран HR: остатки всех сотрудников и смена даты выхода (RULES §6, §7-2). Остаток считает тот же
 * BalanceService, что `/me/balance`; таблицу User пишет OrgService (architecture §4).
 */
@Injectable()
export class HrService {
  constructor(
    private readonly org: OrgService,
    private readonly balance: BalanceService,
    private readonly events: EventBus,
  ) {}

  async balances(viewer: AuthUser): Promise<HrBalanceRow[]> {
    if (!viewer.isHr) throw forbidden();
    const today = await this.balance.today();
    const rows: HrBalanceRow[] = [];
    for (const e of await this.org.roster()) {
      rows.push(await this.row(e, today));
    }
    return rows;
  }

  /**
   * Смена даты выхода (RULES §6-1…§6-6): в любую сторону, журнал, заявки и письма не меняются.
   * Событие `employee.hire-date-changed` после коммита и только при реальном изменении (§10-2).
   */
  async changeHireDate(
    viewer: AuthUser,
    employeeId: number,
    hireDate: CalendarDate,
  ): Promise<HrBalanceRow> {
    const exists = (await this.org.rosterEntry(employeeId)) !== null;
    const error = hireDateChangeError({
      exists,
      visible: exists && (await this.org.canSee(viewer, employeeId)),
      actorIsHr: viewer.isHr,
    });
    if (error === 'NOT_FOUND') throw notFound();
    if (error === 'FORBIDDEN') throw forbidden();

    const changed = await this.org.setHireDate(employeeId, hireDate);
    if (changed === null) throw notFound();
    if (changed) {
      this.events.publish({ type: 'employee.hire-date-changed', employeeId });
    }
    const entry = await this.org.rosterEntry(employeeId);
    if (!entry) throw notFound();
    return this.row(entry, await this.balance.today());
  }

  private async row(
    e: RosterEntry,
    today: CalendarDate,
  ): Promise<HrBalanceRow> {
    return {
      employeeId: e.id,
      fullName: e.fullName,
      teamName: e.teamName,
      manager: e.manager,
      hireDate: e.hireDate,
      balance: await this.balance.balanceTodayDays(
        { id: e.id, hireDate: e.hireDate },
        today,
      ),
    };
  }
}
