import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { approverOf, canSee, rolesOf, scope, type Scope } from './policy';

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

  async visibleTo(viewer: AuthUser): Promise<Scope> {
    return scope(viewer, await this.directReportIds(viewer.id));
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

  /** Согласующий заявки сотрудника: руководитель, у директора HR (RULES §4-1, §4-2). */
  async approverOf(
    employee: Pick<AuthUser, 'managerId'>,
  ): Promise<EmployeeRef> {
    const hr = await this.prisma.user.findFirst({
      where: { isHr: true },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (employee.managerId === null && !hr) {
      throw new Error('в системе нет HR: согласующего директора нет');
    }
    return this.prisma.user.findUniqueOrThrow({
      where: { id: approverOf(employee, hr?.id ?? -1) },
      select: { id: true, fullName: true },
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
