import { fromDbDate, type CalendarDate } from '../domain';
import type { Prisma } from '../generated/prisma/client';
import { VacationStatus } from '../generated/prisma/enums';

/** Что читается из БД для ответа: заявка, имена участников и статусы преемников (переносов). */
export const VACATION_INCLUDE = {
  employee: { select: { id: true, fullName: true } },
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
  actions: string[];
}

/**
 * Пометки выводятся из данных (architecture §2), не хранятся. `actions` пока пуст: кнопки
 * согласования и отмены появятся вместе с самими действиями (S5, S6).
 */
export function toVacationView(row: VacationRow): VacationView {
  return {
    id: row.id,
    employee: row.employee,
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
    actions: [],
  };
}
