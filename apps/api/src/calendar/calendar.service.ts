import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { BalanceService } from '../balance/balance.service';
import { fromDbDate, toDbDate, type CalendarDate } from '../domain';
import type { Prisma } from '../generated/prisma/client';
import { VacationStatus } from '../generated/prisma/enums';
import { OrgService, type EmployeeRef } from '../org/org.service';
import { PrismaService } from '../prisma/prisma.service';

/** Схема `Calendar` из architecture §7. */
export interface CalendarEntry {
  vacationId: number;
  employee: EmployeeRef;
  teamName: string | null;
  startDate: CalendarDate;
  endDate: CalendarDate;
}

export interface CalendarBalance {
  employee: EmployeeRef;
  /** Дни кратно 0,5; может быть отрицательным (RULES §6-4). */
  balance: number;
}

export interface CalendarView {
  entries: CalendarEntry[];
  /** Только у руководителя: все прямые подчинённые (RULES §7-2). */
  balances?: CalendarBalance[];
}

/**
 * Read-model календаря (architecture §4): только «Одобрена» (RULES §3-11) в пределах видимости
 * зрителя (RULES §7-2, §7-3). Отпуск попадает, если пересекается с [from, to]; даты не обрезаются.
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrgService,
    private readonly balance: BalanceService,
  ) {}

  async calendar(
    viewer: AuthUser,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<CalendarView> {
    // RULES §7-2: календарь шире `visibleTo` (у сотрудника - коллеги и руководитель)
    const scope = await this.org.calendarScope(viewer);
    const where: Prisma.VacationWhereInput = {
      status: VacationStatus.APPROVED,
      startDate: { lte: toDbDate(to) },
      endDate: { gte: toDbDate(from) },
      ...(scope === 'ALL' ? {} : { employeeId: { in: [...scope] } }),
    };
    const rows = await this.prisma.vacation.findMany({
      where,
      select: {
        id: true,
        startDate: true,
        endDate: true,
        employee: { select: { id: true, fullName: true, teamName: true } },
      },
      orderBy: [
        { startDate: 'asc' },
        { employee: { fullName: 'asc' } },
        { id: 'asc' },
      ],
    });
    const view: CalendarView = {
      entries: rows.map((r) => ({
        vacationId: r.id,
        employee: { id: r.employee.id, fullName: r.employee.fullName },
        teamName: r.employee.teamName,
        startDate: fromDbDate(r.startDate),
        endDate: fromDbDate(r.endDate),
      })),
    };
    const balances = await this.reportBalances(viewer);
    if (balances.length > 0) view.balances = balances;
    return view;
  }

  /** Остатки прямых подчинённых на сегодня (RULES §7-2), тот же расчёт, что `/me/balance`. */
  private async reportBalances(viewer: AuthUser): Promise<CalendarBalance[]> {
    const reports = await this.prisma.user.findMany({
      where: { managerId: viewer.id },
      select: { id: true, fullName: true, hireDate: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    });
    if (reports.length === 0) return [];
    const today = await this.balance.today();
    const result: CalendarBalance[] = [];
    for (const r of reports) {
      result.push({
        employee: { id: r.id, fullName: r.fullName },
        balance: await this.balance.balanceTodayDays(
          { id: r.id, hireDate: fromDbDate(r.hireDate) },
          today,
        ),
      });
    }
    return result;
  }
}
