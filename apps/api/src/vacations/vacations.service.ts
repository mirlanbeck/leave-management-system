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
  refundHalfDays,
  toDbDate,
  type CalendarDate,
} from '../domain';
import { EventBus } from '../events/event-bus';
import { Prisma } from '../generated/prisma/client';
import {
  LedgerKind,
  MailType,
  VacationStatus,
} from '../generated/prisma/enums';
import { newRequestMail } from '../mail/mail-templates';
import { enqueueMail } from '../mail/outbox';
import { OrgService } from '../org/org.service';
import { PrismaService } from '../prisma/prisma.service';
import { cancelError, recallError, type ActionError } from './cancel-rules';
import type { VacationScope } from './dto/list-vacations.query';
import { evaluateSubmission } from './vacation-rules';
import {
  toVacationView,
  VACATION_INCLUDE,
  type VacationView,
  type Viewer,
} from './vacation.mapper';

const forbidden = () => new ApiError(403, 'FORBIDDEN', MESSAGES.FORBIDDEN);
const notFound = () => new ApiError(404, 'NOT_FOUND', MESSAGES.NOT_FOUND);
const alreadyProcessed = () =>
  new ApiError(409, 'ALREADY_PROCESSED', MESSAGES.ALREADY_PROCESSED);
const toApiError = (e: ActionError) =>
  new ApiError(e.status, e.code, e.message);

/** Нарушение уникального индекса возврата: второй REFUND по заявке (architecture §6 п.5). */
function isDuplicateRefund(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code !== 'P2002') return false;
  return JSON.stringify(e.meta ?? {}).includes('one_refund_per_vacation');
}

/** Заявка и её предшественники по цепочке переносов (RULES §5-12): id по возрастанию и корень. */
interface Chain {
  ids: number[];
  rootId: number;
}

