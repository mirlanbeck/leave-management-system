import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { describeProblem, toProblem, type ApiProblem } from '../api/problem';
import { ErrorBox } from '../components/ErrorBox';
import {
  companyDate,
  DEFAULT_TIME,
  formatCompanyMoment,
  loadStrip,
  setClock,
  type StripData,
} from './clock-logic';

type State = { kind: 'loading' } | { kind: 'error'; problem: ApiProblem } | StripData;

/** Постоянная полоса демо-часов для вошедших при demoMode (RULES §9-2, §9-3). */
export function DemoClockStrip() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      setState(await loadStrip(api));
    } catch (e) {
      setState({ kind: 'error', problem: toProblem(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading' || state.kind === 'off') return null;
  if (state.kind === 'error') {
    return (
      <div className="clock-strip clock-strip-error" data-testid="clock-config-error">
        <span>Не удалось загрузить конфигурацию: {describeProblem(state.problem)}</span>
        <button type="button" onClick={() => void load()}>
          Повторить
        </button>
      </div>
    );
  }
  return (
    <ClockForm
      companyTz={state.companyTz}
      now={state.now}
      onChange={(now) => setState({ ...state, now })}
    />
  );
}

function ClockForm(props: { companyTz: string; now: string; onChange: (now: string) => void }) {
  const { companyTz, now, onChange } = props;
  const [date, setDate] = useState(() => companyDate(now, companyTz));
  const [time, setTime] = useState(DEFAULT_TIME);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const view = await setClock(api, date, time);
      onChange(view.now);
    } catch (err) {
      setError(toProblem(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="clock-strip" data-testid="clock-strip">
      <span>
        Дата/время: <strong data-testid="clock-value">{formatCompanyMoment(now, companyTz)}</strong> ({companyTz}),{' '}
        <span data-testid="clock-frozen">остановлены</span>
      </span>
      <form onSubmit={onSubmit}>
        <input
          type="date"
          aria-label="Дата"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <input
          type="time"
          aria-label="Время"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          Установить
        </button>
      </form>
      {error && <ErrorBox problem={error} />}
    </div>
  );
}
