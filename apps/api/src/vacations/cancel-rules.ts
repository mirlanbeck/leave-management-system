// Правила отмены и отзыва (RULES §5) без БД и Nest. Факты собирает VacationsService под
// блокировкой; эти же функции дают подсказку `actions` (vacation.mapper).
import { MESSAGES as COMMON } from '../common/problem';
import { compareDates, type CalendarDate } from '../domain';
import { VacationStatus } from '../generated/prisma/enums';

export interface ActionError {
  status: number;
  code: string;
  message: string;
}

/** Тексты каталога (architecture §8, «Перенос, отмена, отзыв»). */
export const CANCEL_MESSAGES = {
  // DECISIONS 2026-10-28 15:46
  CANCEL_STARTED_BY_EMPLOYEE:
    'Отпуск уже начался: отменить его сами вы не можете',
  CANCEL_PENDING_AFTER_START:
    'Заявка ждёт решения, а отпуск уже должен был начаться: её нельзя отменить, согласующий одобрит или отклонит её',
  RECALL_NOT_STARTED:
    'Отпуск ещё не начался: до начала его отменяет только сотрудник',
  RECALL_NOT_APPROVED: 'Отозвать можно только одобренный отпуск',
  // DECISIONS 2026-10-28 15:41
  RECALL_FINISHED: 'Отпуск уже закончился: отозвать из него нельзя',
  RECALL_DATE_OUT_OF_RANGE:
    'Дата выхода должна быть между датой начала и датой окончания отпуска включительно',
  PENDING_TRANSFER_BLOCKS:
    'Пока перенос ждёт решения, отпуск нельзя отменить или отозвать: сначала отмените перенос',
} as const;

const fail = (
  status: number,
  code: keyof typeof CANCEL_MESSAGES,
): ActionError => ({ status, code, message: CANCEL_MESSAGES[code] });
export const forbidden = (): ActionError => ({
  status: 403,
  code: 'FORBIDDEN',
  message: COMMON.FORBIDDEN,
});
export const alreadyProcessed = (): ActionError => ({
  status: 409,
  code: 'ALREADY_PROCESSED',
  message: COMMON.ALREADY_PROCESSED,
});

/** Отпуск начался, если сегодня ≥ даты начала по часам компании (RULES §5-9). */
export const hasStarted = (startDate: CalendarDate, today: CalendarDate) =>
  compareDates(today, startDate) >= 0;

export interface CancelFacts {
  actorId: number;
  employeeId: number;
  status: VacationStatus;
  startDate: CalendarDate;
  today: CalendarDate;
  /** Есть заявка-перенос этой заявки «На согласовании» (RULES §3-11). */
  transferPending: boolean;
}

/**
 * Отмена владельцем до начала (RULES §5-4, §5-7, §5-10). Порядок проверок DECISIONS
 * 2026-10-28 15:41: не владелец → уже обработана → ждёт перенос → начался. HR над своим
 * отпуском - владелец.
 */
export function cancelError(f: CancelFacts): ActionError | null {
  if (f.actorId !== f.employeeId) return forbidden();
  if (
    f.status !== VacationStatus.PENDING &&
    f.status !== VacationStatus.APPROVED
  ) {
    return alreadyProcessed();
  }
  // RULES §5-2, §5-3: сначала отменяется перенос, затем, при необходимости, сам отпуск
  if (f.transferPending) return fail(409, 'PENDING_TRANSFER_BLOCKS');
  if (hasStarted(f.startDate, f.today)) {
    return f.status === VacationStatus.APPROVED
      ? fail(403, 'CANCEL_STARTED_BY_EMPLOYEE')
      : fail(422, 'CANCEL_PENDING_AFTER_START');
  }
  return null;
}

export interface RecallFacts {
  actorIsHr: boolean;
  status: VacationStatus;
  startDate: CalendarDate;
  endDate: CalendarDate;
  today: CalendarDate;
  returnDate: CalendarDate;
  /** Есть заявка-перенос этой заявки «На согласовании» (RULES §3-11). */
  transferPending: boolean;
}

/** Состояние отпуска без даты выхода: можно ли отзывать его сейчас (для `actions`). */
export function recallStateError(
  f: Omit<RecallFacts, 'returnDate'>,
): ActionError | null {
  if (!f.actorIsHr) return forbidden();
  if (
    f.status === VacationStatus.CANCELLED ||
    f.status === VacationStatus.REPLACED
  ) {
    return alreadyProcessed();
  }
  if (f.status !== VacationStatus.APPROVED) {
    return fail(422, 'RECALL_NOT_APPROVED'); // «На согласовании», «Отклонена»
  }
  if (!hasStarted(f.startDate, f.today)) return fail(422, 'RECALL_NOT_STARTED');
  if (compareDates(f.today, f.endDate) > 0) return fail(422, 'RECALL_FINISHED');
  // RULES §5-3: запрет действует и для HR, в том числе в начавшемся отпуске
  if (f.transferPending) return fail(409, 'PENDING_TRANSFER_BLOCKS');
  return null;
}

/**
 * Отзыв HR из идущего отпуска (RULES §5-5, §5-11). Порядок DECISIONS 2026-10-28 15:41:
 * не HR → уже обработана → не одобрена → не начался → закончился → ждёт перенос → дата выхода
 * вне отпуска.
 * Свой отпуск HR отзывает так же (DECISIONS 2026-10-28 15:41).
 */
export function recallError(f: RecallFacts): ActionError | null {
  const state = recallStateError(f);
  if (state) return state;
  if (
    compareDates(f.returnDate, f.startDate) < 0 ||
    compareDates(f.returnDate, f.endDate) > 0
  ) {
    return fail(422, 'RECALL_DATE_OUT_OF_RANGE');
  }
  return null;
}
