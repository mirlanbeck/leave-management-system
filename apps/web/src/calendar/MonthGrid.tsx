import type { CalendarEntry } from '../api/types';
import { periodText } from '../approvals/approval-logic';
import { entryOn, entryText, gridRows, monthDays, type Month } from './calendar-logic';

/**
 * Сетка месяца: строки — сотрудники с одобренным отпуском, столбцы — дни, выходные затенены.
 * Отпуск на стыке месяцев закрашен в пределах месяца, полные даты — в подсказке и в списке.
 */
export function MonthGrid({ month, entries }: { month: Month; entries: CalendarEntry[] }) {
  const days = monthDays(month);
  return (
    <div className="calendar-scroll">
      <table className="calendar-grid" data-testid="calendar-grid">
        <thead>
          <tr>
            <th scope="col">Сотрудник</th>
            {days.map((d) => (
              <th key={d.iso} scope="col" className={d.weekend ? 'weekend' : undefined}>
                {d.day}
                <br />
                <small>{d.weekday}</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {gridRows(entries).map((row) => (
            <tr key={row.employee.id} data-testid="calendar-row">
              <th scope="row">{row.employee.fullName}</th>
              {days.map((d) => {
                const e = entryOn(row, d.iso);
                const cls = [e ? 'on-vacation' : '', d.weekend ? 'weekend' : ''].filter(Boolean).join(' ');
                return (
                  <td
                    key={d.iso}
                    className={cls || undefined}
                    title={e ? `${row.employee.fullName}: ${periodText(e.startDate, e.endDate)}` : undefined}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Список отпусков месяца с полными датами: читается скринридером и проверяется e2e. */
export function EntryList({ entries }: { entries: CalendarEntry[] }) {
  return (
    <section aria-label="Отпуска в этом месяце">
      <h2>Отпуска в этом месяце</h2>
      <ul className="calendar-entries">
        {entries.map((e) => (
          <li key={e.vacationId} data-testid="calendar-entry">
            {entryText(e)}
          </li>
        ))}
      </ul>
    </section>
  );
}
