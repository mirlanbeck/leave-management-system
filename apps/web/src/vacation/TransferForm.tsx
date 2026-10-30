import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { toProblem, type ApiProblem } from '../api/problem';
import type { EmployeeRef, Vacation } from '../api/types';
import { COMMENT_MAX_LENGTH } from '../components/comment';
import { ErrorBox } from '../components/ErrorBox';
import { singleFlight, toVacationInput, type VacationFormValues } from './submit-logic';
import { initialTransferForm, transferHint } from './transfer-logic';

interface Props {
  vacation: Vacation;
  onTransferred: (created: Vacation) => void;
  onClose: () => void;
}

/**
 * Форма «Перенести» в строке «Моих заявок» (RULES §5-2; DECISIONS 2026-10-28 17:06): новые даты,
 * backstopper старого отпуска подставлен, комментарий необязателен. Проверок на клиенте нет:
 * причину объясняет сервер, ошибка остаётся в форме, чтобы поправить даты.
 */
export function TransferForm({ vacation, onTransferred, onClose }: Props) {
  const [values, setValues] = useState<VacationFormValues>(() => initialTransferForm(vacation));
  const [employees, setEmployees] = useState<EmployeeRef[] | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);

  // Последние значения для запроса: singleFlight создаётся один раз
  const latest = useRef({ values, onTransferred });
  latest.current = { values, onTransferred };

  useEffect(() => {
    api
      .get<EmployeeRef[]>('/employees')
      .then(setEmployees)
      .catch((e: unknown) => setError(toProblem(e)));
  }, []);

  const send = useMemo(
    () =>
      singleFlight(async () => {
        setBusy(true);
        setError(null);
        try {
          const created = await api.post<Vacation>(
            `/vacations/${vacation.id}/transfer`,
            toVacationInput(latest.current.values),
          );
          latest.current.onTransferred(created);
        } catch (e) {
          setError(toProblem(e));
        } finally {
          setBusy(false);
        }
      }),
    [vacation.id],
  );

  const set = (patch: Partial<VacationFormValues>) => setValues((v) => ({ ...v, ...patch }));
  const id = (field: string) => `transfer-${field}-${vacation.id}`;

  return (
    <div className="confirm transfer-form" data-testid="transfer-form">
      <div className="dates-row">
        <label htmlFor={id('start')}>Начало</label>
        <input
          id={id('start')}
          type="date"
          value={values.startDate}
          onChange={(e) => set({ startDate: e.target.value })}
        />
        <label htmlFor={id('end')}>Окончание</label>
        <input id={id('end')} type="date" value={values.endDate} onChange={(e) => set({ endDate: e.target.value })} />
      </div>
      <label htmlFor={id('backstopper')}>Заменяющий (backstopper)</label>
      <select
        id={id('backstopper')}
        value={values.backstopperId}
        onChange={(e) => set({ backstopperId: e.target.value })}
      >
        <option value="">— выберите —</option>
        {/* до загрузки справочника подставленный backstopper виден по имени из заявки */}
        {(employees ?? [vacation.backstopper]).map((emp) => (
          <option key={emp.id} value={String(emp.id)}>
            {emp.fullName}
          </option>
        ))}
      </select>
      <label htmlFor={id('comment')}>Комментарий (необязательно)</label>
      <textarea
        id={id('comment')}
        rows={2}
        maxLength={COMMENT_MAX_LENGTH}
        value={values.comment}
        onChange={(e) => set({ comment: e.target.value })}
      />
      <span className="muted">{transferHint(vacation.workDays)}</span>
      <div className="decision-buttons">
        {/* двойной клик не даёт второго запроса (RULES §10-1) */}
        <button type="button" disabled={busy} onClick={() => void send()}>
          Отправить перенос
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Закрыть
        </button>
      </div>
      {error && (
        <div data-testid="transfer-error">
          <ErrorBox problem={error} />
        </div>
      )}
    </div>
  );
}
