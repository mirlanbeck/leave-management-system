import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { ApiError, MESSAGES } from '../common/problem';
import type { Prisma } from '../generated/prisma/client';
import type { VacationStatus } from '../generated/prisma/enums';
import { OrgService } from '../org/org.service';
import { PrismaService } from '../prisma/prisma.service';
import type { VacationScope } from './dto/list-vacations.query';
import {
  toVacationView,
  VACATION_INCLUDE,
  type VacationView,
} from './vacation.mapper';

const forbidden = () => new ApiError(403, 'FORBIDDEN', MESSAGES.FORBIDDEN);
const notFound = () => new ApiError(404, 'NOT_FOUND', MESSAGES.NOT_FOUND);

/** Чтение заявок по видимости (RULES §7-2). Заявка, где пользователь backstopper, ему не видна. */
@Injectable()
export class VacationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrgService,
  ) {}

  async list(
    viewer: AuthUser,
    scope: VacationScope = 'mine',
    statuses?: VacationStatus[],
  ): Promise<VacationView[]> {
    const where: Prisma.VacationWhereInput = {
      ...(await this.employeesFilter(viewer, scope)),
      ...(statuses ? { status: { in: statuses } } : {}),
    };
    const rows = await this.prisma.vacation.findMany({
      where,
      include: VACATION_INCLUDE,
      orderBy: { id: 'desc' },
    });
    return rows.map(toVacationView);
  }

  /** Невидимая заявка отвечает так же, как несуществующая: 404 (architecture §5). */
  async get(viewer: AuthUser, id: number): Promise<VacationView> {
    const row = await this.prisma.vacation.findUnique({
      where: { id },
      include: VACATION_INCLUDE,
    });
    if (!row || !(await this.org.canSee(viewer, row.employeeId))) {
      throw notFound();
    }
    return toVacationView(row);
  }

  private async employeesFilter(
    viewer: AuthUser,
    scope: VacationScope,
  ): Promise<Prisma.VacationWhereInput> {
    if (scope === 'mine') return { employeeId: viewer.id };
    if (scope === 'all') {
      if (!viewer.isHr) throw forbidden();
      return {};
    }
    const team = await this.org.directReportIds(viewer.id);
    if (team.length === 0) throw forbidden();
    return { employeeId: { in: team } };
  }
}
