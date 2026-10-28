import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toProblem, type ApiProblem } from '../api/problem';
import type { Vacation } from '../api/types';
import { decideThenReload, oneAtATime, type DecisionOutcome } from '../approvals/approval-logic';
import { ErrorBox } from '../components/ErrorBox';
import { formatHireDate as formatDate } from '../profile/format';
import { latestOnly } from './balance-logic';
import { canCancel, cancelConfirmText, cancelSuccessText } from './cancel-logic';
import { statusLabel } from './status';

interface Props {
  reloadKey: number;
  /**
   * Есть - в строках «Отменить» (RULES §5-4), после отмены вызывается, чтобы страница перечитала
   * список и остаток. Нет - список только для чтения (раздел HR на «Согласовании», DECISIONS [S5]).
   */
  onCancelled?: () => void;
}

/**
 * Заявки вошедшего: даты, рабочие дни, статус по-русски (RULES §3-11).
 * Порядок как у сервера, новые первыми (DECISIONS 2026-10-26 10:47). Смена reloadKey перечитывает список.
 */
export function MyRequests({ reloadKey, onCancelled }: Props) {
  const [items, setItems] = useState<Vacation[] | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DecisionOutcome | null>(null);
  const take = useMemo(() => latestOnly(), []);
  const guard = useMemo(() => oneAtATime(), []);

  useEffect(() => {
    const isLatest = take();
    api
      .get<Vacation[]>('/vacations?scope=mine')
      .then((list) => {
        if (!isLatest()) return;
        setItems(list);
        setError(null);
      })
      .catch((e: unknown) => {
        if (isLatest()) setError(toProblem(e));
      });
  }, [reloadKey, take]);

  // одна отмена за раз, повторный клик запрос не шлёт (RULES §10-1)
  function cancel(v: Vacation) {
    if (!onCancelled) return;
    void guard(async () => {
      setBusy(true);
      try {
        const result = await decideThenReload(
          () => api.post(`/vacations/${v.id}/cancel`, {}),
          onCancelled,
          cancelSuccessText(v),
        );
        setOutcome(result);
        setConfirmId(null);
      } finally {
        setBusy(false);
      }
    });
  }

  const withActions = onCancelled !== undefined;

  return (
    <section className="panel" aria-label="Мои заявки">
      <h2>Мои заявки</h2>
      {outcome && (
        <p role="status" data-testid="requests-outcome" className={outcome.tone === 'ok' ? 'notice' : 'error'}>
          {outcome.text}
        </p>
      )}
      {items === null && error === null && <p className="muted">Загрузка…</p>}
      {items?.length === 0 && (
        <p className="muted" data-testid="my-requests-empty">
          Заявок пока нет
        </p>
      )}
      {items && items.length > 0 && (
        <table className="requests">
          <thead>
            <tr>
              <th>Начало</th>
              <th>Окончание</th>
              <th>Рабочие дни</th>
              <th>Статус</th>
              {withActions && <th>Действие</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.id} data-testid="my-request-row">
                <td>{formatDate(v.startDate)}</td>
                <td>{formatDate(v.endDate)}</td>
                <td>{v.workDays}</td>
                <td>{statusLabel(v.status)}</td>
                {withActions && (
                  <td>
                    {canCancel(v) && confirmId !== v.id && (
                      <button type="button" disabled={busy} onClick={() => setConfirmId(v.id)}>
                        Отменить
                      </button>
                    )}
                    {canCancel(v) && confirmId === v.id && (
                      <div className="confirm" data-testid="cancel-confirm">
                        <span>{cancelConfirmText(v)}</span>
                        <div className="decision-buttons">
                          <button type="button" disabled={busy} onClick={() => cancel(v)}>
                            Да, отменить
                          </button>
                          <button type="button" disabled={busy} onClick={() => setConfirmId(null)}>
                            Не отменять
                          </button>
                        </div>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && (
        <div data-testid="requests-error">
          <ErrorBox problem={error} />
        </div>
      )}
    </section>
  );
}
