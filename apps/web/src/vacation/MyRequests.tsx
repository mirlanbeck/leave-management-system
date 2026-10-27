import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toProblem, type ApiProblem } from '../api/problem';
import type { Vacation } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { formatHireDate as formatDate } from '../profile/format';
import { latestOnly } from './balance-logic';
import { statusLabel } from './status';

/**
 * Заявки вошедшего: даты, рабочие дни, статус по-русски (RULES §3-11).
 * Порядок как у сервера, новые первыми (DECISIONS 2026-10-26 10:47). Смена reloadKey перечитывает список.
 */
export function MyRequests({ reloadKey }: { reloadKey: number }) {
  const [items, setItems] = useState<Vacation[] | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const take = useMemo(() => latestOnly(), []);

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

  return (
    <section className="panel" aria-label="Мои заявки">
      <h2>Мои заявки</h2>
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
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.id} data-testid="my-request-row">
                <td>{formatDate(v.startDate)}</td>
                <td>{formatDate(v.endDate)}</td>
                <td>{v.workDays}</td>
                <td>{statusLabel(v.status)}</td>
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
