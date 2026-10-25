import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { canSee, rolesOf, scope, type Scope } from './policy';

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
