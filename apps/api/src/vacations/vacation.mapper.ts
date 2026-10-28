import { fromDbDate, type CalendarDate } from '../domain';
import type { Prisma } from '../generated/prisma/client';
import { VacationStatus } from '../generated/prisma/enums';
import { canDecide } from '../org/policy';
import { cancelError, recallStateError } from './cancel-rules';

/** Что читается из БД для ответа: заявка, имена участников и статусы преемников (переносов). */
export const VACATION_INCLUDE = {
  // managerId нужен для `actions` (кто согласует); в ответ не попадает
  employee: { select: { id: true, fullName: true, managerId: true } },
  backstopper: { select: { id: true, fullName: true } },
  decidedBy: { select: { id: true, fullName: true } },
  replacedBy: { select: { status: true } },
} satisfies Prisma.VacationInclude;

export type VacationRow = Prisma.VacationGetPayload<{
  include: typeof VACATION_INCLUDE;
}>;

interface PersonView {
  id: number;
  fullName: string;
}

/** Схема `Vacation` из architecture §7. */
export interface VacationView {
  id: number;
  employee: PersonView;
  backstopper: PersonView;
  startDate: CalendarDate;
  endDate: CalendarDate;
  workDays: number;
  status: VacationStatus;
  comment: string | null;
  replacesId: number | null;
  createdAt: string;
  decidedBy: PersonView | null;
  decidedAt: string | null;
  decisionComment: string | null;
  cancelledAt: string | null;
  returnDate: CalendarDate | null;
  transferPending: boolean;
  oldVacationKept: boolean;
  actions: VacationAction[];
}

export type VacationAction =
  'cancel' | 'transfer' | 'recall' | 'approve' | 'reject';

/** Кто смотрит на заявку: для подсказки `actions` (architecture §7). */
export interface Viewer {
  id: number;
  isHr: boolean;
  /** id HR из OrgService.hrId: согласующий заявок директора. */
  hrId: number;
  /** «Сегодня» по Clock и COMPANY_TZ: от него зависят отмена и отзыв (RULES §5-9). */
  today: CalendarDate;
}

/**
 * Подсказка интерфейсу, что разрешено зрителю сейчас; права проверяет сервер теми же правилами.
 * approve/reject - согласующему, пока заявка PENDING (RULES §4-1, §4-2); cancel - владельцу до
 * начала (§5-4); recall - HR, пока одобренный отпуск идёт (§5-5). Перенос - S6b.
 */
export function actionsFor(row: VacationRow, viewer: Viewer): VacationAction[] {
  const actions: VacationAction[] = [];
  if (
    row.status === VacationStatus.PENDING &&
    canDecide(viewer.id, row.employee, viewer.hrId)
  ) {
    actions.push('approve', 'reject');
  }
  const startDate = fromDbDate(row.startDate);
  const cancel = cancelError({
    actorId: viewer.id,
    employeeId: row.employeeId,
    status: row.status,
    startDate,
    today: viewer.today,
  });
  if (!cancel) actions.push('cancel');
  const recall = recallStateError({
    actorIsHr: viewer.isHr,
    status: row.status,
    startDate,
    endDate: fromDbDate(row.endDate),
    today: viewer.today,
  });
  if (!recall) actions.push('recall');
  return actions;
}

/** Пометки выводятся из данных (architecture §2), не хранятся. */
export function toVacationView(row: VacationRow, viewer: Viewer): VacationView {
  return {
    id: row.id,
    employee: { id: row.employee.id, fullName: row.employee.fullName },
    backstopper: row.backstopper,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
    workDays: row.workDays,
    status: row.status,
    comment: row.comment,
    replacesId: row.replacesId,
    createdAt: row.createdAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionComment: row.decisionComment,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    returnDate: row.returnDate ? fromDbDate(row.returnDate) : null,
    // RULES §3-11: «перенос на рассмотрении»
    transferPending:
      row.status === VacationStatus.APPROVED &&
      row.replacedBy.some((r) => r.status === VacationStatus.PENDING),
    // RULES §3-11: «Старый отпуск остаётся»
    oldVacationKept:
      row.replacesId !== null &&
      (row.status === VacationStatus.REJECTED ||
        row.status === VacationStatus.CANCELLED),
    actions: actionsFor(row, viewer),
  };
}
