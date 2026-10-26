import {
  availableOn,
  checkVacationForm,
  compareDates,
  countWorkDays,
  type BalanceInput,
  type CalendarDate,
} from '../domain';

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

/**
 * Единственное место правил подачи (RULES §3): возвращает одну, первую по порядку
 * architecture §8 ошибку или `null`. Проверки формы - из домена (`checkVacationForm`),
 * остаток - доменный `availableOn` на дату начала; дни PENDING не резервируются (§3-9).
 */
export function evaluateSubmission(s: SubmissionInput): SubmissionError | null {
  if (s.backstopperId === null || s.backstopperId === undefined)
    return fail('BACKSTOPPER_REQUIRED'); // RULES §3-2
  if (s.backstopperId === s.employeeId) return fail('BACKSTOPPER_IS_SELF'); // RULES §3-3
  if (!s.backstopperExists) return fail('BACKSTOPPER_NOT_FOUND');

  const form = checkVacationForm({
    startDate: s.startDate,
    endDate: s.endDate,
    comment: s.comment,
    today: s.balance.today,
    hireDate: s.balance.hireDate,
  });
  if (form) return fail(form);

  // RULES §3-4 п.3: при нескольких пересечениях показывается самая ранняя по началу
  const overlap = s.active
    .filter(
      (v) =>
        compareDates(v.startDate, s.endDate) <= 0 &&
        compareDates(s.startDate, v.endDate) <= 0,
    )
    .sort((a, b) => compareDates(a.startDate, b.startDate) || a.id - b.id)[0];
  if (overlap) {
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
