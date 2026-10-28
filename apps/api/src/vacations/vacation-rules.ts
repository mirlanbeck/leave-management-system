import {
  availableOn,
  checkPeriodShape,
  checkVacationForm,
  compareDates,
  countWorkDays,
  type BalanceInput,
  type CalendarDate,
} from '../domain';
import { VacationStatus } from '../generated/prisma/enums';
import {
  alreadyProcessed,
  forbidden,
  hasStarted,
  type ActionError,
} from './cancel-rules';

/** Активная (PENDING или APPROVED) заявка того же сотрудника (RULES §3-4 п.3). */
export interface ActiveVacation {
  id: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
}

/** Всё, что нужно для решения по подаче; факты из БД собирает сервис под блокировкой. */
export interface SubmissionInput {
  employeeId: number;
  backstopperId: number | null | undefined;
  /** Есть ли пользователь с `backstopperId` (для некорректного id - false без запроса). */
  backstopperExists: boolean;
  startDate: CalendarDate;
  endDate: CalendarDate;
  comment: string | null;
  /** Вход расчёта остатка из BalanceService: тот же, что у `/me/balance` (RULES §3-10). */
  balance: BalanceInput;
  active: readonly ActiveVacation[];
}

export interface SubmissionError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Тексты каталога (architecture §8, группа «Подача заявки», все 422). */
const MESSAGES = {
  BACKSTOPPER_REQUIRED: 'Укажите заменяющего сотрудника',
  BACKSTOPPER_IS_SELF: 'Нельзя указать себя заменяющим',
  BACKSTOPPER_NOT_FOUND: 'Заменяющий сотрудник не найден',
  VACATION_DATES_ORDER: 'Дата начала позже даты окончания',
  VACATION_CROSSES_YEAR:
    'Заявка не может охватывать два года, подайте две заявки',
  VACATION_NO_WORK_DAYS: 'В заявке нет ни одного рабочего дня',
  NO_ACCRUAL_YET: 'У вас ещё нет накопленных дней',
  VACATION_BEFORE_HIRE:
    'Дата начала отпуска раньше даты вашего выхода на работу',
  PAST_START_YEAR: 'Начало отпуска в прошлом году: такая заявка не принимается',
  PAST_COMMENT_REQUIRED:
    'Для отпуска с датой в прошлом укажите причину в комментарии',
  TRANSFER_START_IN_PAST:
    'Начало переноса не может быть раньше сегодняшней даты; для прошлых дат подайте обычную заявку',
} as const;

/** Тексты каталога о состоянии исходного отпуска (architecture §8, «Перенос, отмена, отзыв»). */
export const TRANSFER_MESSAGES = {
  TRANSFER_SOURCE_NOT_APPROVED: 'Перенести можно только одобренный отпуск',
  TRANSFER_STARTED: 'Отпуск уже начался, перенести его нельзя',
  TRANSFER_ALREADY_PENDING:
    'Перенос этого отпуска уже ждёт решения; повторно перенести отпуск нельзя',
} as const;

const fail = (code: keyof typeof MESSAGES): SubmissionError => ({
  code,
  message: MESSAGES[code],
});

/** Дни для текста: запятая, шаг 0,5, минус типографский (RULES §2-7, §6-4). */
export function formatDays(days: number): string {
  const text = String(Math.abs(days)).replace('.', ',');
  return days < 0 ? `−${text}` : text;
}

/** Backstopper обязателен, не сам заявитель и существует (RULES §3-2, §3-3). */
function backstopperError(s: {
  employeeId: number;
  backstopperId: number | null | undefined;
  backstopperExists: boolean;
}): SubmissionError | null {
  if (s.backstopperId === null || s.backstopperId === undefined)
    return fail('BACKSTOPPER_REQUIRED'); // RULES §3-2
  if (s.backstopperId === s.employeeId) return fail('BACKSTOPPER_IS_SELF'); // RULES §3-3
  if (!s.backstopperExists) return fail('BACKSTOPPER_NOT_FOUND');
  return null;
}

/** RULES §3-4 п.3: при нескольких пересечениях показывается самая ранняя по началу. */
function overlapError(
  startDate: CalendarDate,
  endDate: CalendarDate,
  active: readonly ActiveVacation[],
): SubmissionError | null {
  const overlap = active
    .filter(
      (v) =>
        compareDates(v.startDate, endDate) <= 0 &&
        compareDates(startDate, v.endDate) <= 0,
    )
    .sort((a, b) => compareDates(a.startDate, b.startDate) || a.id - b.id)[0];
  if (!overlap) return null;
  return {
    code: 'VACATION_OVERLAP',
    message: `У вас уже есть заявка на эти даты: с ${overlap.startDate} по ${overlap.endDate}`,
    details: {
      vacationId: overlap.id,
      from: overlap.startDate,
      to: overlap.endDate,
    },
  };
}

