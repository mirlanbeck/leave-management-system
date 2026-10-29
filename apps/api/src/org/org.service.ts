import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import {
  fromDbDate,
  toDbDate,
  type CalendarDate,
} from '../domain/calendar-date';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  approverOf,
  calendarScope,
  canSee,
  rolesOf,
  scope,
  type OrgUser,
  type Scope,
} from './policy';

/** «id + имя»: единственные поля, которые видят все (RULES §3-3, §7-2). */
export interface EmployeeRef {
  id: number;
  fullName: string;
}

export interface Profile {
  id: number;
  fullName: string;
  hireDate: string;
  teamName: string | null;
  manager: { id: number; fullName: string } | null;
  isHr: boolean;
  isManager: boolean;
}

/** Сотрудник для экрана HR «Остатки по сотрудникам» (RULES §7-2). */
export interface RosterEntry {
  id: number;
  fullName: string;
  teamName: string | null;
  hireDate: CalendarDate;
  manager: EmployeeRef | null;
}

/** Структура читается на каждый запрос, без кэша (architecture §5). */
@Injectable()
export class OrgService {
  constructor(private readonly prisma: PrismaService) {}

  async directReportIds(userId: number): Promise<number[]> {
    const rows = await this.prisma.user.findMany({
      where: { managerId: userId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /** Вся структура одним запросом: фильтр SSE читает её один раз на событие (RULES §7-2, §10-2). */
  structure(): Promise<OrgUser[]> {
    return this.prisma.user.findMany({
      select: { id: true, isHr: true, managerId: true },
      orderBy: { id: 'asc' },
    });
  }

  async visibleTo(viewer: AuthUser): Promise<Scope> {
    return scope(viewer, await this.directReportIds(viewer.id));
  }

  /** Видимость календаря (RULES §7-2): у сотрудника ещё коллеги и руководитель. */
  async calendarScope(viewer: AuthUser): Promise<Scope> {
    const reports = await this.directReportIds(viewer.id);
    const peers =
      viewer.managerId === null
        ? []
        : await this.directReportIds(viewer.managerId);
    return calendarScope(viewer, reports, peers);
  }

  async canSee(viewer: AuthUser, employeeId: number): Promise<boolean> {
    return canSee(viewer, await this.directReportIds(viewer.id), employeeId);
  }

  /** Справочник «id + имя» для выбора backstopper, без вошедшего (RULES §3-3). */
  directory(viewerId: number): Promise<EmployeeRef[]> {
    return this.prisma.user.findMany({
      where: { id: { not: viewerId } },
      select: { id: true, fullName: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Согласующий заявки сотрудника: руководитель, у директора HR (RULES §4-1, §4-2).
   * `db` - клиент транзакции, если вызов идёт внутри операции (architecture §4).
   */
  async approverOf(
    employee: Pick<AuthUser, 'managerId'>,
    db: Pick<Prisma.TransactionClient, 'user'> = this.prisma,
  ): Promise<EmployeeRef> {
    const hrId = await this.hrId(db);
    if (employee.managerId === null && hrId === -1) {
      throw new Error('в системе нет HR: согласующего директора нет');
    }
    return db.user.findUniqueOrThrow({
      where: { id: approverOf(employee, hrId) },
      select: { id: true, fullName: true },
    });
  }

  /** id HR (инвариант «HR один» держит seed); -1, если HR нет: такого id не бывает. */
  async hrId(
    db: Pick<Prisma.TransactionClient, 'user'> = this.prisma,
  ): Promise<number> {
    const hr = await db.user.findFirst({
      where: { isHr: true },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return hr?.id ?? -1;
  }

  /** Все сотрудники с руководителем для экрана HR (RULES §7-2), по имени и id. */
  async roster(): Promise<RosterEntry[]> {
    const rows = await this.prisma.user.findMany({
      select: {
        id: true,
        fullName: true,
        teamName: true,
        hireDate: true,
        manager: { select: { id: true, fullName: true } },
      },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({ ...r, hireDate: fromDbDate(r.hireDate) }));
  }

  async rosterEntry(id: number): Promise<RosterEntry | null> {
    const r = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        teamName: true,
        hireDate: true,
        manager: { select: { id: true, fullName: true } },
      },
    });
    return r && { ...r, hireDate: fromDbDate(r.hireDate) };
  }

  /**
   * Смена даты выхода (RULES §6-1, §6-6): блокировка User FOR NO KEY UPDATE (architecture §6),
   * та же дата не пишется. Журнал и заявки не трогаются. `true`, если дата изменилась;
   * `null`, если сотрудника нет.
   */
  async setHireDate(
    employeeId: number,
    hireDate: CalendarDate,
  ): Promise<boolean | null> {
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ hireDate: Date }[]>`
        SELECT "hireDate" FROM "User" WHERE id = ${employeeId} FOR NO KEY UPDATE`;
      if (!row) return null;
      if (fromDbDate(row.hireDate) === hireDate) return false;
      await tx.user.update({
        where: { id: employeeId },
        data: { hireDate: toDbDate(hireDate) },
      });
      return true;
    });
  }

  async profile(user: AuthUser): Promise<Profile> {
    const roles = rolesOf(user, await this.directReportIds(user.id));
    const manager =
      user.managerId === null
        ? null
        : await this.prisma.user.findUnique({
            where: { id: user.managerId },
            select: { id: true, fullName: true },
          });
    return {
      id: user.id,
      fullName: user.fullName,
      hireDate: user.hireDate,
      teamName: user.teamName,
      manager,
      isHr: roles.isHr,
      isManager: roles.isManager,
    };
  }
}
