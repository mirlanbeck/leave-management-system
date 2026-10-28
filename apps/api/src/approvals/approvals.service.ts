import { Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { BalanceService } from '../balance/balance.service';
import { Clock } from '../clock/clock';
import { companyToday, companyTz } from '../clock/company-tz';
import { ApiError, MESSAGES, type Problem } from '../common/problem';
import { APP_ENV } from '../config/app-config';
import { fromDbDate, type CalendarDate } from '../domain';
import { Prisma } from '../generated/prisma/client';
import { LedgerKind, VacationStatus } from '../generated/prisma/enums';
import { EventBus } from '../events/event-bus';
import { enqueueDecisionMail } from '../mail/decision-mail';
import { OrgService, type EmployeeRef } from '../org/org.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  toVacationView,
  VACATION_INCLUDE,
  type VacationRow,
  type VacationView,
} from '../vacations/vacation.mapper';
import {
  actorError,
  approveBlock,
  overlapOwner,
  overlapsWith,
  type ApprovalError,
} from './approval-rules';
import { VacationApprovedHook } from './vacation-approved.hook';

/** Элемент экрана «Заявки на согласование» (architecture §7, ApprovalItem). */
export interface ApprovalItem {
  vacation: VacationView;
  availableOnStart: number | null;
  overlaps: {
    vacationId: number;
    employee: EmployeeRef;
    startDate: CalendarDate;
    endDate: CalendarDate;
  }[];
  canApprove: boolean;
  blockReason: Problem | null;
}

export type Decision = 'approve' | 'reject';

const toApiError = (e: ApprovalError) =>
  new ApiError(e.status, e.code, e.message, e.details);
const notFound = () => new ApiError(404, 'NOT_FOUND', MESSAGES.NOT_FOUND);
const alreadyProcessed = () =>
  new ApiError(409, 'ALREADY_PROCESSED', MESSAGES.ALREADY_PROCESSED);

/** Нарушение уникального индекса списания: второе DEBIT по заявке (architecture §6 п.5). */
function isDuplicateDebit(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code !== 'P2002') return false;
  return JSON.stringify(e.meta ?? {}).includes('one_debit_per_vacation');
}

