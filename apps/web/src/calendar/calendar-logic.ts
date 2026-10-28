import type { CalendarEntry, EmployeeRef } from '../api/types';
import type { RoleFlags } from '../routes/access';
import { periodText } from '../approvals/approval-logic';

/** Месяц календаря; month 1–12. «Сегодня» даёт сервер, время браузера не используется (RULES §9-1). */
export interface Month {
  year: number;
  month: number;
}

const MONTH_NAMES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// те же границы годов, что у дат во входе API (architecture §7)
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const pad = (n: number) => String(n).padStart(2, '0');

/** `?month=YYYY-MM`; неверное значение или его отсутствие дают null (тогда текущий месяц). */
export function parseMonth(value: string | null): Month | null {
  const m = value === null ? null : /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || year < MIN_YEAR || year > MAX_YEAR) return null;
  return { year, month };
}

/** Месяц календарной даты YYYY-MM-DD («сегодня» с сервера). */
export function monthOf(date: string): Month {
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) };
}

export function monthParam(m: Month): string {
  return `${m.year}-${pad(m.month)}`;
}

export function shiftMonth(m: Month, delta: number): Month {
  const index = m.year * 12 + (m.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(m: Month): number {
  if (m.month === 2) return isLeap(m.year) ? 29 : 28;
  return [4, 6, 9, 11].includes(m.month) ? 30 : 31;
}

export function isoDate(m: Month, day: number): string {
  return `${m.year}-${pad(m.month)}-${pad(day)}`;
}

/** Диапазон запроса GET /calendar: первый и последний день месяца. */
export function monthRange(m: Month): { from: string; to: string } {
  return { from: isoDate(m, 1), to: isoDate(m, daysInMonth(m)) };
}

export function calendarPath(m: Month): string {
  const { from, to } = monthRange(m);
  return `/calendar?from=${from}&to=${to}`;
}

export function monthTitle(m: Month): string {
  return `${MONTH_NAMES[m.month - 1]} ${m.year}`;
}

export interface DayCell {
  day: number;
  iso: string;
  weekday: string;
  weekend: boolean;
}

/** Дни месяца с днём недели; Date.UTC с аргументами - календарная арифметика, не часы браузера. */
export function monthDays(m: Month): DayCell[] {
  const cells: DayCell[] = [];
  for (let day = 1; day <= daysInMonth(m); day += 1) {
    const dow = new Date(Date.UTC(m.year, m.month - 1, day)).getUTCDay();
    cells.push({ day, iso: isoDate(m, day), weekday: WEEKDAYS[dow], weekend: dow === 0 || dow === 6 });
  }
  return cells;
}

export interface GridRow {
  employee: EmployeeRef;
  /** Отпуска сотрудника в этом месяце (полные даты; на сетке закрашивается часть внутри месяца). */
  entries: CalendarEntry[];
}

/** Строки сетки: сотрудники с одобренным отпуском в месяце, по имени (DECISIONS [S5]). */
export function gridRows(entries: CalendarEntry[]): GridRow[] {
  const byId = new Map<number, GridRow>();
  for (const e of entries) {
    const row = byId.get(e.employee.id);
    if (row) row.entries.push(e);
    else byId.set(e.employee.id, { employee: e.employee, entries: [e] });
  }
  return [...byId.values()].sort(
    (a, b) => a.employee.fullName.localeCompare(b.employee.fullName, 'ru') || a.employee.id - b.employee.id,
  );
}

/** Отпуск, закрывающий день `iso`, или undefined. */
export function entryOn(row: GridRow, iso: string): CalendarEntry | undefined {
  return row.entries.find((e) => e.startDate <= iso && iso <= e.endDate);
}

/** Подпись под заголовком по тому, кого показывает календарь (RULES §7-2). */
export function scopeCaption(flags: RoleFlags): string {
  if (flags.isHr) return 'Вся компания';
  if (flags.isManager) return 'Я и моя команда';
  return 'Мои отпуска';
}

/** Строка списка под сеткой; команда пустая у руководителей и выше - тогда только имя. */
export function entryText(e: CalendarEntry): string {
  const who = e.teamName ? `${e.employee.fullName}, ${e.teamName}` : e.employee.fullName;
  return `${who}: ${periodText(e.startDate, e.endDate)}`;
}