/** Что из заявки нужно правилам отмены и отзыва. */
type ActionRow = {
  employeeId: number;
  status: VacationStatus;
  startDate: Date;
  endDate: Date;
};

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
    private readonly events: EventBus,
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
      return toVacationView(created, await this.viewerOf(user, today, tx));
    });
  }

  /**
   * Отмена владельцем до начала (RULES §5-4, §5-7, §5-10). «Одобрена»: возврат всех рабочих
   * дней к списанию корня цепочки (§6-8) и событие vacation.cancelled; «На согласовании»: только
   * статус. Писем нет (§8-8).
   */
  cancel(viewer: AuthUser, id: number): Promise<VacationView> {
    return this.cancelOrRecall(viewer, id, 'EMPLOYEE', (row, today) =>
      cancelError({
        actorId: viewer.id,
        employeeId: row.employeeId,
        status: row.status,
        startDate: fromDbDate(row.startDate),
        today,
      }),
    );
  }

  /**
   * Отзыв HR из идущего отпуска с датой выхода (RULES §5-5, §5-6, §5-11): возвращаются рабочие
   * дни с даты выхода по окончание, статус «Отменена». Писем нет (§8-8).
   */
  recall(
    viewer: AuthUser,
    id: number,
    returnDate: CalendarDate,
  ): Promise<VacationView> {
    return this.cancelOrRecall(
      viewer,
      id,
      'HR_RECALL',
      (row, today) =>
        recallError({
          actorIsHr: viewer.isHr,
          status: row.status,
          startDate: fromDbDate(row.startDate),
          endDate: fromDbDate(row.endDate),
          today,
          returnDate,
        }),
      returnDate,
    );
  }

  /**
   * Общая транзакция отмены и отзыва (architecture §6). Цепочка читается до блокировки
   * (replacesId не меняется), затем User сотрудника → звенья по возрастанию id FOR NO KEY UPDATE;
   * статус перечитывается и проверяется `check`. Возврат вставляется под триггером, который
   * блокирует списание корня. Один момент Clock на запрос: cancelledAt и occurredAt возврата.
   */
  private async cancelOrRecall(
    viewer: AuthUser,
    id: number,
    by: 'EMPLOYEE' | 'HR_RECALL',
    check: (row: ActionRow, today: CalendarDate) => ActionError | null,
    returnDate?: CalendarDate,
  ): Promise<VacationView> {
    const now = await this.clock.now();
    const today = companyToday(now, companyTz(this.env));

    const head = await this.prisma.vacation.findUnique({
      where: { id },
      select: { employeeId: true },
    });
    if (!head || !(await this.org.canSee(viewer, head.employeeId))) {
      throw notFound();
    }
    const chain = await this.chainOf(id);

    let result: { view: VacationView; refunded: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User"
          WHERE id = ${head.employeeId} FOR NO KEY UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Vacation"
          WHERE id IN (${Prisma.join(chain.ids)}) ORDER BY id FOR NO KEY UPDATE`;
        // перечитывание после захвата (architecture §6 п.2)
        const row = await tx.vacation.findUniqueOrThrow({ where: { id } });
        const error = check(row, today);
        if (error) throw toApiError(error);

        // «На согласовании» дней не списывала: возвращать нечего (RULES §5-4)
        const refunded = row.status === VacationStatus.APPROVED;
        if (refunded) {
          const halfDays =
            returnDate === undefined
              ? row.workDays * 2 // RULES §5-4: полностью
              : refundHalfDays(
                  fromDbDate(row.startDate),
                  fromDbDate(row.endDate),
                  returnDate,
                ); // RULES §5-6: с даты выхода до конца, может быть 0
          await this.refund(tx, id, chain.rootId, halfDays, now);
        }
        const updated = await tx.vacation.update({
          where: { id },
          data: {
            status: VacationStatus.CANCELLED,
            cancelledById: viewer.id,
            cancelledAt: now,
            returnDate: returnDate === undefined ? null : toDbDate(returnDate),
          },
          include: VACATION_INCLUDE,
        });
        return {
          view: toVacationView(updated, await this.viewerOf(viewer, today, tx)),
          refunded,
        };
      });
    } catch (e) {
      // последняя линия: второй возврат по заявке запрещает БД (architecture §6 п.5)
      if (isDuplicateRefund(e)) throw alreadyProcessed();
      throw e;
    }

    // RULES §10-2: календарь меняется только при отмене одобренного отпуска (architecture §9)
    if (result.refunded) {
      this.events.publish({
        type: 'vacation.cancelled',
        employeeId: head.employeeId,
        vacationId: id,
        by,
      });
    }
    return result.view;
  }

  /** Возврат всегда к списанию корня цепочки (RULES §6-8); сумму возвратов стережёт триггер БД. */
  private async refund(
    tx: Prisma.TransactionClient,
    vacationId: number,
    rootId: number,
    halfDays: number,
    now: Date,
  ): Promise<void> {
    const debit = await tx.ledgerEntry.findFirstOrThrow({
      where: { vacationId: rootId, kind: LedgerKind.DEBIT },
      select: { id: true },
    });
    await tx.ledgerEntry.create({
      data: {
        kind: LedgerKind.REFUND,
        vacationId,
        refundOfId: debit.id,
        halfDays,
        occurredAt: now,
      },
    });
  }

  /** Заявка и её предшественники по replacesId; UNION: цикл не зациклит запрос (как триггер). */
  private async chainOf(id: number): Promise<Chain> {
    const rows = await this.prisma.$queryRaw<
      { id: number; replacesId: number | null }[]
    >`WITH RECURSIVE chain AS (
        SELECT id, "replacesId" FROM "Vacation" WHERE id = ${id}
        UNION
        SELECT v.id, v."replacesId" FROM "Vacation" v JOIN chain c ON v.id = c."replacesId"
      )
      SELECT id, "replacesId" FROM chain`;
    const root = rows.find((r) => r.replacesId === null);
    if (!root) throw new Error(`у заявки ${id} нет корня цепочки`);
    return {
      ids: rows.map((r) => r.id).sort((a, b) => a - b),
      rootId: root.id,
    };
  }

  private async viewerOf(
    user: AuthUser,
    today: CalendarDate,
    db?: Prisma.TransactionClient,
  ): Promise<Viewer> {
    return {
      id: user.id,
      isHr: user.isHr,
      hrId: await this.org.hrId(db),
      today,
    };
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
    const v = await this.viewerOf(viewer, await this.balance.today());
    return rows.map((row) => toVacationView(row, v));
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
    return toVacationView(
      row,
      await this.viewerOf(viewer, await this.balance.today()),
    );
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
