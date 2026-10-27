// Правила согласования (RULES §4) без БД и Nest. Факты собирает ApprovalsService под блокировкой.
import { MESSAGES } from '../common/problem';
import { compareDates, type CalendarDate } from '../domain';
import { canDecide, type OrgUser } from '../org/policy';
import { formatDays } from '../vacations/vacation-rules';

export interface ApprovalError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Может ли `actorId` решать по заявке сотрудника (RULES §4-1, §4-2). Автор заявки получает
 * APPROVE_OWN_REQUEST при любой роли (DECISIONS [S5]); остальные, кроме согласующего, NOT_APPROVER.
 */
export function actorError(
  actorId: number,
  employee: Pick<OrgUser, 'id' | 'managerId'>,
  hrId: number,
): ApprovalError | null {
  if (actorId === employee.id) {
    return {
      status: 403,
      code: 'APPROVE_OWN_REQUEST',
      message: MESSAGES.APPROVE_OWN_REQUEST,
    };
  }
  if (!canDecide(actorId, employee, hrId)) {
    return {
      status: 403,
      code: 'NOT_APPROVER',
      message: MESSAGES.NOT_APPROVER,
    };
  }
  return null;
}

/**
 * Чья команда входит в предупреждение о пересечениях (RULES §4-6; architecture §5): руководитель
 * сотрудника; у директора - сам директор (DECISIONS 2026-10-22 12:15). Команда = он и его прямые
 * подчинённые.
 */
export function overlapOwner(
  employee: Pick<OrgUser, 'id' | 'managerId'>,
): number {
  return employee.managerId ?? employee.id;
}

export interface Period {
  id: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
}

/** Отпуска, пересекающие даты заявки (границы включительно), кроме самой заявки; по началу. */
export function overlapsWith<T extends Period>(
  target: Period,
  candidates: readonly T[],
): T[] {
  return candidates
    .filter(
      (v) =>
        v.id !== target.id &&
        compareDates(v.startDate, target.endDate) <= 0 &&
        compareDates(target.startDate, v.endDate) <= 0,
    )
    .sort((a, b) => compareDates(a.startDate, b.startDate) || a.id - b.id);
}

/**
 * Повторная проверка остатка при согласовании (RULES §4-3): `available` - «доступно на дату
 * начала» (§3-10), дни в днях. Текст оформлен как при подаче (DECISIONS 2026-10-26 10:47).
 */
export function approveBlock(
  available: number,
  requested: number,
): ApprovalError | null {
  if (requested <= available) return null;
  return {
    status: 422,
    code: 'APPROVE_INSUFFICIENT_BALANCE',
    message: `Согласовать нельзя: осталось ${formatDays(available)} дней, в заявке ${formatDays(requested)}`,
    details: { available, requested },
  };
}
