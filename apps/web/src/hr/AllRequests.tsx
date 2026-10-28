import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toProblem, type ApiProblem } from '../api/problem';
import type { Vacation } from '../api/types';
import { decideThenReload, oneAtATime, type DecisionOutcome } from '../approvals/approval-logic';
import { ErrorBox } from '../components/ErrorBox';
import { formatHireDate as formatDate } from '../profile/format';
import { latestOnly } from '../vacation/balance-logic';
import { statusLabel } from '../vacation/status';
import { canRecall, marksText, recallBody, recallSuccessText } from './hr-logic';
import { RecallForm } from './RecallForm';

/**
 * «Все заявки» у HR (RULES §7-2): все заявки компании, статусы и пометки (§3-11), новые первыми.
 * Единственное действие - «Отзыв» над идущим одобренным отпуском (§5-5; DECISIONS 2026-10-22
 * 19:04, 2026-10-28 15:41). Итог - строкой над таблицей, список после отзыва перечитывается.
 */
export function AllRequests() {
  const [items, setItems] = useState<Vacation[] | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DecisionOutcome | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const take = useMemo(() => latestOnly(), []);
  const guard = useMemo(() => oneAtATime(), []);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const isLatest = take();
    api
      .get<Vacation[]>('/vacations?scope=all')
      .then((list) => {
        if (!isLatest()) return;
        setItems(list);
        setError(null);
      })
      .catch((e: unknown) => {
        if (isLatest()) setError(toProblem(e));
      });
  }, [reloadKey, take]);

  // один отзыв за раз, повторный клик запрос не шлёт (RULES §10-1)
  function recall(v: Vacation, returnDate: string) {
    void guard(async () => {
      setBusy(true);
      try {
        const result = await decideThenReload(
          () => api.post(`/vacations/${v.id}/recall`, recallBody(returnDate)),
          reload,
          recallSuccessText(v.employee.fullName, returnDate),
        );
        setOutcome(result);
        setOpenId(null);
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <section className="panel" aria-label="Все заявки">
      <h2>Все заявки</h2>
      {outcome && (
        <p role="status" data-testid="hr-requests-outcome" className={outcome.tone === 'ok' ? 'notice' : 'error'}>
          {outcome.text}
        </p>
      )}
      {items === null && error === null && <p className="muted">Загрузка…</p>}
      {items?.length === 0 && (
        <p className="muted" data-testid="hr-requests-empty">
          Заявок нет
        </p>
      )}
      {items && items.length > 0 && (
        <table className="requests">
          <thead>
            <tr>
              <th>Сотрудник</th>
              <th>Начало</th>
              <th>Окончание</th>
              <th>Рабочие дни</th>
              <th>Статус</th>
              <th>Пометки</th>
              <th>Действие</th>
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.id} data-testid="hr-request-row">
                <td>{v.employee.fullName}</td>
                <td>{formatDate(v.startDate)}</td>
                <td>{formatDate(v.endDate)}</td>
                <td>{v.workDays}</td>
                <td>{statusLabel(v.status)}</td>
                <td>{marksText(v)}</td>
                <td>
                  {canRecall(v) && openId !== v.id && (
                    <button type="button" disabled={busy} onClick={() => setOpenId(v.id)}>
                      Отзыв
                    </button>
                  )}
                  {canRecall(v) && openId === v.id && (
                    <RecallForm
                      vacation={v}
                      busy={busy}
                      onSubmit={(date) => recall(v, date)}
                      onClose={() => setOpenId(null)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && (
        <div data-testid="hr-requests-error">
          <ErrorBox problem={error} />
        </div>
      )}
    </section>
  );
}
