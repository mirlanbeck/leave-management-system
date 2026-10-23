import {
  accrualEvents,
  AccrualEvent,
  CARRYOVER_CAP_HALF_DAYS,
} from './accrual';
import { CalendarDate, dayOf } from './calendar-date';

/** Запись журнала: списание или возврат (RULES §6-6). `halfDays` ≥ 0, знак задаёт `kind`. */
export interface LedgerAction {
  kind: 'DEBIT' | 'REFUND';
  halfDays: number;
  occurredAt: Date;
}

export interface BalanceInput {
  hireDate: CalendarDate;
  ledger: readonly LedgerAction[];
  /** «Сегодня» по Clock и COMPANY_TZ (YYYY-MM-DD). */
  today: CalendarDate;
  /** Часовой пояс компании: по нему определяется день события журнала. */
  tz: string;
}

function applyEvent(balance: number, event: AccrualEvent): number {
  return event.kind === 'ACCRUAL'
    ? balance + event.halfDays
    : Math.min(balance, CARRYOVER_CAP_HALF_DAYS); // отрицательный остаток не обрезается
}

/**
 * Баланс сегодня в половинках дня (RULES §6-6): начисления и обрезки до сегодня включительно
 * и все записи журнала независимо от даты. Порядок дня: начисление, обрезка, действия;
 * действие попадает «до обрезки 1 января», если его день по `tz` строго раньше.
 */
export function balanceToday({
  hireDate,
  ledger,
  today,
  tz,
}: BalanceInput): number {
  const timeline = [
    ...accrualEvents(hireDate, today).map((e) => ({
      day: e.date,
      rank: e.kind === 'ACCRUAL' ? 0 : 1,
      apply: (b: number) => applyEvent(b, e),
    })),
    ...ledger.map((a) => ({
      day: dayOf(a.occurredAt, tz),
      rank: 2,
      apply: (b: number) =>
        a.kind === 'DEBIT' ? b - a.halfDays : b + a.halfDays,
    })),
  ].sort((x, y) =>
    x.day === y.day ? x.rank - y.rank : x.day < y.day ? -1 : 1,
  );
  return timeline.reduce((b, step) => step.apply(b), 0);
}

/**
 * «Доступно на дату D» в половинках дня (RULES §3-10): баланс сегодня плюс начисления и обрезки
 * на датах строго после сегодня и до D включительно. Для D ≤ сегодня — баланс сегодня.
 */
export function availableOn(input: BalanceInput, on: CalendarDate): number {
  const start = balanceToday(input);
  if (on <= input.today) return start;
  return accrualEvents(input.hireDate, on)
    .filter((e) => e.date > input.today)
    .reduce(applyEvent, start);
}