/**
 * Единственное место правил подачи (RULES §3): возвращает одну, первую по порядку
 * architecture §8 ошибку или `null`. Проверки формы - из домена (`checkVacationForm`),
 * остаток - доменный `availableOn` на дату начала; дни PENDING не резервируются (§3-9).
 */
export function evaluateSubmission(s: SubmissionInput): SubmissionError | null {
  const backstopper = backstopperError(s);
  if (backstopper) return backstopper;

  const form = checkVacationForm({
    startDate: s.startDate,
    endDate: s.endDate,
    comment: s.comment,
    today: s.balance.today,
    hireDate: s.balance.hireDate,
  });
  if (form) return fail(form);

  const overlap = overlapError(s.startDate, s.endDate, s.active);
  if (overlap) return overlap;

  // RULES §3-9: дни заявки не больше накопленного к дате начала
  const requested = countWorkDays(s.startDate, s.endDate);
  const available = availableOn(s.balance, s.startDate) / 2;
  if (requested > available) {
    return {
      code: 'INSUFFICIENT_BALANCE',
      message: `Не хватает дней: доступно ${formatDays(available)}, в заявке ${formatDays(requested)}`,
      details: { available, requested },
    };
  }
  return null;
}

/** Исходный отпуск переноса и тот, кто переносит; факты собирает сервис под блокировкой. */
export interface TransferSourceFacts {
  actorId: number;
  employeeId: number;
  status: VacationStatus;
  startDate: CalendarDate;
  today: CalendarDate;
  /** У отпуска уже есть заявка-перенос «На согласовании» (RULES §3-11). */
  transferPending: boolean;
}

/**
 * Можно ли переносить этот отпуск сейчас (RULES §5-1, §5-2); то же даёт подсказку `actions`.
 * Порядок DECISIONS 2026-10-28 17:06: не владелец → «Отменена»/«Заменена переносом» (уже
 * обработана) → не одобрена → перенос уже ждёт решения → начался.
 */
export function transferSourceError(
  f: TransferSourceFacts,
): ActionError | null {
  if (f.actorId !== f.employeeId) return forbidden();
  if (
    f.status === VacationStatus.CANCELLED ||
    f.status === VacationStatus.REPLACED
  ) {
    return alreadyProcessed(); // RULES §10-1
  }
  if (f.status !== VacationStatus.APPROVED) {
    return transferFail(422, 'TRANSFER_SOURCE_NOT_APPROVED'); // «На согласовании», «Отклонена»
  }
  if (f.transferPending) return transferFail(409, 'TRANSFER_ALREADY_PENDING'); // RULES §5-2
  if (hasStarted(f.startDate, f.today))
    return transferFail(422, 'TRANSFER_STARTED'); // RULES §5-1
  return null;
}

const transferFail = (
  status: number,
  code: keyof typeof TRANSFER_MESSAGES,
): ActionError => ({ status, code, message: TRANSFER_MESSAGES[code] });

/** Новые даты переноса; исходный отпуск в `active` не входит (RULES §5-2). */
export interface TransferInput {
  employeeId: number;
  backstopperId: number | null | undefined;
  backstopperExists: boolean;
  startDate: CalendarDate;
  endDate: CalendarDate;
  today: CalendarDate;
  /** Рабочие дни исходного отпуска. */
  sourceWorkDays: number;
  active: readonly ActiveVacation[];
}

/**
 * Правила новых дат переноса (RULES §5-2), все 422, порядок DECISIONS 2026-10-28 17:06.
 * Остаток, «до первого начисления», «в прошлом» и «раньше даты выхода» не проверяются
 * (RULES §3-12, §5-2; DECISIONS 2026-10-24 10:52 и 16:45).
 */
export function evaluateTransfer(t: TransferInput): SubmissionError | null {
  const backstopper = backstopperError(t);
  if (backstopper) return backstopper;

  const shape = checkPeriodShape(t.startDate, t.endDate);
  if (shape) return fail(shape);

  // RULES §5-2: начало не раньше сегодняшней даты; начало сегодня допустимо
  if (compareDates(t.startDate, t.today) < 0)
    return fail('TRANSFER_START_IN_PAST');

  // RULES §5-2: число рабочих дней то же, что у старого отпуска
  const requested = countWorkDays(t.startDate, t.endDate);
  if (requested !== t.sourceWorkDays) {
    return {
      code: 'TRANSFER_WORKDAYS_MISMATCH',
      message: `Число рабочих дней должно совпадать: было ${t.sourceWorkDays}, в заявке ${requested}`,
      details: { old: t.sourceWorkDays, requested },
    };
  }

  return overlapError(t.startDate, t.endDate, t.active);
}
