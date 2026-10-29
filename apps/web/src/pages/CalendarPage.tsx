import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { toProblem, type ApiProblem } from '../api/problem';
import type { Balance, Calendar, CalendarEntry } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import {
  calendarPath,
  monthOf,
  monthParam,
  monthTitle,
  parseMonth,
  shiftMonth,
  splitEntries,
  teamCaption,
  type Month,
} from '../calendar/calendar-logic';
import { EntryList, MonthGrid } from '../calendar/MonthGrid';
import { TeamBalances } from '../calendar/TeamBalances';
import { ErrorBox } from '../components/ErrorBox';
import { latestOnly } from '../vacation/balance-logic';

/**
 * Календарь (RULES §7-2, §3-11): только одобренные отпуска, кого показать, решает сервер.
 * Два блока: «Мои отпуска» сверху, календарь команды снизу (своих в нём нет).
 * Месяц в `?month=YYYY-MM`, без него — текущий по «сегодня» сервера (GET /me/balance, RULES §9-1).
 * Данные обновляются при перезагрузке и переходе; без перезагрузки — S8 (DECISIONS [S5]).
 */
export function CalendarPage() {
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const [today, setToday] = useState<string | null>(null);
  const [data, setData] = useState<{ month: string; calendar: Calendar } | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const take = useMemo(() => latestOnly(), []);

  const requested = parseMonth(params.get('month'));
  const month: Month | null = requested ?? (today ? monthOf(today) : null);
  const key = month ? monthParam(month) : null;
  const path = month ? calendarPath(month) : null;

  useEffect(() => {
    api
      .get<Balance>('/me/balance')
      .then((b) => setToday(b.today))
      .catch((e: unknown) => setError(toProblem(e)));
  }, []);

  useEffect(() => {
    if (key === null || path === null) return;
    const isLatest = take();
    api
      .get<Calendar>(path)
      .then((calendar) => {
        if (!isLatest()) return;
        setData({ month: key, calendar });
        setError(null);
      })
      .catch((e: unknown) => {
        if (isLatest()) setError(toProblem(e));
      });
  }, [key, path, take]);

  const go = (delta: number) => {
    if (month) setParams({ month: monthParam(shiftMonth(month, delta)) });
  };
  const shown = data && data.month === key ? data.calendar : null;

  return (
    <section>
      <h1>Календарь</h1>
      {month && (
        <div className="calendar-nav">
          <button type="button" onClick={() => go(-1)}>
            ← Предыдущий месяц
          </button>
          <h2 data-testid="calendar-month">{monthTitle(month)}</h2>
          <button type="button" onClick={() => go(1)}>
            Следующий месяц →
          </button>
        </div>
      )}
      {!shown && !error && <p className="muted">Загрузка…</p>}
      {shown && month && profile && (
        <>
          <CalendarBlock
            testId="calendar-mine"
            title="Мои отпуска"
            month={month}
            entries={splitEntries(shown.entries, profile.id).mine}
          />
          <CalendarBlock
            testId="calendar-team"
            title={teamCaption(profile)}
            month={month}
            entries={splitEntries(shown.entries, profile.id).team}
          />
        </>
      )}
      {shown?.balances && today && <TeamBalances balances={shown.balances} today={today} />}
      {error && (
        <div data-testid="calendar-error">
          <ErrorBox problem={error} />
        </div>
      )}
    </section>
  );
}

/** Блок календаря: сетка и список или текст пустого месяца (RULES §7-2). */
function CalendarBlock({
  testId,
  title,
  month,
  entries,
}: {
  testId: string;
  title: string;
  month: Month;
  entries: CalendarEntry[];
}) {
  return (
    <div data-testid={testId}>
      <h3>{title}</h3>
      {entries.length === 0 ? (
        <p className="muted" data-testid="calendar-empty">
          В этом месяце отпусков нет
        </p>
      ) : (
        <>
          <MonthGrid month={month} entries={entries} />
          <EntryList entries={entries} />
        </>
      )}
    </div>
  );
}