/**
 * Экран согласующего и решение (RULES §4). Решение - одна транзакция под блокировками
 * architecture §6: User сотрудника, затем Vacation, перечитывание статуса и остатка, статус и
 * списание, письмо о решении. Событие шины - после коммита (architecture §4, §9).
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrgService,
    private readonly balance: BalanceService,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly approvedHook: VacationApprovedHook,
    @Inject(APP_ENV) private readonly env: NodeJS.ProcessEnv,
  ) {}

  /**
   * Заявки PENDING, где зритель - согласующий (RULES §4-7, §4-2): руководителю - от прямых
   * подчинённых, HR - заявки директора. Без подчинённых и не HR - 403.
   */
  async pending(viewer: AuthUser): Promise<ApprovalItem[]> {
    const reports = await this.org.directReportIds(viewer.id);
    if (!viewer.isHr && reports.length === 0) {
      throw new ApiError(403, 'FORBIDDEN', MESSAGES.FORBIDDEN);
    }
    const hrId = await this.org.hrId();
    const employeeOr: Prisma.UserWhereInput[] = [{ managerId: viewer.id }];
    if (viewer.isHr) employeeOr.push({ managerId: null });
    const rows = await this.prisma.vacation.findMany({
      where: { status: VacationStatus.PENDING, employee: { OR: employeeOr } },
      include: VACATION_INCLUDE,
      orderBy: { id: 'asc' },
    });
    const today = await this.balance.today();
    const items: ApprovalItem[] = [];
    for (const row of rows) {
      const available = await this.availableOnStart(row, today);
      const block = approveBlock(available, row.workDays);
      items.push({
        vacation: toVacationView(row, { id: viewer.id, hrId }),
        availableOnStart: available,
        overlaps: await this.overlaps(row),
        canApprove: block === null,
        blockReason: block && {
          statusCode: block.status,
          code: block.code,
          message: block.message,
          details: block.details,
        },
      });
    }
    return items;
  }

  /**
   * Подтвердить или отклонить (RULES §4-1…§4-5, §10-1). Порядок ошибок architecture §8:
   * NOT_FOUND → APPROVE_OWN_REQUEST/NOT_APPROVER → ALREADY_PROCESSED → APPROVE_INSUFFICIENT_BALANCE.
   */
  async decide(
    viewer: AuthUser,
    id: number,
    decision: Decision,
    rawComment?: string | null,
  ): Promise<VacationView> {
    const now = await this.clock.now();
    const today = companyToday(now, companyTz(this.env));
    const comment = rawComment?.trim() || null;

    // Сотрудник заявки читается до блокировки: employeeId заявки не меняется (architecture §6)
    const head = await this.prisma.vacation.findUnique({
      where: { id },
      select: { employeeId: true },
    });
    if (!head || !(await this.org.canSee(viewer, head.employeeId))) {
      throw notFound();
    }

    let view: VacationView;
    try {
      view = await this.prisma.$transaction(async (tx) => {
        const [employee] = await tx.$queryRaw<
          { id: number; hireDate: Date; managerId: number | null }[]
        >`SELECT id, "hireDate", "managerId" FROM "User"
          WHERE id = ${head.employeeId} FOR NO KEY UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Vacation" WHERE id = ${id} FOR NO KEY UPDATE`;
        const hrId = await this.org.hrId(tx);

        const actor = actorError(viewer.id, employee, hrId);
        if (actor) throw toApiError(actor);

        // перечитывание после захвата (architecture §6 п.2)
        const row = await tx.vacation.findUniqueOrThrow({ where: { id } });
        if (row.status !== VacationStatus.PENDING) throw alreadyProcessed();

        if (decision === 'approve') {
          // RULES §4-3: остаток повторно, по той же формуле «доступно на дату начала»
          const available = await this.balance.availableOnDays(
            { id: employee.id, hireDate: fromDbDate(employee.hireDate) },
            today,
            fromDbDate(row.startDate),
            tx,
          );
          const block = approveBlock(available, row.workDays);
          if (block) throw toApiError(block);
          // RULES §4-4, §6-6: весь отпуск списывается сразу, момент по Clock
          await tx.ledgerEntry.create({
            data: {
              kind: LedgerKind.DEBIT,
              vacationId: id,
              halfDays: row.workDays * 2,
              occurredAt: now,
            },
          });
        }

        const updated = await tx.vacation.update({
          where: { id },
          data: {
            status:
              decision === 'approve'
                ? VacationStatus.APPROVED
                : VacationStatus.REJECTED,
            decidedById: viewer.id,
            decidedAt: now,
            decisionComment: comment,
          },
          include: VACATION_INCLUDE,
        });
        // письмо о решении в той же транзакции (RULES §8-2, §10-1; architecture §4, §9)
        if (decision === 'approve') {
          await this.approvedHook.onVacationApproved(tx, updated);
        } else {
          await enqueueDecisionMail(tx, updated);
        }
        return toVacationView(updated, { id: viewer.id, hrId });
      });
    } catch (e) {
      // последняя линия: второе списание по заявке запрещает БД (architecture §6 п.5)
      if (isDuplicateDebit(e)) throw alreadyProcessed();
      throw e;
    }

    if (decision === 'approve') {
      this.events.publish({
        type: 'vacation.approved',
        employeeId: view.employee.id,
        vacationId: view.id,
      });
    }
    return view;
  }

  private async availableOnStart(
    row: VacationRow,
    today: CalendarDate,
  ): Promise<number> {
    const { hireDate } = await this.prisma.user.findUniqueOrThrow({
      where: { id: row.employeeId },
      select: { hireDate: true },
    });
    return this.balance.availableOnDays(
      { id: row.employeeId, hireDate: fromDbDate(hireDate) },
      today,
      fromDbDate(row.startDate),
    );
  }

  /** Одобренные отпуска команды на пересекающиеся даты (RULES §4-6; architecture §5). */
  private async overlaps(row: VacationRow): Promise<ApprovalItem['overlaps']> {
    const owner = overlapOwner(row.employee);
    const team = [owner, ...(await this.org.directReportIds(owner))];
    const approved = await this.prisma.vacation.findMany({
      where: {
        employeeId: { in: team },
        status: VacationStatus.APPROVED,
        startDate: { lte: row.endDate },
        endDate: { gte: row.startDate },
      },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        employee: { select: { id: true, fullName: true } },
      },
    });
    const periods = approved.map((v) => ({
      id: v.id,
      employee: v.employee,
      startDate: fromDbDate(v.startDate),
      endDate: fromDbDate(v.endDate),
    }));
    const target = {
      id: row.id,
      startDate: fromDbDate(row.startDate),
      endDate: fromDbDate(row.endDate),
    };
    return overlapsWith(target, periods).map((v) => ({
      vacationId: v.id,
      employee: v.employee,
      startDate: v.startDate,
      endDate: v.endDate,
    }));
  }
}
