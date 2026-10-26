import { Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { BalanceService } from '../balance/balance.service';
import { Clock } from '../clock/clock';
import { companyToday, companyTz } from '../clock/company-tz';
import { ApiError, MESSAGES } from '../common/problem';
import { APP_ENV } from '../config/app-config';
import {
  countWorkDays,
  fromDbDate,
  toDbDate,
  type CalendarDate,
} from '../domain';
import type { Prisma } from '../generated/prisma/client';
import { MailType, VacationStatus } from '../generated/prisma/enums';
import { newRequestMail } from '../mail/mail-templates';
import { enqueueMail } from '../mail/outbox';
import { OrgService } from '../org/org.service';
import { PrismaService } from '../prisma/prisma.service';
import type { VacationScope } from './dto/list-vacations.query';
import { evaluateSubmission } from './vacation-rules';
import {
  toVacationView,
  VACATION_INCLUDE,
  type VacationView,
} from './vacation.mapper';

const forbidden = () => new ApiError(403, 'FORBIDDEN', MESSAGES.FORBIDDEN);
const notFound = () => new ApiError(404, 'NOT_FOUND', MESSAGES.NOT_FOUND);

/** Наибольшее значение колонки Int4 (id в БД). */
const INT4_MAX = 2147483647;
/** id, который может существовать в БД; остальные - «не найден» без запроса (DECISIONS [S4]). */
const isDbId = (id: number) =>
  Number.isInteger(id) && id >= 1 && id <= INT4_MAX;

export interface SubmitInput {
  startDate: CalendarDate;
  endDate: CalendarDate;
  backstopperId?: number | null;
  comment?: string | null;
}

/**
 * Подача и чтение заявок. Чтение по видимости (RULES §7-2): заявка, где пользователь
 * backstopper, ему не видна.
 */
@Injectable()
export class VacationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrgService,
    private readonly balance: BalanceService,
    private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: NodeJS.ProcessEnv,
  ) {}

  /**
   * Подача заявки (RULES §3, §8-2, §10-1). Один момент Clock на запрос: из него «сегодня»,
   * `createdAt` заявки и письма. В одной транзакции: блокировка сотрудника FOR NO KEY UPDATE
   * (architecture §6), перечитывание даты выхода и руководителя, все проверки
   * (`evaluateSubmission`), заявка, письмо согласующему.
   */
  async submit(user: AuthUser, input: SubmitInput): Promise<VacationView> {
    const now = await this.clock.now();
    const today = companyToday(now, companyTz(this.env));
    const comment = input.comment?.trim() || null; // RULES §3-8: пустой комментарий - null
    const backstopperId = input.backstopperId ?? null;

    return this.prisma.$transaction(async (tx) => {
      const [me] = await tx.$queryRaw<
        { hireDate: Date; managerId: number | null; fullName: string }[]
      >`SELECT "hireDate", "managerId", "fullName" FROM "User"
        WHERE id = ${user.id} FOR NO KEY UPDATE`;
      const employee = { id: user.id, hireDate: fromDbDate(me.hireDate) };

      const backstopper =
        backstopperId !== null && isDbId(backstopperId)
          ? await tx.user.findUnique({
              where: { id: backstopperId },
              select: { id: true, fullName: true },
            })
          : null;
      const active = await tx.vacation.findMany({
        where: {
          employeeId: user.id,
          status: { in: [VacationStatus.PENDING, VacationStatus.APPROVED] },
        },
        select: { id: true, startDate: true, endDate: true },
      });

      const error = evaluateSubmission({
        employeeId: user.id,
        backstopperId,
        backstopperExists: backstopper !== null,
        startDate: input.startDate,
        endDate: input.endDate,
        comment,
        balance: await this.balance.input(employee, today, tx),
        active: active.map((v) => ({
          id: v.id,
          startDate: fromDbDate(v.startDate),
          endDate: fromDbDate(v.endDate),
        })),
      });
      if (error)
        throw new ApiError(422, error.code, error.message, error.details);

      const workDays = countWorkDays(input.startDate, input.endDate);
      const created = await tx.vacation.create({
        data: {
          employeeId: user.id,
          backstopperId: backstopper!.id,
          startDate: toDbDate(input.startDate),
          endDate: toDbDate(input.endDate),
          workDays,
          comment,
          createdAt: now,
        },
        include: VACATION_INCLUDE,
      });

      // RULES §8-2, §4-2: письмо согласующему; у директора это HR («допуск HR»)
      const approver = await this.org.approverOf(
        { managerId: me.managerId },
        tx,
      );
      await enqueueMail(
        tx,
        [
          {
            type: MailType.NEW_REQUEST,
            vacationId: created.id,
            recipientId: approver.id,
            ...newRequestMail({
              employeeName: me.fullName,
              startDate: input.startDate,
              endDate: input.endDate,
              workDays,
              backstopperName: backstopper!.fullName,
              comment,
              forHr: me.managerId === null,
            }),
          },
        ],
        now,
      );
      return toVacationView(created);
    });
  }

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
