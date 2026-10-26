import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { toProblem, type ApiProblem } from '../api/problem';
import type { EmployeeRef, Vacation } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { formatHireDate as formatDate } from '../profile/format';
import { singleFlight, toVacationInput, type VacationFormValues } from './submit-logic';

export const EMPTY_FORM: VacationFormValues = {
  startDate: '',
  endDate: '',
  backstopperId: '',
  comment: '',
};

/**
 * Форма заявки: даты, backstopper из справочника, комментарий (RULES §3-2, §3-3, §3-8).
 * Проверок на клиенте нет: ошибку объясняет сервер, она показывается с кодом (§3-4…§3-12).
 */
export function VacationForm(props: {
  values: VacationFormValues;
  onChange: (values: VacationFormValues) => void;
  onSubmitted: (vacation: Vacation) => void;
}) {
  const { values, onChange, onSubmitted } = props;
  const [employees, setEmployees] = useState<EmployeeRef[] | null>(null);
  const [loadError, setLoadError] = useState<ApiProblem | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [done, setDone] = useState<Vacation | null>(null);
  const [busy, setBusy] = useState(false);

  // Последние значения для запроса: singleFlight создаётся один раз
  const latest = useRef({ values, onSubmitted });
  latest.current = { values, onSubmitted };

  useEffect(() => {
    api
      .get<EmployeeRef[]>('/employees')
      .then(setEmployees)
      .catch((e: unknown) => setLoadError(toProblem(e)));
  }, []);

  const submit = useMemo(
    () =>
      singleFlight(async () => {
        setBusy(true);
        setError(null);
        setDone(null);
        try {
          const created = await api.post<Vacation>('/vacations', toVacationInput(latest.current.values));
          setDone(created);
          latest.current.onSubmitted(created);
        } catch (e) {
          setError(toProblem(e));
        } finally {
          setBusy(false);
        }
      }),
    [],
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(); // двойной клик не даёт второго запроса (RULES §10-1)
  }

  const set = (patch: Partial<VacationFormValues>) => onChange({ ...values, ...patch });

  return (
    <section className="panel" aria-label="Новая заявка">
      <h2>Новая заявка</h2>
      <form className="vacation-form" onSubmit={onSubmit}>
        <div className="dates-row">
          <label>
            Начало
            <input type="date" value={values.startDate} onChange={(e) => set({ startDate: e.target.value })} />
          </label>
          <label>
            Окончание
            <input type="date" value={values.endDate} onChange={(e) => set({ endDate: e.target.value })} />
          </label>
        </div>
        <label className="backstopper">
          Заменяющий (backstopper)
          <select value={values.backstopperId} onChange={(e) => set({ backstopperId: e.target.value })}>
            <option value="">— выберите —</option>
            {employees?.map((emp) => (
              <option key={emp.id} value={String(emp.id)}>
                {emp.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="comment">
          Комментарий
          <textarea rows={3} value={values.comment} onChange={(e) => set({ comment: e.target.value })} />
        </label>
        <button type="submit" disabled={busy}>
          Подать
        </button>
      </form>
      {loadError && <ErrorBox problem={loadError} />}
      {error && (
        <div data-testid="submit-error">
          <ErrorBox problem={error} />
        </div>
      )}
      {done && (
        <p role="status" data-testid="submit-done">
          Заявка подана: с {formatDate(done.startDate)} по {formatDate(done.endDate)}, рабочих дней: {done.workDays}.
          Статус «На согласовании».
        </p>
      )}
    </section>
  );
}
