import { describe, expect, it } from 'vitest';
import type { CalendarEntry } from '../api/types';
import {
  calendarPath,
  daysInMonth,
  entryOn,
  entryText,
  gridRows,
  monthDays,
  monthOf,
  monthParam,
  monthTitle,
  parseMonth,
  scopeCaption,
  shiftMonth,
} from './calendar-logic';

const entry = (
  id: number,
  employeeId: number,
  fullName: string,
  startDate: string,
  endDate: string,
  teamName: string | null = 'Фронт-отдел',
): CalendarEntry => ({ vacationId: id, employee: { id: employeeId, fullName }, teamName, startDate, endDate });

describe('месяц календаря', () => {
  // RULES §9-1: месяц из ?month или из «сегодня» сервера, не из часов браузера
  it('?month=YYYY-MM разбирается; ерунда и отсутствие дают null (тогда текущий месяц)', () => {
    expect(parseMonth('2026-11')).toEqual({ year: 2026, month: 11 });
    expect(parseMonth(null)).toBeNull();
    expect(parseMonth('abc')).toBeNull();
    expect(parseMonth('2026-13')).toBeNull();
    expect(parseMonth('2026-00')).toBeNull();
    expect(parseMonth('2026-1')).toBeNull();
    expect(parseMonth('1999-12')).toBeNull();
    expect(monthOf('2026-10-21')).toEqual({ year: 2026, month: 10 });
  });

  // RULES §1-2
  it('переход между месяцами через границу года', () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2027, month: 1 }, -1)).toEqual({ year: 2026, month: 12 });
    expect(shiftMonth({ year: 2026, month: 10 }, 1)).toEqual({ year: 2026, month: 11 });
    expect(monthParam({ year: 2027, month: 1 })).toBe('2027-01');
    expect(monthTitle({ year: 2026, month: 11 })).toBe('Ноябрь 2026');
  });

  // RULES §1-2
  it('число дней: февраль високосного года, 30 и 31 день; запрос на весь месяц', () => {
    expect(daysInMonth({ year: 2028, month: 2 })).toBe(29);
    expect(daysInMonth({ year: 2026, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2100, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2000, month: 2 })).toBe(29);
    expect(daysInMonth({ year: 2026, month: 11 })).toBe(30);
    expect(calendarPath({ year: 2026, month: 2 })).toBe('/calendar?from=2026-02-01&to=2026-02-28');
  });

  // RULES §1-1: выходные — суббота и воскресенье
  it('дни недели и выходные ноября 2026 (1 ноября — воскресенье)', () => {
    const days = monthDays({ year: 2026, month: 11 });
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({ day: 1, iso: '2026-11-01', weekday: 'вс', weekend: true });
    expect(days[1]).toMatchObject({ weekday: 'пн', weekend: false });
    expect(days.filter((d) => d.weekend).map((d) => d.day)).toEqual([1, 7, 8, 14, 15, 21, 22, 28, 29]);
  });
});

describe('сетка и список', () => {
  // RULES §7-2
  it('строки — сотрудники с отпуском, по имени; два отпуска одного сотрудника в одной строке', () => {
    const rows = gridRows([
      entry(1, 7, 'Sophie Bennett', '2026-11-02', '2026-11-04'),
      entry(2, 6, 'James Walker', '2026-11-09', '2026-11-13'),
      entry(3, 7, 'Sophie Bennett', '2026-11-23', '2026-11-24'),
    ]);
    expect(rows.map((r) => r.employee.fullName)).toEqual(['James Walker', 'Sophie Bennett']);
    expect(rows[1].entries.map((e) => e.vacationId)).toEqual([1, 3]);
  });

  // RULES §7-2
  it('отпуск на стыке месяцев закрашивает только дни внутри месяца, даты в нём полные', () => {
    const [row] = gridRows([entry(1, 6, 'James Walker', '2026-10-28', '2026-11-03')]);
    const covered = monthDays({ year: 2026, month: 11 })
      .filter((d) => entryOn(row, d.iso))
      .map((d) => d.day);
    expect(covered).toEqual([1, 2, 3]);
    expect(entryText(row.entries[0])).toBe('James Walker, Фронт-отдел: 28.10.2026–03.11.2026');
  });

  // RULES §7-2: команда пустая у руководителей и выше
  it('без команды в списке только имя', () => {
    expect(entryText(entry(1, 4, 'Daniel Brooks', '2026-11-16', '2026-11-20', null))).toBe(
      'Daniel Brooks: 16.11.2026–20.11.2026',
    );
  });

  // RULES §7-2
  it('подпись по роли: сотрудник, руководитель, HR', () => {
    expect(scopeCaption({ isHr: false, isManager: false })).toBe('Мои отпуска');
    expect(scopeCaption({ isHr: false, isManager: true })).toBe('Я и моя команда');
    expect(scopeCaption({ isHr: true, isManager: false })).toBe('Вся компания');
  });
});
